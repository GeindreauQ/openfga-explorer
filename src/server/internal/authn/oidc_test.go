// internal/authn/oidc_test.go — Tests unitaires de l'OIDCAuthenticator.
//
// Stratégie :
//   - Fonctions pures (GenerateState, cookies, config validation) : testées
//     directement, couvrent les chemins d'erreur fréquents.
//   - Callback (échange code → token + extraction des claims) : on monte
//     un faux provider OIDC avec httptest.NewServer + JWKS RSA signé,
//     puis on signe un JWT réel (manuellement, sans dépendance externe)
//     qu'on renvoie depuis /token. Permet de valider le bout-en-bout
//     sans dépendance réseau externe.
//
// Les tests sont volontairement indépendants de tout state global : ils
// construisent leur propre authenticator à partir d'un URL httptest.

package authn

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// signJWT signe un JWT avec RS256 en utilisant uniquement la stdlib
// (crypto/rsa + crypto/sha256 + encoding/base64). Pas de dépendance
// externe : on évite d'ajouter golang-jwt/jwt/v5 juste pour les tests.
//
// Variante sans `*testing.T` pour pouvoir être appelée depuis une
// goroutine / closure HTTP (pas de t.Fatalf disponible).
func signJWTForIssuer(priv *rsa.PrivateKey, kid string, claims map[string]any) string {
	header := map[string]any{"alg": "RS256", "kid": kid, "typ": "JWT"}
	headerJSON, _ := json.Marshal(header)
	claimsJSON, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(claimsJSON)
	hashed := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, hashed[:])
	if err != nil {
		// Pas de t.Fatal ici : on retourne la signature partielle et
		// l'appelant verra l'erreur de toute façon (le client ne pourra
		// pas vérifier un id_token vide).
		return signingInput + "."
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// ── Fonctions pures / cookies ────────────────────────────────────────────

func TestOIDC_GenerateState_UniqueAndValid(t *testing.T) {
	s1, err := GenerateState()
	if err != nil {
		t.Fatalf("GenerateState: %v", err)
	}
	s2, err := GenerateState()
	if err != nil {
		t.Fatalf("GenerateState: %v", err)
	}
	if s1 == "" || s2 == "" {
		t.Fatal("GenerateState returned empty")
	}
	if s1 == s2 {
		t.Errorf("two consecutive states should differ (got %q twice)", s1)
	}
	// Doit être un base64 raw-URL → caractères alphanum + - + _.
	for _, r := range s1 {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_') {
			t.Errorf("state contains invalid char %q in %q", r, s1)
			break
		}
	}
}

func TestOIDC_SetAndReadStateCookie(t *testing.T) {
	rr := httptest.NewRecorder()
	SetStateCookie(rr, "abc-state-123", false) // secure=false en test http

	// Vérifie que le Set-Cookie est bien posé.
	cookies := rr.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(cookies))
	}
	c := cookies[0]
	if c.Name != "openfga_explorer_oidc_state" {
		t.Errorf("cookie name: got %q", c.Name)
	}
	if c.Value != "abc-state-123" {
		t.Errorf("cookie value: got %q", c.Value)
	}
	if c.MaxAge != 300 {
		t.Errorf("MaxAge: got %d, want 300 (5 min)", c.MaxAge)
	}
	if !c.HttpOnly {
		t.Error("cookie should be HttpOnly")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite: got %v, want Lax", c.SameSite)
	}
	if c.Path != "/auth/" {
		t.Errorf("Path: got %q, want /auth/", c.Path)
	}

	// Round-trip : on injecte le cookie dans une requête et on lit.
	req := httptest.NewRequest("GET", "/auth/callback", nil)
	req.AddCookie(c)
	got, err := ReadStateCookie(req)
	if err != nil {
		t.Fatalf("ReadStateCookie: %v", err)
	}
	if got != "abc-state-123" {
		t.Errorf("read back: got %q, want abc-state-123", got)
	}
}

func TestOIDC_ReadStateCookie_Missing(t *testing.T) {
	req := httptest.NewRequest("GET", "/auth/callback", nil)
	if _, err := ReadStateCookie(req); err == nil {
		t.Error("ReadStateCookie should fail without cookie")
	}
}

func TestOIDC_ReadStateCookie_EmptyValue(t *testing.T) {
	req := httptest.NewRequest("GET", "/auth/callback", nil)
	req.AddCookie(&http.Cookie{Name: "openfga_explorer_oidc_state", Value: "   "})
	if _, err := ReadStateCookie(req); err == nil {
		t.Error("ReadStateCookie should fail on whitespace value")
	}
}

func TestOIDC_ClearStateCookie_NilWriterIsNoop(t *testing.T) {
	// Comportement documenté : ClearStateCookie avec writer nil ne panic
	// pas (utilisé depuis Callback où le clear est délégué).
	ClearStateCookie(context.Background(), httptest.NewRequest("GET", "/", nil), nil)
}

func TestOIDC_ClearStateCookie_WritesExpired(t *testing.T) {
	rr := httptest.NewRecorder()
	ClearStateCookie(context.Background(), httptest.NewRequest("GET", "/", nil), rr)
	cookies := rr.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(cookies))
	}
	c := cookies[0]
	if c.Value != "" {
		t.Errorf("cleared cookie value: got %q, want empty", c.Value)
	}
	if c.MaxAge != -1 {
		t.Errorf("cleared MaxAge: got %d, want -1 (delete)", c.MaxAge)
	}
}

// ── Validation de la config ─────────────────────────────────────────────

func TestOIDC_NewOIDCAuthenticator_MissingIssuerURL(t *testing.T) {
	_, err := NewOIDCAuthenticator(context.Background(), OIDCConfig{
		ClientID:    "cid",
		RedirectURL: "http://localhost/cb",
	})
	if err == nil {
		t.Error("NewOIDCAuthenticator with missing IssuerURL should fail")
	}
	if !strings.Contains(err.Error(), "OIDC_ISSUER_URL") {
		t.Errorf("error should mention required env var, got %q", err.Error())
	}
}

func TestOIDC_NewOIDCAuthenticator_MissingClientID(t *testing.T) {
	_, err := NewOIDCAuthenticator(context.Background(), OIDCConfig{
		IssuerURL:   "http://localhost",
		RedirectURL: "http://localhost/cb",
	})
	if err == nil {
		t.Error("NewOIDCAuthenticator with missing ClientID should fail")
	}
}

func TestOIDC_NewOIDCAuthenticator_MissingRedirectURL(t *testing.T) {
	_, err := NewOIDCAuthenticator(context.Background(), OIDCConfig{
		IssuerURL: "http://localhost",
		ClientID:  "cid",
	})
	if err == nil {
		t.Error("NewOIDCAuthenticator with missing RedirectURL should fail")
	}
}

func TestOIDC_NewOIDCAuthenticator_UnreachableIssuer(t *testing.T) {
	// Issuer joignable mais qui ne répond pas à /.well-known/openid-configuration
	// → la discovery doit échouer proprement.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	// httptest.NewServer bind sur 127.0.0.1 — on bypasse le SSRF guard.
	t.Setenv("OIDC_ALLOW_INSECURE_URL", "1")

	_, err := NewOIDCAuthenticator(context.Background(), OIDCConfig{
		IssuerURL:   srv.URL,
		ClientID:    "cid",
		RedirectURL: srv.URL + "/cb",
	})
	if err == nil {
		t.Error("NewOIDCAuthenticator should fail on missing discovery doc")
	}
	if !strings.Contains(err.Error(), "discovery") {
		t.Errorf("error should mention discovery, got %q", err.Error())
	}
}

// ── Callbacks : chemins d'erreur fréquents (sans provider complet) ──────

// fakeAuthenticatorMinimal construit un OIDCAuthenticator juste assez
// pour tester Callback (sans oauth.Exchange / verifier.Verify). On
// instancie via le constructeur réel avec un mock provider qui répond
// à /.well-known/openid-configuration mais sans JWKS fonctionnel — les
// tests ci-dessous restent en amont de l'appel réseau.
//
// Note : on utilise oidc.InsecureIssuerURLContext pour tolérer la
// différence entre l'URL http du test server et l'issuer déclaré
// dans le discovery doc (qui omet le scheme).
func fakeAuthenticatorMinimal(t *testing.T) *OIDCAuthenticator {
	t.Helper()
	srv := newFakeOIDCProvider(t)
	t.Cleanup(srv.Close)
	t.Setenv("OIDC_ALLOW_INSECURE_URL", "1") // httptest server = 127.0.0.1
	ctx, cancel := context.WithTimeout(oidc.InsecureIssuerURLContext(context.Background(), srv.URL), 2*time.Second)
	defer cancel()
	auth, err := NewOIDCAuthenticator(ctx, OIDCConfig{
		IssuerURL:   srv.URL,
		ClientID:    "test-client",
		RedirectURL: srv.URL + "/auth/callback",
		Scopes:      []string{"openid", "profile", "email"},
	})
	if err != nil {
		t.Fatalf("NewOIDCAuthenticator: %v", err)
	}
	return auth
}

func TestOIDC_Name(t *testing.T) {
	a := fakeAuthenticatorMinimal(t)
	if a.Name() != "oidc" {
		t.Errorf("Name: got %q, want oidc", a.Name())
	}
}

func TestOIDC_Enabled(t *testing.T) {
	a := fakeAuthenticatorMinimal(t)
	if !a.Enabled() {
		t.Error("Enabled should be true after construction")
	}
	// Un authenticator nil doit être traité comme non-enabled.
	var nilAuth *OIDCAuthenticator
	if nilAuth.Enabled() {
		t.Error("nil authenticator should not be enabled")
	}
}

func TestOIDC_Callback_MissingStateCookie(t *testing.T) {
	a := fakeAuthenticatorMinimal(t)
	req := httptest.NewRequest("GET", "/auth/callback?state=foo&code=bar", nil)
	_, appErr := a.Callback(context.Background(), req)
	if appErr == nil {
		t.Fatal("Callback should fail when state cookie missing")
	}
	if appErr.Status != 400 {
		t.Errorf("status: got %d, want 400", appErr.Status)
	}
	if !strings.Contains(appErr.Message, "state") {
		t.Errorf("message should mention state, got %q", appErr.Message)
	}
}

func TestOIDC_Callback_StateMismatch(t *testing.T) {
	a := fakeAuthenticatorMinimal(t)
	req := httptest.NewRequest("GET", "/auth/callback?state=query-state&code=bar", nil)
	req.AddCookie(&http.Cookie{
		Name:  "openfga_explorer_oidc_state",
		Value: "cookie-state",
	})
	_, appErr := a.Callback(context.Background(), req)
	if appErr == nil {
		t.Fatal("Callback should fail on state mismatch")
	}
	if !strings.Contains(appErr.Message, "mismatch") {
		t.Errorf("message should mention mismatch, got %q", appErr.Message)
	}
}

func TestOIDC_Callback_MissingCode(t *testing.T) {
	a := fakeAuthenticatorMinimal(t)
	req := httptest.NewRequest("GET", "/auth/callback?state=ok", nil)
	req.AddCookie(&http.Cookie{
		Name:  "openfga_explorer_oidc_state",
		Value: "ok",
	})
	_, appErr := a.Callback(context.Background(), req)
	if appErr == nil {
		t.Fatal("Callback should fail when code missing")
	}
	if appErr.Status != 400 {
		t.Errorf("status: got %d, want 400", appErr.Status)
	}
	if !strings.Contains(appErr.Message, "code") {
		t.Errorf("message should mention code, got %q", appErr.Message)
	}
}

func TestOIDC_Login_Redirects(t *testing.T) {
	a := fakeAuthenticatorMinimal(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/auth/login", nil)
	if err := a.Login(rr, req); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if rr.Code != http.StatusFound {
		t.Errorf("status: got %d, want 302", rr.Code)
	}
	loc := rr.Header().Get("Location")
	if !strings.Contains(loc, "client_id=test-client") {
		t.Errorf("Location should carry client_id, got %q", loc)
	}
	if !strings.Contains(loc, "state=") {
		t.Errorf("Location should carry state, got %q", loc)
	}
	if !strings.Contains(loc, "redirect_uri=") {
		t.Errorf("Location should carry redirect_uri, got %q", loc)
	}
	// Le state cookie doit être posé.
	cookies := rr.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "openfga_explorer_oidc_state" {
			found = true
			if c.Value == "" {
				t.Error("state cookie value should be non-empty")
			}
		}
	}
	if !found {
		t.Error("state cookie should be set by Login")
	}
}

// ── Mock provider OIDC (discovery + JWKS + token endpoint) ───────────────

// newFakeOIDCProvider monte un faux provider OIDC avec RSA key + JWKS
// + endpoint /token qui renvoie un id_token signé. Le contrat est
// minimal mais conforme à ce que go-oidc consomme.
//
// `signFn` est appelée pour signer l'id_token : le test peut injecter
// les claims qu'il veut (sub, email, name, etc.).
func newFakeOIDCProvider(t *testing.T) *httptest.Server {
	t.Helper()

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	kid := "test-key-1"

	mux := http.NewServeMux()

	// Discovery document.
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                r.Host,
			"authorization_endpoint":                "http://" + r.Host + "/authorize",
			"token_endpoint":                        "http://" + r.Host + "/token",
			"jwks_uri":                              "http://" + r.Host + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
			"response_types_supported":              []string{"id_token", "token", "code"},
		})
	})

	// JWKS : expose la clé publique en JWK.
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		jwk := map[string]any{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": kid,
			"n":   base64.RawURLEncoding.EncodeToString(priv.PublicKey.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(priv.E)).Bytes()),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{jwk}})
	})

	// /token : renvoie un id_token signé.
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", 400)
			return
		}
		code := r.PostFormValue("code")
		claims := map[string]any{
			"iss":   "http://" + r.Host,
			"sub":   "user-from-code-" + code,
			"aud":   "test-client",
			"exp":   time.Now().Add(5 * time.Minute).Unix(),
			"iat":   time.Now().Unix(),
			"email": "alice@example.com",
			"name":  "Alice",
		}
		// idToken signé via le helper local (pas de golang-jwt).
		idToken := signJWTForIssuer(priv, kid, claims)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "fake-access",
			"id_token":     idToken,
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	})

	return httptest.NewServer(mux)
}

func TestOIDC_Callback_HappyPath(t *testing.T) {
	srv := newFakeOIDCProvider(t)
	defer srv.Close()
	t.Setenv("OIDC_ALLOW_INSECURE_URL", "1")

	// Override the oauth2 HTTP client to talk to our httptest server
	// without going through real DNS / TLS — go-oidc defaults to https.
	// For NewProvider to accept an http issuer, we set InsecureIssuerURLContext
	// (not needed here, httptest.NewServer is http but Discovery
	// tolerates with the right issuer URL passed to the constructor).
	ctx := oidc.InsecureIssuerURLContext(context.Background(), srv.URL)
	auth, err := NewOIDCAuthenticator(ctx, OIDCConfig{
		IssuerURL:   srv.URL,
		ClientID:    "test-client",
		RedirectURL: srv.URL + "/auth/callback",
		Scopes:      []string{"openid", "profile", "email"},
	})
	if err != nil {
		t.Fatalf("NewOIDCAuthenticator: %v", err)
	}

	state := "test-state"
	req := httptest.NewRequest("GET",
		fmt.Sprintf("/auth/callback?state=%s&code=the-code", state), nil)
	req.AddCookie(&http.Cookie{
		Name:  "openfga_explorer_oidc_state",
		Value: state,
	})

	user, appErr := auth.Callback(ctx, req)
	if appErr != nil {
		t.Fatalf("Callback: %+v", appErr)
	}
	if user == nil {
		t.Fatal("Callback returned nil user")
	}
	if user.Source != "oidc" {
		t.Errorf("Source: got %q, want oidc", user.Source)
	}
	if user.Subject != "user-from-code-the-code" {
		t.Errorf("Subject: got %q, want user-from-code-the-code", user.Subject)
	}
	if user.Email != "alice@example.com" {
		t.Errorf("Email: got %q", user.Email)
	}
	if user.Name != "Alice" {
		t.Errorf("Name: got %q", user.Name)
	}
	if user.PreferredName != "" {
		// PreferredName vient de `preferred_username`, pas dans ce JWT.
		// On vérifie juste que l'absence ne casse pas.
		t.Logf("PreferredName: %q (unexpected but harmless)", user.PreferredName)
	}
}

// ── SSRF guard sur IssuerURL ────────────────────────────────────────

func TestRejectInsecureIssuer_LoopbackIPv4_Rejected(t *testing.T) {
	if err := rejectInsecureIssuer("http://127.0.0.1:8080"); err == nil {
		t.Error("expected 127.0.0.1 to be rejected")
	}
}

func TestRejectInsecureIssuer_LoopbackIPv6_Rejected(t *testing.T) {
	if err := rejectInsecureIssuer("http://[::1]:8080"); err == nil {
		t.Error("expected [::1] to be rejected")
	}
}

func TestRejectInsecureIssuer_RFC1918_Rejected(t *testing.T) {
	for _, ip := range []string{"10.0.0.5", "172.16.0.1", "192.168.1.1"} {
		if err := rejectInsecureIssuer("http://" + ip + ":8080"); err == nil {
			t.Errorf("expected %s to be rejected", ip)
		}
	}
}

func TestRejectInsecureIssuer_LinkLocal_Rejected(t *testing.T) {
	if err := rejectInsecureIssuer("http://169.254.169.254"); err == nil {
		t.Error("expected link-local (cloud metadata) to be rejected")
	}
}

func TestRejectInsecureIssuer_PublicIP_Allowed(t *testing.T) {
	if err := rejectInsecureIssuer("https://accounts.google.com"); err != nil {
		t.Errorf("expected public hostname to be accepted, got %v", err)
	}
}

func TestRejectInsecureIssuer_Hostname_Allowed(t *testing.T) {
	if err := rejectInsecureIssuer("https://idp.example.com"); err != nil {
		t.Errorf("expected hostname to be accepted, got %v", err)
	}
}

func TestRejectInsecureIssuer_OverrideAllows(t *testing.T) {
	t.Setenv("OIDC_ALLOW_INSECURE_URL", "1")
	if err := rejectInsecureIssuer("http://127.0.0.1:8080"); err != nil {
		t.Errorf("override should allow private IP, got %v", err)
	}
}

func TestRejectInsecureIssuer_InvalidURL_Rejected(t *testing.T) {
	if err := rejectInsecureIssuer("://no-scheme"); err == nil {
		t.Error("malformed URL should be rejected")
	}
}
