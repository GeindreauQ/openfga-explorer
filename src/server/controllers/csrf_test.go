package controllers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/GeindreauQ/openfga-explorer/internal/authn"
)

var dummyOK = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
})

func withSession(r *http.Request, sess *authn.Session) *http.Request {
	return r.WithContext(authn.WithSession(r.Context(), sess))
}

func TestCSRF_AllowsSafeMethodWithoutToken(t *testing.T) {
	sess := &authn.Session{CSRFToken: "secret"}
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req = withSession(req, sess)
	rr := httptest.NewRecorder()
	CSRFRequired(dummyOK).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("GET sans token devrait passer, got %d", rr.Code)
	}
}

func TestCSRF_RejectsPOSTWithoutToken(t *testing.T) {
	sess := &authn.Session{CSRFToken: "secret"}
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req = withSession(req, sess)
	rr := httptest.NewRecorder()
	CSRFRequired(dummyOK).ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("POST sans token devrait être 403, got %d", rr.Code)
	}
}

func TestCSRF_AcceptsPOSTWithMatchingToken(t *testing.T) {
	sess := &authn.Session{CSRFToken: "secret"}
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set(CSRFHeader, "secret")
	req = withSession(req, sess)
	rr := httptest.NewRecorder()
	CSRFRequired(dummyOK).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("POST avec bon token devrait passer, got %d", rr.Code)
	}
}

func TestCSRF_RejectsPOSTWithWrongToken(t *testing.T) {
	sess := &authn.Session{CSRFToken: "secret"}
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set(CSRFHeader, "tampered")
	req = withSession(req, sess)
	rr := httptest.NewRecorder()
	CSRFRequired(dummyOK).ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("POST avec mauvais token devrait être 403, got %d", rr.Code)
	}
}

func TestCSRF_NoSessionLetsThrough(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	rr := httptest.NewRecorder()
	CSRFRequired(dummyOK).ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("AUTH_DISABLED: POST sans session devrait passer, got %d", rr.Code)
	}
}

func TestCSRF_OtherMutatingMethods(t *testing.T) {
	sess := &authn.Session{CSRFToken: "secret"}
	for _, m := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
		req := httptest.NewRequest(m, "/x", nil)
		req = withSession(req, sess)
		rr := httptest.NewRecorder()
		CSRFRequired(dummyOK).ServeHTTP(rr, req)
		if rr.Code != http.StatusForbidden {
			t.Errorf("%s sans token devrait être 403, got %d", m, rr.Code)
		}
	}
}
