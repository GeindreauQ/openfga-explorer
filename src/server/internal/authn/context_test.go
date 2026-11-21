package authn

import (
	"context"
	"testing"
)

func TestSessionFromContext_Nil(t *testing.T) {
	if got := SessionFromContext(context.Background()); got != nil {
		t.Errorf("SessionFromContext on empty ctx should return nil, got %+v", got)
	}
	if got := SessionFromContext(nil); got != nil {
		t.Errorf("SessionFromContext on nil ctx should return nil, got %+v", got)
	}
}

func TestSessionFromContext_RoundTrip(t *testing.T) {
	sess := &Session{ID: "abc"}
	ctx := WithSession(context.Background(), sess)
	got := SessionFromContext(ctx)
	if got == nil {
		t.Fatal("SessionFromContext returned nil")
	}
	if got.ID != "abc" {
		t.Errorf("got ID %q, want abc", got.ID)
	}
}

func TestWithSession_NilIsNoop(t *testing.T) {
	// WithSession(nil) ne doit pas paniquer ni polluer le context.
	ctx := WithSession(context.Background(), nil)
	if got := SessionFromContext(ctx); got != nil {
		t.Errorf("WithSession(nil) should keep ctx empty")
	}
}
