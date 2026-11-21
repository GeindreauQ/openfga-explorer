package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GeindreauQ/openfga-explorer/config"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/models"
	openfga "github.com/openfga/go-sdk"
)

// fakeOpenFGA implémente openfgaclient.OpenFGA pour les tests health.
// Seules Ping et DefaultStoreID sont sollicitées par HealthController.
// On garde les autres signatures (zombie) pour respecter le contrat de
// l'interface.
type fakeOpenFGA struct {
	storeID string
	pingErr error
}

func (f *fakeOpenFGA) DefaultStoreID() string       { return f.storeID }
func (f *fakeOpenFGA) SetDefaultStoreID(string)     {}
func (f *fakeOpenFGA) Ping(_ context.Context) error { return f.pingErr }
func (f *fakeOpenFGA) ListStores(context.Context) ([]models.Store, error) {
	return nil, nil
}
func (f *fakeOpenFGA) ReadAllTuples(context.Context, string) ([]models.Tuple, error) {
	return nil, nil
}
func (f *fakeOpenFGA) Write(context.Context, string, []models.Tuple, []models.Tuple) error {
	return nil
}
func (f *fakeOpenFGA) WriteAuthorizationModelRaw(context.Context, string, string, []openfga.TypeDefinition, *map[string]openfga.Condition) (string, error) {
	return "", nil
}
func (f *fakeOpenFGA) ListAuthorizationModels(context.Context, string) ([]map[string]any, error) {
	return nil, nil
}
func (f *fakeOpenFGA) Check(context.Context, string, string, string, string, openfgaclient.Query) (bool, error) {
	return false, nil
}
func (f *fakeOpenFGA) ListObjects(context.Context, string, string, string, string, openfgaclient.Query) ([]string, error) {
	return nil, nil
}
func (f *fakeOpenFGA) ListUsers(context.Context, string, string, string, []openfga.UserTypeFilter, openfgaclient.Query) ([]openfga.User, error) {
	return nil, nil
}
func (f *fakeOpenFGA) Expand(context.Context, string, string, string, string) ([]openfga.TupleKey, error) {
	return nil, nil
}
func (f *fakeOpenFGA) ReadAssertions(context.Context, string, string) ([]openfga.Assertion, error) {
	return nil, nil
}
func (f *fakeOpenFGA) WriteAssertions(context.Context, string, string, []openfga.Assertion) error {
	return nil
}
func (f *fakeOpenFGA) ReadAuthorizationModel(context.Context, string, string) (map[string]any, error) {
	return nil, nil
}

var _ openfgaclient.OpenFGA = (*fakeOpenFGA)(nil)

func newTestHealthCfg(configured bool) config.Config {
	cfg := config.Config{
		Server: config.ServerConfig{Addr: ":0", WebDir: "."},
		Auth:   config.AuthConfig{Disabled: false},
	}
	if configured {
		cfg.OpenFGA = config.OpenFGAConfig{
			URL: "http://openfga:8080",
		}
	}
	return cfg
}

func decodeHealth(t *testing.T, body string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("decode JSON: %v\nbody: %s", err, body)
	}
	return m
}

// ── /api/health (public, minimaliste) ─────────────────────────────

func TestHealth_OpenFGANotConfigured_Skipped(t *testing.T) {
	cfg := newTestHealthCfg(false)
	h := NewHealthController(cfg, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["status"] != "ok" {
		t.Errorf("status field: got %v, want ok", body["status"])
	}
	if body["openfga"] != "skipped" {
		t.Errorf("openfga field: got %v, want skipped", body["openfga"])
	}
	// Champs sensibles NE doivent PAS apparaître sur l'endpoint public.
	if _, ok := body["storeId"]; ok {
		t.Errorf("storeId should not be exposed on public /api/health")
	}
	if _, ok := body["openfgaUrl"]; ok {
		t.Errorf("openfgaUrl should not be exposed on public /api/health")
	}
}

func TestHealth_PingOK_Up_PublicOnlyHasStatus(t *testing.T) {
	cfg := newTestHealthCfg(true)
	fake := &fakeOpenFGA{storeID: "01HABC", pingErr: nil}
	h := NewHealthController(cfg, fake)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["openfga"] != "up" {
		t.Errorf("openfga field: got %v, want up", body["openfga"])
	}
	if _, ok := body["storeId"]; ok {
		t.Errorf("storeId should not be exposed on public /api/health")
	}
}

func TestHealth_PingFails_Degraded503(t *testing.T) {
	cfg := newTestHealthCfg(true)
	fake := &fakeOpenFGA{storeID: "01HABC", pingErr: errors.New("connection refused")}
	h := NewHealthController(cfg, fake)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want 503", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["status"] != "degraded" {
		t.Errorf("status field: got %v, want degraded", body["status"])
	}
	if body["openfga"] != "down" {
		t.Errorf("openfga field: got %v, want down", body["openfga"])
	}
	// Le détail de l'erreur n'est PAS exposé publiquement.
	if _, ok := body["openfgaError"]; ok {
		t.Errorf("openfgaError should not be exposed on public /api/health")
	}
}

func TestHealth_NilClientAndNotConfigured(t *testing.T) {
	cfg := newTestHealthCfg(false)
	h := NewHealthController(cfg, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["openfga"] != "skipped" {
		t.Errorf("openfga: got %v, want skipped", body["openfga"])
	}
}

// ── /api/health/live (process up, pas d'I/O) ─────────────────────

func TestHealthLive_AlwaysOK(t *testing.T) {
	h := NewHealthController(newTestHealthCfg(false), nil)

	req := httptest.NewRequest(http.MethodGet, "/api/health/live", nil)
	rr := httptest.NewRecorder()
	h.Live(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["status"] != "ok" {
		t.Errorf("status: got %v, want ok", body["status"])
	}
}

func TestHealthLive_OK_EvenWhenOpenFGADown(t *testing.T) {
	cfg := newTestHealthCfg(true)
	fake := &fakeOpenFGA{pingErr: errors.New("down")}
	h := NewHealthController(cfg, fake)

	req := httptest.NewRequest(http.MethodGet, "/api/health/live", nil)
	rr := httptest.NewRecorder()
	h.Live(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("liveness should be OK even when OpenFGA is down (got %d)", rr.Code)
	}
}

// ── /api/health/detail (auth-gated, JSON complet) ────────────────

func TestHealthDetail_PingOK_AllFieldsPresent(t *testing.T) {
	cfg := newTestHealthCfg(true)
	cfg.Auth.Disabled = true // exposé publiquement dans ce test
	fake := &fakeOpenFGA{storeID: "01HABC", pingErr: nil}
	h := NewHealthController(cfg, fake)

	req := httptest.NewRequest(http.MethodGet, "/api/health/detail", nil)
	rr := httptest.NewRecorder()
	h.Detail(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["openfga"] != "up" {
		t.Errorf("openfga field: got %v, want up", body["openfga"])
	}
	if body["storeId"] != "01HABC" {
		t.Errorf("storeId field: got %v, want 01HABC", body["storeId"])
	}
	if body["openfgaUrl"] != "http://openfga:8080" {
		t.Errorf("openfgaUrl field: got %v", body["openfgaUrl"])
	}
}

func TestHealthDetail_PingFails_SurfacesError(t *testing.T) {
	cfg := newTestHealthCfg(true)
	fake := &fakeOpenFGA{pingErr: errors.New("connection refused")}
	h := NewHealthController(cfg, fake)

	req := httptest.NewRequest(http.MethodGet, "/api/health/detail", nil)
	rr := httptest.NewRecorder()
	h.Detail(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want 503", rr.Code)
	}
	body := decodeHealth(t, rr.Body.String())
	if body["openfga"] != "down" {
		t.Errorf("openfga field: got %v, want down", body["openfga"])
	}
	errMsg, _ := body["openfgaError"].(string)
	if !strings.Contains(errMsg, "connection refused") {
		t.Errorf("openfgaError should surface the cause, got %q", errMsg)
	}
}
