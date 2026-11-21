package openfgaclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Chaque requête porte son store, et un appel lent sur un store ne
// retient pas les appels sur les autres (pas de verrou global).
func TestCallsAreScopedAndConcurrent(t *testing.T) {
	const slow, fast = "01HSSSSSSSSSSSSSSSSSSSSSSS", "01HFFFFFFFFFFFFFFFFFFFFFFF"
	release := make(chan struct{})
	var mu sync.Mutex
	seen := map[string]int{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		for _, id := range []string{slow, fast} {
			if strings.Contains(r.URL.Path, "/stores/"+id+"/") {
				seen[id]++
			}
		}
		mu.Unlock()
		if strings.Contains(r.URL.Path, slow) {
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tuples":[],"continuation_token":""}`))
	}))
	defer api.Close()
	defer close(release)

	c, err := New(api.URL, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = c.ReadAllTuples(context.Background(), slow) }()
	time.Sleep(50 * time.Millisecond) // l'appel lent est en cours

	done := make(chan error, 1)
	go func() { _, err := c.ReadAllTuples(context.Background(), fast); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("fast store: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("un appel lent sur un autre store bloque les autres")
	}
	mu.Lock()
	defer mu.Unlock()
	if seen[slow] != 1 || seen[fast] != 1 {
		t.Errorf("requêtes par store = %v, want une chacun sur son propre chemin", seen)
	}
}
