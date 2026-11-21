// Package main wire tous les composants : config → services → controllers
// → router. C'est le seul endroit qui connaît l'ordre d'initialisation
// et les relations entre les briques.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/GeindreauQ/openfga-explorer/config"
	"github.com/GeindreauQ/openfga-explorer/controllers"
	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/internal/ratelimit"
	"github.com/GeindreauQ/openfga-explorer/router"
)

// shutdownTimeout borne le temps alloué au Shutdown du serveur HTTP
// (drain des connexions en cours + fermeture des SSE). Au-delà, on
// quitte en force.
const shutdownTimeout = 10 * time.Second

func main() {
	// Flag --config=<path> : chemin vers un YAML de tuning/thème.
	// Optionnel : sans flag, la config vient exclusivement des variables
	// d'environnement et des défauts in-code.
	configPath := flag.String("config", "", "path vers un fichier YAML de tuning/thème (optionnel)")
	flag.Parse()

	cfg := config.Load(*configPath)
	if err := cfg.Validate(); err != nil {
		log.Fatalf("config: %v", err)
	}

	// ── OpenFGA ──────────────────────────────────────────────────────────
	var openfga openfgaclient.OpenFGA
	if cfg.ConfiguredOpenFGA() {
		var oauth *openfgaclient.ClientCredentials
		if o := cfg.OpenFGA.OAuth; o.TokenURL != "" {
			oauth = &openfgaclient.ClientCredentials{
				TokenURL: o.TokenURL, ClientID: o.ClientID, ClientSecret: o.ClientSecret,
				Username: o.Username, Password: o.Password, Scope: o.Scope,
			}
			log.Printf("OpenFGA: jetons client_credentials (%s, client=%s)", o.TokenURL, o.ClientID)
		}
		client, err := openfgaclient.New(cfg.OpenFGA.URL, cfg.OpenFGA.Token, oauth)
		if err != nil {
			log.Fatalf("OpenFGA init: %v", err)
		}
		openfga = client

		bootstrapStore(openfga, cfg.Tuning.BootstrapTimeout)
	} else {
		log.Printf("OpenFGA: non configuré (OPENFGA_URL manquant)")
	}

	// ── Auth ──────────────────────────────────────────────────────────────
	sessions := authn.NewMemorySessionStore(
		cfg.Auth.SessionSecret,
		cfg.Tuning.SessionTTL,
		cfg.Tuning.SessionCookieName,
		cfg.Tuning.SessionTokenBytes,
	)
	sessions.StartGC(cfg.Tuning.SessionGCInterval)

	// Local user store : toujours présent pour le login local d'urgence
	// (break-glass). On y seed l'admin par défaut si absent.
	localUsers := authn.NewMemoryUserStore()
	if _, _, seeded, err := authn.SeedDefaultAdmin(localUsers, cfg.Auth.AdminPassword); err != nil {
		log.Fatalf("seed default admin: %v", err)
	} else if seeded {
		log.Printf("auth: compte admin par défaut créé (voir bloc 'SECURITY' ci-dessus)")
	}

	authenticators := buildAuthenticators(cfg)
	if cfg.Auth.LocalDisabled && authenticators.Has("oidc") {
		log.Printf("auth: login local désactivé (LOCAL_LOGIN_DISABLED=1)")
	} else {
		authenticators = mergeLocalAuth(authenticators, localUsers)
	}

	// Rate limiter
	loginLimiter := ratelimit.New(cfg.Auth.RateLimitRPM, cfg.Tuning.RateLimitIdleTTL)
	log.Printf("auth: rate limit sur /auth/local = %d req/min/IP (idle_ttl=%s)", cfg.Auth.RateLimitRPM, cfg.Tuning.RateLimitIdleTTL)

	logAuthMode(cfg, authenticators)

	// Broker SSE — créé ici (pas dans router.New) pour qu'on puisse
	// le fermer proprement au shutdown et éviter les goroutines orphelines.
	broker := controllers.NewEventBroker(cfg.Tuning.SSEMaxSubscribers, cfg.Tuning.SSEChannelBuffer)

	// ── Router + HTTP server ───────────────────────────────────────────
	handler := router.New(cfg, openfga, authenticators, sessions, loginLimiter, broker)

	srv := &http.Server{
		Addr:    cfg.Server.Addr,
		Handler: handler,
		// ReadHeaderTimeout court pour éviter l'attaque Slowloris. Les
		// handlers n'ont pas besoin de headers lents.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Contexte parent annulé sur SIGINT/SIGTERM. Permet aux handlers
	// longs (SSE) de s'arrêter proprement et au serveur HTTP de drainer.
	rootCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Cleanup des ressources en sortie (ordre inverse de création).
	defer func() {
		loginLimiter.Stop() // arrête la goroutine GC
		broker.Close()      // ferme les abonnés SSE
	}()

	log.Printf("Frontend: %s | Écoute: %s", cfg.Server.WebDir, cfg.Server.Addr)

	// Lance le serveur dans une goroutine : on doit garder le main
	// bloqué sur le wait du signal pour pouvoir appeler Shutdown.
	serverErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
			return
		}
		serverErr <- nil
	}()

	select {
	case err := <-serverErr:
		if err != nil {
			log.Fatalf("serveur arrêté: %v", err)
		}
	case <-rootCtx.Done():
		log.Printf("signal reçu, arrêt en cours…")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		} else {
			log.Printf("shutdown propre OK")
		}
	}
	_ = os.Stderr.Sync()
}

// bootstrapStore sélectionne le premier store disponible au démarrage.
// La sélection est modifiable à chaud depuis l'UI via /api/stores/select.
func bootstrapStore(openfga openfgaclient.OpenFGA, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	stores, err := openfga.ListStores(ctx)
	if err == nil && len(stores) > 0 {
		openfga.SetDefaultStoreID(stores[0].ID)
		log.Printf("bootstrap: %d store(s) disponible(s), %q sélectionné par défaut",
			len(stores), stores[0].Name)
	} else {
		log.Printf("bootstrap: aucun store, sélectionnez-en un via l'UI")
	}
}

// buildAuthenticators instancie les authenticators en fonction de la
// config. L'OIDC n'est ajouté que si la config est complète.
func buildAuthenticators(cfg config.Config) *authn.AuthenticatorSet {
	var list []authn.Authenticator
	if cfg.ConfiguredOIDC() {
		ctx, cancel := context.WithTimeout(context.Background(), cfg.Tuning.OIDCInitTimeout)
		defer cancel()
		oidc, err := authn.NewOIDCAuthenticator(ctx, authn.OIDCConfig{
			IssuerURL:     cfg.Auth.OIDC.IssuerURL,
			ClientID:      cfg.Auth.OIDC.ClientID,
			ClientSecret:  cfg.Auth.OIDC.ClientSecret,
			RedirectURL:   cfg.Auth.OIDC.RedirectURL,
			Scopes:        cfg.Auth.OIDC.Scopes,
			SecureCookies: cfg.Auth.SecureCookies,
		})
		if err != nil {
			log.Fatalf("OIDC init: %v", err)
		}
		list = append(list, oidc)
		log.Printf("OIDC: %s (client=%s)", cfg.Auth.OIDC.IssuerURL, cfg.Auth.OIDC.ClientID)
	} else {
		log.Printf("OIDC: non configuré, login local (admin) sera utilisé")
	}
	return authn.NewAuthenticatorSet(list...)
}

// mergeLocalAuth ajoute l'authenticator local au set s'il n'est pas déjà
// présent. Le store d'utilisateurs est partagé (un seul seed d'admin).
func mergeLocalAuth(set *authn.AuthenticatorSet, users authn.UserStore) *authn.AuthenticatorSet {
	if set.Has("local") {
		return set
	}
	list := set.All()
	list = append(list, authn.NewLocalAuthenticator(users))
	return authn.NewAuthenticatorSet(list...)
}

func logAuthMode(cfg config.Config, set *authn.AuthenticatorSet) {
	if cfg.Auth.Disabled {
		log.Printf("auth: DÉSACTIVÉE (AUTH_DISABLED=1) — accès direct à l'UI")
		return
	}
	switch {
	case set.Has("oidc") && set.Has("local"):
		log.Printf("auth: mode OIDC actif, login local (admin) également disponible")
	case set.Has("oidc"):
		log.Printf("auth: mode OIDC uniquement")
	default:
		log.Printf("auth: mode local uniquement (admin par défaut)")
	}
}
