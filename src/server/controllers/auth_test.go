package controllers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// TestEstablishSession_UsesConfiguredTTL vérifie que le cookie de
// session posé par establishSession utilise bien la TTL configurée
// (et non la valeur hardcodée d'origine).
func TestEstablishSession_UsesConfiguredTTL(t *testing.T) {
	sessions := authn.NewMemorySessionStore(
		"test-secret-32-chars-minimum-padding",
		0, "", 32,
	)
	a := NewAuthController(
		sessions,
		authn.NewAuthenticatorSet(),
		true,
		false, // secureCookies
		3600,  // sessionTTL = 1h
	)

	user := &models.User{Subject: "u1", Email: "u1@test.local", Roles: []string{"admin"}}
	rr := httptest.NewRecorder()
	a.establishSession(rr, user)

	cookies := rr.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("establishSession should set a session cookie")
	}
	c := cookies[0]
	if c.MaxAge != 3600 {
		t.Errorf("MaxAge = %d, want 3600 (sessionTTL)", c.MaxAge)
	}
	if !c.HttpOnly {
		t.Error("session cookie should be HttpOnly")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite = %v, want Lax", c.SameSite)
	}
}

// TestEstablishSession_SecureFlagPropagated vérifie que le flag
// Secure du cookie de session suit la config secureCookies.
func TestEstablishSession_SecureFlagPropagated(t *testing.T) {
	sessions := authn.NewMemorySessionStore(
		"test-secret-32-chars-minimum-padding",
		0, "", 32,
	)
	a := NewAuthController(
		sessions,
		authn.NewAuthenticatorSet(),
		true,
		true, // secureCookies = true (HTTPS en prod)
		7200,
	)

	rr := httptest.NewRecorder()
	a.establishSession(rr, &models.User{Subject: "u1"})

	cookies := rr.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("no cookie set")
	}
	if !cookies[0].Secure {
		t.Error("Secure should be true when secureCookies=true")
	}
}

// TestLogout_SecureCookie vérifie que le cookie de suppression posé
// par Logout() porte Secure + SameSite, conformément aux autres
// cookies de session (cohérence défensive : si le serveur est
// derrière HTTPS, le browser ne supprime pas un cookie Secure posé
// depuis un contexte non-Secure).
func TestLogout_SecureCookie(t *testing.T) {
	sessions := authn.NewMemorySessionStore(
		"test-secret-32-chars-minimum-padding",
		0, "", 32,
	)
	a := NewAuthController(
		sessions,
		authn.NewAuthenticatorSet(),
		true,
		true, // secureCookies = true
		3600,
	)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	a.Logout(rr, req)

	cookies := rr.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("Logout should set a deletion cookie")
	}
	c := cookies[0]
	if c.MaxAge != -1 {
		t.Errorf("Logout cookie MaxAge = %d, want -1", c.MaxAge)
	}
	if !c.Secure {
		t.Error("Logout cookie should be Secure when secureCookies=true")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Errorf("Logout cookie SameSite = %v, want Lax", c.SameSite)
	}
	if !c.HttpOnly {
		t.Error("Logout cookie should be HttpOnly")
	}
}

// TestLogout_NoCookie_NoOp vérifie que Logout() ne plante pas quand
// aucun cookie de session n'est présent (premier appel depuis un
// navigateur vierge, par exemple).
func TestLogout_NoCookie_NoOp(t *testing.T) {
	sessions := authn.NewMemorySessionStore(
		"test-secret-32-chars-minimum-padding",
		0, "", 32,
	)
	a := NewAuthController(
		sessions,
		authn.NewAuthenticatorSet(),
		true,
		false,
		3600,
	)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	a.Logout(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("Logout code = %d, want 204", rr.Code)
	}
	// Au moins le cookie de suppression est posé.
	cookies := rr.Result().Cookies()
	if len(cookies) == 0 {
		t.Error("Logout should still set a deletion cookie even without an existing session")
	}
}

func TestRequireWrite(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	for _, c := range []struct {
		name string
		sess *authn.Session
		want int
	}{
		{"auth désactivée (pas de session)", nil, http.StatusNoContent},
		{"admin", &authn.Session{User: &models.User{Role: models.RoleAdmin}}, http.StatusNoContent},
		{"viewer", &authn.Session{User: &models.User{Role: models.RoleViewer}}, http.StatusForbidden},
	} {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/tuples", nil)
			if c.sess != nil {
				req = req.WithContext(authn.WithSession(req.Context(), c.sess))
			}
			rr := httptest.NewRecorder()
			RequireWrite(ok).ServeHTTP(rr, req)
			if rr.Code != c.want {
				t.Fatalf("status = %d, attendu %d", rr.Code, c.want)
			}
		})
	}
}
