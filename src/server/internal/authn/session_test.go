package authn

import (
	"strings"
	"testing"
	"time"

	"github.com/GeindreauQ/openfga-explorer/models"
)

const testSecret = "test-secret-must-be-at-least-32-chars-long-yes"

func newTestSessionStore(ttl time.Duration) *MemorySessionStore {
	return NewMemorySessionStore(testSecret, ttl, "openfga_explorer_session", 32)
}

func testUser(name string) *models.User {
	return &models.User{
		Subject:       "local:" + name,
		Email:         name + "@test",
		EmailVerified: true,
		Name:          name,
		PreferredName: name,
		Roles:         []string{"admin"},
		Source:        "local",
	}
}

func TestSessionCreateGet(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)

	sess, cookie, err := store.Create(testUser("alice"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sess == nil || cookie == "" {
		t.Fatal("Create returned nil session or empty cookie")
	}
	if !strings.Contains(cookie, ".") {
		t.Fatalf("cookie should contain '.': %q", cookie)
	}

	got := store.Get(cookie)
	if got == nil {
		t.Fatal("Get returned nil for fresh cookie")
	}
	if got.User.PreferredName != "alice" {
		t.Errorf("got user %q, want alice", got.User.PreferredName)
	}
}

func TestSessionBadSignature(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)

	_, cookie, err := store.Create(testUser("bob"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	parts := strings.SplitN(cookie, ".", 2)
	if len(parts) != 2 {
		t.Fatal("cookie mal formé")
	}
	// On altère le premier caractère : le dernier ne porte que 4 bits utiles
	// sur 6, une substitution peut y redonner les mêmes octets.
	sig := parts[1]
	first := byte('A')
	if sig[0] == 'A' {
		first = 'B'
	}
	tampered := parts[0] + "." + string(first) + sig[1:]

	if got := store.Get(tampered); got != nil {
		t.Errorf("Get with tampered signature should return nil, got %+v", got)
	}
}

func TestSessionExpired(t *testing.T) {
	store := newTestSessionStore(1 * time.Millisecond)

	_, cookie, err := store.Create(testUser("carol"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	time.Sleep(5 * time.Millisecond)

	if got := store.Get(cookie); got != nil {
		t.Errorf("Get with expired session should return nil, got %+v", got)
	}
}

func TestSessionEmptyCookie(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)

	if got := store.Get(""); got != nil {
		t.Errorf("Get with empty cookie should return nil, got %+v", got)
	}
}

func TestSessionMalformed(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)

	cases := []string{"no-dot", "id.badbase64!", ".only-sig"}
	for _, c := range cases {
		if got := store.Get(c); got != nil {
			t.Errorf("Get(%q) should return nil, got %+v", c, got)
		}
	}
}

func TestSessionDelete(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)

	_, cookie, err := store.Create(testUser("dave"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if got := store.Get(cookie); got == nil {
		t.Fatal("Get should work before Delete")
	}

	store.Delete(cookie)

	if got := store.Get(cookie); got != nil {
		t.Errorf("Get after Delete should return nil, got %+v", got)
	}
}

func TestSessionDeleteUnknown(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)

	store.Delete("garbage.cookie")
}

func TestSessionStoreID(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)
	sess, cookie, err := store.Create(testUser("alice"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sess.StoreID != "" {
		t.Errorf("initial StoreID should be empty, got %q", sess.StoreID)
	}
	if err := store.SetStoreID(cookie, "store-A"); err != nil {
		t.Fatalf("SetStoreID: %v", err)
	}
	got := store.Get(cookie)
	if got == nil {
		t.Fatal("Get returned nil after SetStoreID")
	}
	if got.StoreID != "store-A" {
		t.Errorf("StoreID after Set: got %q, want store-A", got.StoreID)
	}
}

func TestSessionStoreID_NotFound(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)
	err := store.SetStoreID("garbage.cookie", "store-A")
	if err != ErrSessionNotFound {
		t.Errorf("expected ErrSessionNotFound, got %v", err)
	}
}

func TestSessionIsolatedStoreID(t *testing.T) {
	store := newTestSessionStore(8 * time.Hour)
	_, aliceCookie, _ := store.Create(testUser("alice"))
	_, bobCookie, _ := store.Create(testUser("bob"))

	if err := store.SetStoreID(aliceCookie, "store-A"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetStoreID(bobCookie, "store-B"); err != nil {
		t.Fatal(err)
	}

	alice := store.Get(aliceCookie)
	bob := store.Get(bobCookie)
	if alice.StoreID != "store-A" || bob.StoreID != "store-B" {
		t.Errorf("session scope leak: alice=%q bob=%q", alice.StoreID, bob.StoreID)
	}
}
