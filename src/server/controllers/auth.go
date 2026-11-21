// AuthController gère les endpoints /auth/* et /api/me. Il délègue
// toute la logique d'auth à un set d'Authenticator (interface
// internal/authn). Aujourd'hui : LocalAuthenticator + OIDCAuthenticator.
//
// Le mode "auth disabled" est géré par `enabled=false` au niveau du
// contrôleur : dans ce cas /api/me renvoie un user anonyme et le
// middleware laisse passer toutes les requêtes.
package controllers

import (
	"net/http"
	"net/url"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// AuthController regroupe la mécanique d'auth : routage vers les
// authenticators actifs, middleware de session, endpoint /api/me.
type AuthController struct {
	sessions       authn.SessionStore
	authenticators *authn.AuthenticatorSet
	enabled        bool
	secureCookies  bool
	sessionTTL     int // secondes pour le MaxAge du cookie
	roles          authn.RolePolicy
}

// WithRoles fixe la politique de rôles appliquée aux utilisateurs OIDC.
func (a *AuthController) WithRoles(p authn.RolePolicy) *AuthController {
	a.roles = p
	return a
}

// NewAuthController crée le contrôleur.
func NewAuthController(
	sessions authn.SessionStore,
	authenticators *authn.AuthenticatorSet,
	enabled bool,
	secureCookies bool,
	sessionTTL int,
) *AuthController {
	return &AuthController{
		sessions:       sessions,
		authenticators: authenticators,
		enabled:        enabled,
		secureCookies:  secureCookies,
		sessionTTL:     sessionTTL,
	}
}

// IsOIDCEnabled indique si le flow OIDC est actif.
func (a *AuthController) IsOIDCEnabled() bool {
	return a.authenticators != nil && a.authenticators.Has("oidc")
}

// IsLocalEnabled indique si le login local (username/password) est actif.
func (a *AuthController) IsLocalEnabled() bool {
	return a.authenticators != nil && a.authenticators.Has("local")
}

// Login route /auth/login vers l'authenticator OIDC (s'il est actif) ou
// redirige vers /. Les méthodes sans redirect (local) sont no-op : le
// form HTML est rendu directement par /login.
func (a *AuthController) Login(w http.ResponseWriter, r *http.Request) {
	oidcAuth := a.authenticators.ByName("oidc")
	if oidcAuth == nil {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if err := oidcAuth.Login(w, r); err != nil {
		ae := apperr.From(err)
		if ae == nil {
			ae = apperr.New(http.StatusInternalServerError, err.Error())
		}
		http.Error(w, ae.Message, ae.Status)
	}
}

// Callback reçoit la réponse OIDC, délègue à l'authenticator puis
// établit la session.
func (a *AuthController) Callback(w http.ResponseWriter, r *http.Request) {
	oidcAuth := a.authenticators.ByName("oidc")
	if oidcAuth == nil {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	user, ae := oidcAuth.Callback(r.Context(), r)
	if ae != nil {
		http.Error(w, ae.Message, ae.Status)
		return
	}
	authn.ClearStateCookie(r.Context(), r, w)
	if ae := a.roles.Assign(user); ae != nil {
		http.Error(w, ae.Message, ae.Status)
		return
	}
	a.establishSession(w, user)
	http.Redirect(w, r, "/", http.StatusFound)
}

// LocalLogin traite POST /auth/local : vérifie username/password via
// l'authenticator local et établit la session.
func (a *AuthController) LocalLogin(w http.ResponseWriter, r *http.Request) {
	localAuth := a.authenticators.ByName("local")
	if localAuth == nil {
		http.Error(w, "local auth not available", http.StatusServiceUnavailable)
		return
	}
	user, ae := localAuth.Callback(r.Context(), r)
	if ae != nil {
		// Message générique pour ne pas révéler si l'utilisateur existe.
		msg := "Identifiants invalides"
		if ae.Status != http.StatusUnauthorized {
			msg = url.QueryEscape(ae.Message)
		} else {
			msg = url.QueryEscape(msg)
		}
		http.Redirect(w, r, "/login?error="+msg, http.StatusFound)
		return
	}
	a.establishSession(w, user)
	http.Redirect(w, r, "/", http.StatusFound)
}

// Logout supprime la session et son cookie (POST protégé par CSRF ; le
// frontend renvoie ensuite vers la page de connexion).
func (a *AuthController) Logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(a.sessions.CookieName())
	if err == nil {
		a.sessions.Delete(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     a.sessions.CookieName(),
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.secureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

// Me renvoie l'utilisateur authentifié courant et le CSRF token lié à
// la session. Le frontend cache ce token pour l'attacher en header
// X-CSRF-Token sur les requêtes mutatrices (cf. CSRFRequired).
//
// Route publique (pas d'auth.Middleware) : en l'absence de cookie, la
// réponse renvoie `{authenticated: false}` sans toucher au store de
// sessions.
func (a *AuthController) Me(w http.ResponseWriter, r *http.Request) {
	if !a.enabled {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false, "user": nil})
		return
	}
	cookie, err := r.Cookie(a.sessions.CookieName())
	if err != nil || cookie.Value == "" {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false, "user": nil})
		return
	}
	sess := a.sessions.Get(cookie.Value)
	if sess == nil {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false, "user": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"user":          sess.User,
		"csrf_token":    sess.CSRFToken,
		"store_id":      sess.StoreID,
	})
}

// Middleware bloque l'accès aux endpoints protégés si l'auth est activée
// et que l'utilisateur n'est pas authentifié.
//
// Effet de bord : la *Session validée est posée dans r.Context() via
// authn.WithSession. Les controllers en aval la lisent avec
// authn.SessionFromContext. En mode AUTH_DISABLED=1, aucune session
// n'est posée (les controllers tombent sur le client.OpenFGA global).
func (a *AuthController) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.enabled {
			next.ServeHTTP(w, r)
			return
		}
		cookie, err := r.Cookie(a.sessions.CookieName())
		if err != nil || cookie.Value == "" {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		sess := a.sessions.Get(cookie.Value)
		if sess == nil {
			http.Error(w, "session expired", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(authn.WithSession(r.Context(), sess)))
	})
}

// RequireWrite refuse (403) les requêtes d'un utilisateur en lecture
// seule. À placer après Middleware, qui pose la session dans le contexte.
// Sans session (auth désactivée), la requête passe.
func RequireWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sess := authn.SessionFromContext(r.Context()); sess != nil && !sess.User.CanWrite() {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "lecture seule : action réservée aux administrateurs"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// establishSession crée une session et pose le cookie signé.
func (a *AuthController) establishSession(w http.ResponseWriter, user *models.User) {
	_, cookieVal, err := a.sessions.Create(user)
	if err != nil {
		http.Error(w, "session create: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     a.sessions.CookieName(),
		Value:    cookieVal,
		Path:     "/",
		HttpOnly: true,
		Secure:   a.secureCookies,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   a.sessionTTL,
	})
}
