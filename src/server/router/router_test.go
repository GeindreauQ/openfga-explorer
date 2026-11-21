package router

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GeindreauQ/openfga-explorer/config"
	"github.com/GeindreauQ/openfga-explorer/controllers"
	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/models"
	openfga "github.com/openfga/go-sdk"
)

// stubOpenFGA implémente openfgaclient.OpenFGA avec des no-ops pour les
// tests qui n'ont pas besoin d'un vrai backend OpenFGA. Les méthodes
// renvoient des slices vides / nil ; seules les routes purement
// structurelles (auth, headers) sont testées ici.
type stubOpenFGA struct{}

func (s *stubOpenFGA) DefaultStoreID() string     { return "" }
func (s *stubOpenFGA) SetDefaultStoreID(string)   {}
func (s *stubOpenFGA) Ping(context.Context) error { return nil }
func (s *stubOpenFGA) ListStores(context.Context) ([]models.Store, error) {
	return nil, nil
}
func (s *stubOpenFGA) ReadAllTuples(context.Context, string) ([]models.Tuple, error) {
	return nil, nil
}
func (s *stubOpenFGA) Write(context.Context, string, []models.Tuple, []models.Tuple) error {
	return nil
}
func (s *stubOpenFGA) WriteAuthorizationModelRaw(context.Context, string, string, []openfga.TypeDefinition, *map[string]openfga.Condition) (string, error) {
	return "", nil
}
func (s *stubOpenFGA) ListAuthorizationModels(context.Context, string) ([]map[string]any, error) {
	return nil, nil
}
func (s *stubOpenFGA) Check(context.Context, string, string, string, string, openfgaclient.Query) (bool, error) {
	return false, nil
}
func (s *stubOpenFGA) ListObjects(context.Context, string, string, string, string, openfgaclient.Query) ([]string, error) {
	return nil, nil
}
func (s *stubOpenFGA) ListUsers(context.Context, string, string, string, []openfga.UserTypeFilter, openfgaclient.Query) ([]openfga.User, error) {
	return nil, nil
}
func (s *stubOpenFGA) Expand(context.Context, string, string, string, string) ([]openfga.TupleKey, error) {
	return nil, nil
}
func (s *stubOpenFGA) ReadAssertions(context.Context, string, string) ([]openfga.Assertion, error) {
	return nil, nil
}
func (s *stubOpenFGA) WriteAssertions(context.Context, string, string, []openfga.Assertion) error {
	return nil
}
func (s *stubOpenFGA) ReadAuthorizationModel(context.Context, string, string) (map[string]any, error) {
	return nil, nil
}

// Compile-time check que le stub implémente bien l'interface.
var _ openfgaclient.OpenFGA = (*stubOpenFGA)(nil)

// newTestRouter construit un router minimal pour les tests. `authOn`
// pilote l'état activé/désactivé de l'auth dans la config.
func newTestRouter(t *testing.T, authOn bool) http.Handler {
	t.Helper()
	// Pointeur vers le répertoire views/ à la racine du module serveur :
	// le router charge views/login.html au démarrage via filepath.Join.
	// En production, VIEWS_DIR pointe sur ce dossier ; en test on
	// résout depuis le module root (un cran au-dessus de router/).
	t.Setenv("VIEWS_DIR", "../views")

	cfg := config.Load("")
	cfg.Auth.Disabled = !authOn
	cfg.Auth.SessionSecret = "test-secret-32-chars-minimum-padding"
	cfg.Auth.SecureCookies = false
	cfg.Tuning.SessionTTL = 8 * time.Hour

	broker := controllers.NewEventBroker(10, 4)
	sessions := authn.NewMemorySessionStore(cfg.Auth.SessionSecret, cfg.Tuning.SessionTTL, "", 32)
	authenticators := authn.NewAuthenticatorSet() // vide pour les tests

	return New(cfg, &stubOpenFGA{}, authenticators, sessions, nil, broker)
}

// TestSecurityHeaders_AppliedToAllResponses vérifie que les headers
// de sécurité sont posés sur les réponses de TOUTES les routes
// (santé publique incluse).
func TestSecurityHeaders_AppliedToAllResponses(t *testing.T) {
	h := newTestRouter(t, false) // auth off pour simplifier

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("/api/health: code = %d, want 200", rr.Code)
	}

	checks := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}
	for hdr, want := range checks {
		got := rr.Header().Get(hdr)
		if got != want {
			t.Errorf("header %s = %q, want %q", hdr, got, wht(want))
		}
	}

	csp := rr.Header().Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("Content-Security-Policy header missing")
	}
	// Vendoring : toutes les dépendances tierces sont servies depuis
	// /vendor/ (cf. scripts/vendor.sh). Aucune origine externe ne doit
	// figurer dans la CSP — sinon le navigateur autoriserait des
	// ressources tierces inutilement.
	for _, mustContain := range []string{
		"frame-ancestors 'none'",
		"default-src 'self'",
		"connect-src 'self'",
	} {
		if !strings.Contains(csp, mustContain) {
			t.Errorf("CSP should contain %q, got: %s", mustContain, csp)
		}
	}
	for _, forbidden := range []string{
		"https://cdn.jsdelivr.net",
		"https://esm.sh",
		"https://cdnjs.cloudflare.com",
	} {
		if strings.Contains(csp, forbidden) {
			t.Errorf("CSP must NOT contain external origin %q (vendored); got: %s", forbidden, csp)
		}
	}
	// Garde-fou : 'unsafe-eval' ne doit plus apparaître. Si une
	// dépendance future le réintroduit, on veut le savoir (Cytoscape
	// moderne et ESM n'en ont plus besoin).
	if strings.Contains(csp, "'unsafe-eval'") {
		t.Errorf("CSP should NOT contain 'unsafe-eval' (PR6 hardening); got: %s", csp)
	}
}

// TestSecurityHeaders_AppliedToStaticAssets vérifie que les headers
// sont aussi posés sur les fichiers statiques (index.html, JS, CSS).
func TestSecurityHeaders_AppliedToStaticAssets(t *testing.T) {
	h := newTestRouter(t, false) // auth off → on accède à / directement

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(rr, req)

	if rr.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("static /: X-Frame-Options = %q, want DENY", rr.Header().Get("X-Frame-Options"))
	}
	if rr.Header().Get("Content-Security-Policy") == "" {
		t.Error("static /: Content-Security-Policy missing")
	}
}

// TestGetDSL_RequiresAuth vérifie que GET /api/dsl est désormais
// protégé par le middleware d'auth quand l'auth est activée.
func TestGetDSL_RequiresAuth(t *testing.T) {
	h := newTestRouter(t, true)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/dsl", nil)
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("/api/dsl sans cookie de session : code = %d, want 401", rr.Code)
	}
}

// TestGetDSL_AllowedWhenAuthDisabled vérifie que GET /api/dsl reste
// accessible quand l'auth est désactivée (mode démo / local).
func TestGetDSL_AllowedWhenAuthDisabled(t *testing.T) {
	h := newTestRouter(t, false)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/dsl", nil)
	h.ServeHTTP(rr, req)

	// Le stub OpenFGA renvoie nil → le handler renvoie probablement
	// 500 ou 200 selon le code de DSL Get. Ce qu'on vérifie ici,
	// c'est juste qu'on n'a PAS un 401.
	if rr.Code == http.StatusUnauthorized {
		t.Errorf("/api/dsl avec auth off: should not be 401, got %d", rr.Code)
	}
}

// TestReadRoutes_RequireAuth vérifie que toutes les routes de lecture
// sensibles renvoient 401 sans cookie de session quand l'auth est
// activée. Couvre le périmètre introduit en PR "sécurité API" — la
// liste exacte est susceptible d'évoluer, l'objectif est de garder
// chaque nouvelle route de lecture sous middleware d'auth.
func TestReadRoutes_RequireAuth(t *testing.T) {
	h := newTestRouter(t, true)

	cases := []struct {
		method string
		path   string
		body   string
	}{
		// Lecture du graphe complet de tuples — top priorité.
		{http.MethodGet, "/api/tuples", ""},
		// Liste de tous les stores de l'instance — révèle la cartographie.
		{http.MethodGet, "/api/stores", ""},
		// Parse de DSL — CPU only mais cohérent avec le reste.
		{http.MethodPost, "/api/dsl/parse", `{"dsl":""}`},
		// Lint sémantique — idem.
		{http.MethodPost, "/api/dsl/lint", `{"model":{}}`},
		// SSE /api/events — historiquement sans middleware, désormais
		// protégé (le middleware d'auth est un passthrough qui ne casse
		// pas le streaming).
		{http.MethodGet, "/api/events", ""},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			var body *strings.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			} else {
				body = strings.NewReader("")
			}
			req := httptest.NewRequest(tc.method, tc.path, body)
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusUnauthorized {
				t.Errorf("want 401, got %d", rr.Code)
			}
		})
	}
}

// TestReadRoutes_AccessibleWhenAuthDisabled vérifie que les routes
// protégées ci-dessus restent accessibles (≠ 401) quand l'auth est
// désactivée. Le mode AUTH_DISABLED=1 doit toujours pouvoir tout lire.
func TestReadRoutes_AccessibleWhenAuthDisabled(t *testing.T) {
	h := newTestRouter(t, false)

	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/tuples", ""},
		{http.MethodGet, "/api/stores", ""},
		{http.MethodPost, "/api/dsl/parse", `{"dsl":""}`},
		{http.MethodPost, "/api/dsl/lint", `{"model":{}}`},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			body := strings.NewReader(tc.body)
			req := httptest.NewRequest(tc.method, tc.path, body)
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			// Démo mode : on autorise tout sauf 401.
			if rr.Code == http.StatusUnauthorized {
				t.Errorf("auth off: want ≠ 401, got 401")
			}
		})
	}
}

// wht est un petit helper pour rendre les messages d'erreur plus
// lisibles (évite le shadowing de variable `want`).
func wht(s string) string { return s }

func TestInlineScriptHashes(t *testing.T) {
	dir := t.TempDir()
	page := filepath.Join(dir, "index.html")
	body := `{"imports":{"x":"./x.js"}}`
	html := `<script type="importmap">` + body + `</script><script type="module" src="./main.js"></script>`
	if err := os.WriteFile(page, []byte(html), 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(body))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	got := inlineScriptHashes(page, filepath.Join(dir, "absent.html"))
	if len(got) != 1 || got[0] != want {
		t.Fatalf("hashes = %v, attendu [%s]", got, want)
	}

	rr := httptest.NewRecorder()
	securityHeadersMiddleware(false, got, http.NotFoundHandler()).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	csp := rr.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self' "+want+";") {
		t.Fatalf("CSP inattendue : %s", csp)
	}
}
