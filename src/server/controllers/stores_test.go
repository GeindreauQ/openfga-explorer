package controllers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/models"
)

const (
	storeA = "01HAAAAAAAAAAAAAAAAAAAAAAA"
	storeB = "01HBBBBBBBBBBBBBBBBBBBBBBB"
)

// storesFake renvoie une liste de stores fixe ; le reste vient de fakeOpenFGA.
type storesFake struct{ *fakeOpenFGA }

func (storesFake) ListStores(context.Context) ([]models.Store, error) {
	return []models.Store{{ID: storeA, Name: "a"}, {ID: storeB, Name: "b"}}, nil
}

func selectStore(t *testing.T, c *StoresController, id string) *http.Cookie {
	t.Helper()
	w := httptest.NewRecorder()
	c.Select(w, httptest.NewRequest(http.MethodPost, "/api/stores/select", strings.NewReader(`{"storeId":"`+id+`"}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("select %q: %d %s", id, w.Code, w.Body)
	}
	for _, ck := range w.Result().Cookies() {
		if ck.Name == storeCookie {
			return ck
		}
	}
	t.Fatalf("select %q: no %s cookie", id, storeCookie)
	return nil
}

// Sans authentification, chaque navigateur garde son store : le choix de
// l'un ne change pas celui de l'autre ni le store par défaut.
func TestStoreSelectionIsPerBrowser(t *testing.T) {
	fake := storesFake{&fakeOpenFGA{storeID: storeA}}
	c := NewStoresController(fake, false)

	ck := selectStore(t, c, storeB)
	if ck.Value != storeB || !ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie = %+v", ck)
	}
	withCookie := httptest.NewRequest(http.MethodGet, "/", nil)
	withCookie.AddCookie(ck)
	if got := effectiveStoreID(withCookie, fake); got != storeB {
		t.Errorf("browser with cookie: store %q, want %q", got, storeB)
	}
	other := httptest.NewRequest(http.MethodGet, "/", nil)
	if got := effectiveStoreID(other, fake); got != storeA {
		t.Errorf("other browser: store %q, want default %q", got, storeA)
	}

	if ck := selectStore(t, c, ""); ck.MaxAge >= 0 {
		t.Errorf("deselect should expire the cookie, got MaxAge %d", ck.MaxAge)
	}
}

func TestStoreCookieIsValidated(t *testing.T) {
	fake := &fakeOpenFGA{storeID: storeA}
	for _, v := range []string{"../../stores", "01haaaaaaaaaaaaaaaaaaaaaaa", "short", storeA + "X"} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.AddCookie(&http.Cookie{Name: storeCookie, Value: v})
		if got := effectiveStoreID(r, fake); got != storeA {
			t.Errorf("cookie %q: store %q, want default %q", v, got, storeA)
		}
	}
}

// Une session sans store choisi utilise le store par défaut ; un cookie de
// sélection n'est pas lu quand l'authentification est active.
func TestSessionStoreFallsBackToDefault(t *testing.T) {
	fake := &fakeOpenFGA{storeID: storeA}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: storeCookie, Value: storeB})
	r = r.WithContext(authn.WithSession(r.Context(), &authn.Session{}))
	if got := effectiveStoreID(r, fake); got != storeA {
		t.Errorf("new session: store %q, want default %q", got, storeA)
	}
	r = r.WithContext(authn.WithSession(r.Context(), &authn.Session{StoreID: storeB}))
	if got := effectiveStoreID(r, fake); got != storeB {
		t.Errorf("session with a choice: store %q, want %q", got, storeB)
	}
}
