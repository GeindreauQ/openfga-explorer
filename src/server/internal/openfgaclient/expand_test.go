package openfgaclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Expand lit les tuples pendant qu'il tient le verrou des appels : il ne
// doit pas repasser par ReadAllTuples (verrou non réentrant), sinon tout
// le client OpenFGA reste bloqué.
func TestExpandDoesNotDeadlock(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/expand"):
			_, _ = w.Write([]byte(`{"tree":{"root":{"name":"doc:1#viewer","leaf":{"users":{"users":["user:alice"]}}}}}`))
		case strings.HasSuffix(r.URL.Path, "/read"):
			_, _ = w.Write([]byte(`{"tuples":[{"key":{"user":"user:alice","relation":"viewer","object":"doc:1"}}],"continuation_token":""}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()

	c, err := New(api.URL, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	const store = "01HXXXXXXXXXXXXXXXXXXXXXXX"
	done := make(chan error, 1)
	go func() {
		_, err := c.Expand(context.Background(), store, "user:alice", "viewer", "doc:1")
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("expand: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Expand bloqué : verrou repris pendant la lecture des tuples")
	}
	// Le client reste utilisable après Expand.
	if _, err := c.ReadAllTuples(context.Background(), store); err != nil {
		t.Fatalf("read after expand: %v", err)
	}
}
