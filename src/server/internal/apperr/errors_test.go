package apperr

import (
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestError_Error(t *testing.T) {
	e := &Error{Status: 400, Message: "bad request"}
	if e.Error() != "bad request" {
		t.Errorf("Error() = %q, want %q", e.Error(), "bad request")
	}
}

func TestFrom_Nil(t *testing.T) {
	if ae := From(nil); ae != nil {
		t.Errorf("From(nil) should return nil, got %v", ae)
	}
}

func TestFrom_Wrapped(t *testing.T) {
	original := &Error{Status: 404, Message: "not found"}
	wrapped := fmt.Errorf("op: %w", original)
	ae := From(wrapped)
	if ae == nil {
		t.Fatal("From should unwrap to *Error")
	}
	if ae.Status != 404 || ae.Message != "not found" {
		t.Errorf("unwrapped: got %+v", ae)
	}
}

func TestFrom_GenericError(t *testing.T) {
	ae := From(errors.New("generic"))
	if ae != nil {
		t.Errorf("From on generic error should return nil, got %v", ae)
	}
}

func TestNew(t *testing.T) {
	e := New(http.StatusBadRequest, "test")
	if e.Status != 400 || e.Message != "test" {
		t.Errorf("New: got %+v", e)
	}
}

func TestWrap_ExistingError(t *testing.T) {
	original := &Error{Status: 401, Message: "auth"}
	wrapped := Wrap(500, original)
	if wrapped.Status != 401 {
		t.Errorf("Wrap should preserve original status, got %d", wrapped.Status)
	}
}

func TestWrap_GenericError(t *testing.T) {
	wrapped := Wrap(http.StatusInternalServerError, errors.New("boom"))
	if wrapped.Status != 500 {
		t.Errorf("Wrap status: got %d, want 500", wrapped.Status)
	}
	if wrapped.Message != "boom" {
		t.Errorf("Wrap message: got %q, want %q", wrapped.Message, "boom")
	}
}

func TestStandardErrors(t *testing.T) {
	cases := []struct {
		err    *Error
		status int
	}{
		{ErrNotConfigured, 503},
		{ErrNoStoreSelected, 400},
		{ErrInvalidJSON, 400},
		{ErrUnauthenticated, 401},
		{ErrRateLimited, 429},
	}
	for _, c := range cases {
		if c.err.Status != c.status {
			t.Errorf("standard error %q: status %d, want %d", c.err.Message, c.err.Status, c.status)
		}
	}
}
