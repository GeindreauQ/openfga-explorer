// Package router assemble les controllers et services en un http.Handler.
// Toute la configuration du routage (méthodes, middlewares, fichiers
// statiques) est centralisée ici.
package router

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/GeindreauQ/openfga-explorer/config"
	"github.com/GeindreauQ/openfga-explorer/controllers"
	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/internal/ratelimit"
)

// loginTemplateData est passé au template HTML de la page /login.
type loginTemplateData struct {
	OIDCEnabled  bool
	LocalEnabled bool
	Username     string
	Error        string
}

// themeHandler sert le thème (type/palette/default) défini dans la
// section `theme:` du YAML config — ou les valeurs built-in (cf.
// config.DefaultTheme) si aucune surcharge.
//
// La route est **non authentifiée** : le thème est de la donnée
// cosmétique, pas sensible. Cache `no-store` côté navigateur pour
// permettre aux mises à jour de prendre effet sans hard-reload.
func themeHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		body, err := cfg.ThemeAsJSON()
		if err != nil {
			http.Error(w, "theme marshal: "+err.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = w.Write(body)
	}
}

// securityHeadersMiddleware ajoute les headers de sécurité sur toutes
// les réponses. Ce middleware s'applique globalement (avant le mux) pour
// garantir qu'aucune réponse ne peut les contourner.
//
// `secureCookies` pilote l'ajout de HSTS : on ne pose le header que
// quand l'opérateur a explicitement demandé SECURE_COOKIES=1, ce qui
// correspond à un déploiement derrière HTTPS. En dev (HTTP), HSTS
// n'aurait aucun sens et bloquerait les futures requêtes en cas
// d'erreur de déploiement.
func securityHeadersMiddleware(secureCookies bool, scriptHashes []string, next http.Handler) http.Handler {
	// CSP stricte : toutes les dépendances tierces (DSL parser, graph
	// engine, icônes) sont vendored dans /vendor/ et servies depuis 'self'.
	// Les scripts inline (l'import map d'index.html) sont autorisés par
	// leur empreinte sha256, pas par 'unsafe-inline'. Aucun style inline :
	// les couleurs dynamiques passent par des classes (lib/type-style.js)
	// ou par le CSSOM (el.style), que style-src n'encadre pas.
	scripts := strings.TrimSpace("'self' " + strings.Join(scriptHashes, " "))
	csp := "default-src 'self'; " +
		"script-src " + scripts + "; " +
		"style-src 'self'; " +
		"font-src 'self' data:; " +
		"img-src 'self' data: blob:; " +
		"connect-src 'self'; " +
		"frame-ancestors 'none'; " +
		"base-uri 'self'; " +
		"form-action 'self'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "0") // désactivé car CSP gère mieux
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if secureCookies {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		w.Header().Set("Content-Security-Policy", csp)
		next.ServeHTTP(w, r)
	})
}

var inlineScript = regexp.MustCompile(`(?s)<script\b([^>]*)>(.*?)</script>`)

// inlineScriptHashes renvoie les sources CSP ('sha256-…') des scripts
// inline des pages HTML données (sans attribut src). Fichier absent : rien.
func inlineScriptHashes(paths ...string) []string {
	var out []string
	for _, p := range paths {
		html, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		for _, m := range inlineScript.FindAllSubmatch(html, -1) {
			if bytes.Contains(m[1], []byte("src=")) || len(m[2]) == 0 {
				continue
			}
			sum := sha256.Sum256(m[2])
			out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
		}
	}
	return out
}

// New construit le router HTTP complet.
//
// `authEnabled` = false ⇒ aucune redirection vers /login (accès
// direct à l'UI, déclenché par `AUTH_DISABLED=1`). `loginLimiter`
// peut être nil : dans ce cas /auth/local n'est pas protégé contre
// les tentatives en force brute (acceptable en dev uniquement).
//
// `broker` doit être non-nil et partagé entre tous les controllers
// qui publient (tuples, dsl) et le handler Stream. Il est créé par
// l'appelant (main.go) pour qu'il puisse être fermé proprement au
// shutdown.
func New(
	cfg config.Config,
	openfga openfgaclient.OpenFGA,
	authenticators *authn.AuthenticatorSet,
	sessions authn.SessionStore,
	loginLimiter *ratelimit.Limiter,
	broker *controllers.EventBroker,
) http.Handler {
	mux := http.NewServeMux()

	health := controllers.NewHealthController(cfg, openfga)
	stores := controllers.NewStoresController(openfga, cfg.Auth.SecureCookies)
	tuples := controllers.NewTuplesController(openfga, broker)
	tuplesIO := controllers.NewImportExportController(tuples, broker)
	auth := controllers.NewAuthController(sessions, authenticators, !cfg.Auth.Disabled, cfg.Auth.SecureCookies, int(cfg.Tuning.SessionTTL.Seconds())).
		WithRoles(authn.RolePolicy{AdminGroups: cfg.Auth.OIDC.AdminGroups, ViewerGroups: cfg.Auth.OIDC.ViewerGroups})
	dslCtrl := controllers.NewDSLController(openfga, broker)
	audit := controllers.NewAuditController(openfga)
	diff := controllers.NewDiffController(openfga)
	lint := controllers.NewLintController()
	assertions := controllers.NewAssertionsController(openfga)

	mux.Handle("GET /api/health", health)
	mux.HandleFunc("GET /api/health/live", health.Live)
	mux.Handle("GET /api/health/detail", auth.Middleware(http.HandlerFunc(health.Detail)))
	mux.HandleFunc("GET /api/config/theme", themeHandler(cfg))
	// authCSRF is `auth.Middleware` followed by `CSRFRequired` — chain
	// for routes that mutate (POST/PUT/PATCH/DELETE). GETs use only auth.
	authCSRF := func(h http.Handler) http.Handler {
		return auth.Middleware(controllers.CSRFRequired(h))
	}
	// authWrite : comme authCSRF, réservé aux rôles qui peuvent écrire.
	authWrite := func(h http.Handler) http.Handler {
		return authCSRF(controllers.RequireWrite(h))
	}

	mux.Handle("GET /api/stores", auth.Middleware(http.HandlerFunc(stores.List)))
	mux.Handle("POST /api/stores/select", authCSRF(http.HandlerFunc(stores.Select)))

	mux.Handle("GET /api/tuples", auth.Middleware(http.HandlerFunc(tuples.List)))
	mux.Handle("POST /api/tuples", authWrite(http.HandlerFunc(tuples.Write)))
	mux.Handle("DELETE /api/tuples", authWrite(http.HandlerFunc(tuples.Delete)))
	mux.Handle("GET /api/export/tuples", auth.Middleware(http.HandlerFunc(tuplesIO.Export)))
	mux.Handle("POST /api/import/tuples", authWrite(http.HandlerFunc(tuplesIO.Import)))
	mux.Handle("POST /api/import/preview", authCSRF(http.HandlerFunc(tuplesIO.Preview)))

	mux.Handle("GET /api/me", http.HandlerFunc(auth.Me))
	mux.Handle("GET /api/dsl", auth.Middleware(http.HandlerFunc(dslCtrl.Get)))
	mux.Handle("POST /api/dsl/parse", auth.Middleware(http.HandlerFunc(dslCtrl.Parse)))
	mux.Handle("POST /api/dsl/apply", authWrite(http.HandlerFunc(dslCtrl.Apply)))
	mux.Handle("POST /api/dsl/lint", auth.Middleware(http.HandlerFunc(lint.Lint)))

	mux.Handle("GET /api/dsl/versions", auth.Middleware(http.HandlerFunc(dslCtrl.ListVersions)))
	mux.Handle("GET /api/dsl/versions/{id}", auth.Middleware(http.HandlerFunc(dslCtrl.GetVersion)))

	mux.Handle("GET /api/assertions", auth.Middleware(http.HandlerFunc(assertions.Get)))
	mux.Handle("POST /api/assertions", authWrite(http.HandlerFunc(assertions.Write)))
	mux.Handle("POST /api/assertions/check", auth.Middleware(http.HandlerFunc(assertions.Check)))

	mux.Handle("POST /api/audit/check", auth.Middleware(http.HandlerFunc(audit.Check)))
	mux.Handle("POST /api/audit/list-objects", auth.Middleware(http.HandlerFunc(audit.ListObjects)))
	mux.Handle("POST /api/audit/list-users", auth.Middleware(http.HandlerFunc(audit.ListUsers)))
	mux.Handle("POST /api/audit/expand", auth.Middleware(http.HandlerFunc(audit.Expand)))
	mux.Handle("POST /api/diff", auth.Middleware(http.HandlerFunc(diff.Diff)))

	// SSE — endpoint temps-réel. Derrière auth.Middleware : le
	// middleware d'auth est un simple passthrough (cookie → vérif →
	// next.ServeHTTP) qui n'enveloppe pas le ResponseWriter, donc il
	// ne casse pas le streaming SSE. Sans cette protection, n'importe
	// qui pouvant joindre :8000 pouvait écouter le bus d'événements
	// (StoreID + ModelID + counts — info sensible pour de l'audit).
	// L'EventSource API envoie automatiquement les cookies de session,
	// donc l'auth reste transparente pour le frontend.
	mux.Handle("GET /api/events", auth.Middleware(http.HandlerFunc(broker.Stream)))

	// ── Auth (redirections OIDC) ────────────────────────────────────────
	mux.HandleFunc("GET /auth/login", auth.Login)
	mux.HandleFunc("GET /auth/callback", auth.Callback)
	trustedProxies := controllers.LoadTrustedProxies()
	if loginLimiter != nil {
		mux.Handle("POST /auth/local",
			controllers.RateLimitMiddleware(loginLimiter, trustedProxies)(http.HandlerFunc(auth.LocalLogin)))
	} else {
		mux.HandleFunc("POST /auth/local", auth.LocalLogin)
	}
	// POST + jeton CSRF : un site tiers ne peut pas déconnecter l'utilisateur.
	mux.Handle("POST /auth/logout", authCSRF(http.HandlerFunc(auth.Logout)))

	// ── View HTML : page de login ───────────────────────────────────────
	viewsDir := os.Getenv("VIEWS_DIR")
	if viewsDir == "" {
		viewsDir = "views"
	}
	loginTpl := template.Must(template.ParseFiles(filepath.Join(viewsDir, "login.html")))
	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		data := loginTemplateData{
			OIDCEnabled:  auth.IsOIDCEnabled(),
			LocalEnabled: auth.IsLocalEnabled(),
			Username:     r.URL.Query().Get("username"),
			Error:        r.URL.Query().Get("error"),
		}
		_ = loginTpl.Execute(w, data)
	})

	// ── Fichiers statiques du frontend ──────────────────────────────────
	staticFS := http.FileServer(http.Dir(cfg.Server.WebDir))
	if !cfg.Auth.Disabled {
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				cookie, err := r.Cookie(sessions.CookieName())
				if err != nil || sessions.Get(cookie.Value) == nil {
					http.Redirect(w, r, "/login", http.StatusFound)
					return
				}
			}
			staticFS.ServeHTTP(w, r)
		})
	} else {
		mux.Handle("/", staticFS)
	}

	// ── Security headers middleware ──────────────────────────────────
	// Applique des headers de sécurité (CSP, X-Content-Type-Options,
	// X-Frame-Options, et HSTS si secureCookies) sur TOUTES les réponses.
	var handler http.Handler = mux
	handler = securityHeadersMiddleware(cfg.Auth.SecureCookies,
		inlineScriptHashes(filepath.Join(cfg.Server.WebDir, "index.html"), filepath.Join(viewsDir, "login.html")), handler)

	return handler
}
