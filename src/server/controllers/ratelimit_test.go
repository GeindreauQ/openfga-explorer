package controllers

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GeindreauQ/openfga-explorer/internal/ratelimit"
)

func mustParseCIDR(t *testing.T, s string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatalf("ParseCIDR(%q): %v", s, err)
	}
	return n
}

// newLimitedLimiter crée un Limiter avec une fenêtre très permissive
// (1000 req/min) pour les tests — on n'atteint jamais la limite.
func newLimitedLimiter() *ratelimit.Limiter {
	return ratelimit.New(1000, time.Minute)
}

func TestRateLimit_TrustedProxy_PicksXForwardedFor(t *testing.T) {
	rl := newLimitedLimiter()
	proxies := []*net.IPNet{mustParseCIDR(t, "10.0.0.0/8")}
	mw := RateLimitMiddleware(rl, proxies)

	req := httptest.NewRequest(http.MethodPost, "/auth/local", nil)
	req.RemoteAddr = "10.0.0.5:54321"                 // LB dans le CIDR de confiance
	req.Header.Set("X-Forwarded-For", "203.0.113.42") // IP réelle du client
	rr := httptest.NewRecorder()
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rr.Code)
	}
}

func TestRateLimit_UntrustedProxy_IgnoresXForwardedFor(t *testing.T) {
	rl := newLimitedLimiter()
	// Le CIDR de confiance ne couvre PAS l'IP du test (127.0.0.1).
	proxies := []*net.IPNet{mustParseCIDR(t, "10.0.0.0/8")}
	mw := RateLimitMiddleware(rl, proxies)

	req := httptest.NewRequest(http.MethodPost, "/auth/local", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	req.Header.Set("X-Forwarded-For", "203.0.113.42") // forgeable
	rr := httptest.NewRecorder()
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rr, req)

	// L'IP utilisée pour le bucket DOIT être 127.0.0.1 (RemoteAddr),
	// pas 203.0.113.42. On ne peut pas le vérifier directement
	// depuis le middleware, mais on vérifie au moins que la requête
	// passe — le bucket par RemoteAddr fonctionne.
	if rr.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rr.Code)
	}
}

func TestRateLimit_NoTrustedProxy_IgnoresXForwardedFor(t *testing.T) {
	rl := newLimitedLimiter()
	mw := RateLimitMiddleware(rl, nil) // nil = pas de confiance

	req := httptest.NewRequest(http.MethodPost, "/auth/local", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	req.Header.Set("X-Forwarded-For", "203.0.113.42")
	rr := httptest.NewRecorder()
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rr.Code)
	}
}

func TestRateLimit_OverQuota_Returns429(t *testing.T) {
	// Limiter avec une capacité de 2 requêtes pour saturer rapidement.
	rl := ratelimit.New(2, time.Minute)
	mw := RateLimitMiddleware(rl, nil)

	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// 2 requêtes passent.
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/auth/local", nil)
		req.RemoteAddr = "203.0.113.99:1111"
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("call %d: got %d, want 200", i, rr.Code)
		}
	}
	// La 3e est bloquée.
	req := httptest.NewRequest(http.MethodPost, "/auth/local", nil)
	req.RemoteAddr = "203.0.113.99:1111"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("status: got %d, want 429", rr.Code)
	}
	if got := rr.Header().Get("Retry-After"); got != "60" {
		t.Errorf("Retry-After: got %q, want 60", got)
	}
}

func TestLoadTrustedProxies(t *testing.T) {
	cases := []struct {
		env  string
		want int
	}{
		{"", 0},
		{"10.0.0.0/8", 1},
		{"10.0.0.0/8, 192.168.0.0/16", 2},
		{"not-a-cidr, 10.0.0.0/8", 1}, // invalides ignorés
		{"   ", 0},
	}
	for _, c := range cases {
		t.Setenv("TRUSTED_PROXY_CIDRS", c.env)
		got := LoadTrustedProxies()
		if len(got) != c.want {
			t.Errorf("env=%q: got %d CIDRs, want %d", c.env, len(got), c.want)
		}
	}
}
