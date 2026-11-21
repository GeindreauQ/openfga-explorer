// OIDCAuthenticator implémente Authenticator pour le flow Authorization
// Code d'OpenID Connect.
//
// Responsabilités :
//   - discovery du provider OIDC
//   - génération d'un state anti-CSRF (cookie + URL)
//   - échange du code en ID token vérifié (JWKS)
//   - extraction des claims utilisateur
package authn

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// OIDCConfig regroupe les paramètres de connexion au provider OIDC.
// Tous les champs sont obligatoires : c'est l'appelant (main.go) qui
// décide d'instancier ou non un OIDCAuthenticator.
type OIDCConfig struct {
	IssuerURL     string
	ClientID      string
	ClientSecret  string
	RedirectURL   string
	Scopes        []string
	SecureCookies bool // calque le flag SECURE_COOKIES pour le state cookie OIDC
}

// OIDCAuthenticator encapsule le flow OIDC : discovery, génération
// de l'URL d'autorisation, échange du code, extraction des claims.
type OIDCAuthenticator struct {
	cfg      OIDCConfig
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config
}

// NewOIDCAuthenticator effectue la discovery OIDC et prépare l'auth flow.
// Échoue si le provider est injoignable.
func NewOIDCAuthenticator(ctx context.Context, cfg OIDCConfig) (*OIDCAuthenticator, error) {
	if cfg.IssuerURL == "" || cfg.ClientID == "" || cfg.RedirectURL == "" {
		return nil, errors.New("OIDC non configuré (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URL requis)")
	}
	if err := rejectInsecureIssuer(cfg.IssuerURL); err != nil {
		return nil, err
	}
	provider, err := oidc.NewProvider(ctx, cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery: %w", err)
	}
	oauth := &oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		RedirectURL:  cfg.RedirectURL,
		Scopes:       cfg.Scopes,
		Endpoint:     provider.Endpoint(),
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})
	return &OIDCAuthenticator{cfg: cfg, provider: provider, verifier: verifier, oauth: oauth}, nil
}

// Name retourne "oidc".
func (a *OIDCAuthenticator) Name() string { return "oidc" }

// Enabled : l'auth OIDC est active si l'authenticator a été instancié.
func (a *OIDCAuthenticator) Enabled() bool { return a != nil && a.provider != nil }

// Login génère un state anti-CSRF, le stocke dans un cookie, et redirige
// vers le provider OIDC.
func (a *OIDCAuthenticator) Login(w http.ResponseWriter, r *http.Request) error {
	state, err := GenerateState()
	if err != nil {
		return apperr.Wrap(http.StatusInternalServerError, err)
	}
	SetStateCookie(w, state, a.cfg.SecureCookies)
	http.Redirect(w, r, a.oauth.AuthCodeURL(state, oauth2.AccessTypeOnline), http.StatusFound)
	return nil
}

// Callback vérifie le state, échange le code contre un ID token, et
// renvoie le *models.User peuplé.
func (a *OIDCAuthenticator) Callback(ctx context.Context, r *http.Request) (*models.User, *apperr.Error) {
	// 1. Vérification du state (anti-CSRF) via le cookie posé par Login.
	stateCookie, err := r.Cookie("openfga_explorer_oidc_state")
	if err != nil || stateCookie.Value == "" {
		return nil, apperr.New(http.StatusBadRequest, "state cookie missing")
	}
	queryState := r.URL.Query().Get("state")
	if queryState == "" || queryState != stateCookie.Value {
		return nil, apperr.New(http.StatusBadRequest, "state mismatch")
	}
	// Le state est validé : le caller (controller auth) effacera le
	// cookie via ClearStateCookie(ctx, r, w) une fois la session établie.

	// 2. Échange du code contre un ID token vérifié.
	code := r.URL.Query().Get("code")
	if code == "" {
		return nil, apperr.New(http.StatusBadRequest, "code manquant")
	}
	tok, err := a.oauth.Exchange(ctx, code)
	if err != nil {
		return nil, apperr.Wrap(http.StatusBadRequest, fmt.Errorf("OIDC exchange: %w", err))
	}
	rawIDToken, ok := tok.Extra("id_token").(string)
	if !ok {
		return nil, apperr.New(http.StatusBadRequest, "id_token manquant dans la réponse du provider")
	}
	idToken, err := a.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, apperr.Wrap(http.StatusBadRequest, fmt.Errorf("verify id_token: %w", err))
	}
	var claims struct {
		Sub               string   `json:"sub"`
		Email             string   `json:"email"`
		EmailVerified     bool     `json:"email_verified"`
		Name              string   `json:"name"`
		PreferredUsername string   `json:"preferred_username"`
		Roles             []string `json:"roles"`
		Groups            []string `json:"groups"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return nil, apperr.Wrap(http.StatusBadRequest, fmt.Errorf("claims: %w", err))
	}
	return &models.User{
		Subject:       claims.Sub,
		Email:         claims.Email,
		EmailVerified: claims.EmailVerified,
		Name:          claims.Name,
		PreferredName: claims.PreferredUsername,
		Roles:         claims.Roles,
		Groups:        claims.Groups,
		Source:        "oidc",
	}, nil
}

// ── State cookie helpers ───────────────────────────────────────────────────

// GenerateState génère un state aléatoire anti-CSRF.
func GenerateState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SetStateCookie écrit le state dans un cookie courte-durée (5 min).
// `secure` doit être true en production (HTTPS) pour éviter les fuites
// du state anti-CSRF sur des connexions non chiffrées.
func SetStateCookie(w http.ResponseWriter, state string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     "openfga_explorer_oidc_state",
		Value:    state,
		Path:     "/auth/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   300,
	})
}

// ReadStateCookie lit et supprime le state du cookie.
func ReadStateCookie(r *http.Request) (string, error) {
	c, err := r.Cookie("openfga_explorer_oidc_state")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(c.Value) == "" {
		return "", errors.New("state vide")
	}
	return c.Value, nil
}

// ClearStateCookie efface le cookie de state.
func ClearStateCookie(_ context.Context, _ *http.Request, w http.ResponseWriter) {
	if w == nil {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "openfga_explorer_oidc_state",
		Value:    "",
		Path:     "/auth/",
		HttpOnly: true,
		MaxAge:   -1,
	})
}

// rejectInsecureIssuer refuse les IssuerURL pointant vers des IP
// privées/réservées (SSRF). Les hostnames sont acceptés. Override
// via OIDC_ALLOW_INSECURE_URL=1 pour les déploiements internes.
func rejectInsecureIssuer(issuerURL string) error {
	if os.Getenv("OIDC_ALLOW_INSECURE_URL") == "1" {
		return nil
	}
	u, err := url.Parse(issuerURL)
	if err != nil {
		return fmt.Errorf("OIDC issuer URL invalide: %w", err)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("OIDC issuer URL sans host")
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// Hostname : pas de DNS lookup (lenteur, ambiguïté).
		return nil
	}
	for _, cidr := range []string{
		"127.0.0.0/8", "::1/128", // loopback
		"10.0.0.0/8", "172.16.0.0/12", // RFC 1918
		"192.168.0.0/16", // RFC 1918
		"169.254.0.0/16", // link-local (cloud metadata)
		"0.0.0.0/8",      // unspecified
	} {
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if n.Contains(ip) {
			return fmt.Errorf("OIDC issuer %q pointe vers une IP privée/réservée (SSRF bloqué ; override via OIDC_ALLOW_INSECURE_URL=1)", host)
		}
	}
	return nil
}
