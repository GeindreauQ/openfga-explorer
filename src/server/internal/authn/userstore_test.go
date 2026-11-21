package authn

import (
	"strings"
	"testing"
)

func newTestUserStore() *MemoryUserStore {
	return NewMemoryUserStore()
}

func TestUserStoreAddAndVerify(t *testing.T) {
	store := newTestUserStore()

	if err := store.Add("alice", "alice@test", "Alice", "super-secret-password", []string{"admin"}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	user, err := store.Verify("alice", "super-secret-password")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if user.PreferredName != "alice" {
		t.Errorf("got preferred_name %q, want alice", user.PreferredName)
	}
	if !user.BuiltIn {
		t.Error("user should be marked BuiltIn")
	}
	if user.Source != "local" {
		t.Errorf("got source %q, want local", user.Source)
	}
}

func TestUserStoreAddDuplicate(t *testing.T) {
	store := newTestUserStore()

	if err := store.Add("bob", "b@x", "Bob", "long-enough-password", nil); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	if err := store.Add("bob", "b@x", "Bob 2", "another-long-password", nil); err == nil {
		t.Fatal("second Add for same username should fail")
	}
}

func TestUserStoreAddShortPassword(t *testing.T) {
	store := newTestUserStore()

	cases := []string{"", "a", "short", "1234567"}
	for _, pwd := range cases {
		if err := store.Add("x"+pwd, "x@x", "X", pwd, nil); err == nil {
			t.Errorf("Add with password of len %d should fail", len(pwd))
		}
	}
}

func TestUserStoreAddEmptyUsername(t *testing.T) {
	store := newTestUserStore()

	if err := store.Add("   ", "x@x", "X", "long-enough-password", nil); err == nil {
		t.Error("Add with whitespace username should fail")
	}
}

func TestUserStoreVerifyWrongPassword(t *testing.T) {
	store := newTestUserStore()

	if err := store.Add("carol", "c@x", "Carol", "the-right-password", nil); err != nil {
		t.Fatalf("Add: %v", err)
	}

	_, err := store.Verify("carol", "the-WRONG-password")
	if err == nil {
		t.Fatal("Verify with wrong password should fail")
	}
	if !strings.Contains(err.Error(), "utilisateur ou mot de passe invalide") {
		t.Errorf("error message should be generic, got %q", err.Error())
	}
}

func TestUserStoreVerifyUnknownUser(t *testing.T) {
	store := newTestUserStore()

	_, err := store.Verify("ghost", "anything-long-enough")
	if err == nil {
		t.Fatal("Verify with unknown user should fail")
	}
	if !strings.Contains(err.Error(), "utilisateur ou mot de passe invalide") {
		t.Errorf("error message should match wrong-password case, got %q", err.Error())
	}
}

func TestUserStoreHasUser(t *testing.T) {
	store := newTestUserStore()

	if store.HasUser("dave") {
		t.Error("HasUser should be false for unknown user")
	}

	if err := store.Add("Dave", "d@x", "Dave", "long-enough-password", nil); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if !store.HasUser("dave") {
		t.Error("HasUser should be true after Add (case-insensitive)")
	}
	if !store.HasUser("DAVE") {
		t.Error("HasUser should be case-insensitive")
	}
}

func TestUserStoreSeedDefaultAdminIdempotent(t *testing.T) {
	store := newTestUserStore()

	user1, pwd1, seeded1, err := SeedDefaultAdmin(store, "")
	if err != nil {
		t.Fatalf("first SeedDefaultAdmin: %v", err)
	}
	if !seeded1 {
		t.Error("first SeedDefaultAdmin should report seeded=true")
	}
	if user1 != "admin" || pwd1 == "" {
		t.Errorf("unexpected return: user=%q pwd-len=%d", user1, len(pwd1))
	}

	user2, pwd2, seeded2, err := SeedDefaultAdmin(store, "")
	if err != nil {
		t.Fatalf("second SeedDefaultAdmin: %v", err)
	}
	if seeded2 {
		t.Error("second SeedDefaultAdmin should report seeded=false (idempotent)")
	}
	if user2 != "admin" || pwd2 != "" {
		t.Errorf("second call should not re-issue password: user=%q pwd-len=%d", user2, len(pwd2))
	}
}

func TestUserStoreSeedDefaultAdminFixedPassword(t *testing.T) {
	store := newTestUserStore()

	user, pwd, seeded, err := SeedDefaultAdmin(store, "my-fixed-password")
	if err != nil {
		t.Fatalf("SeedDefaultAdmin: %v", err)
	}
	if !seeded || user != "admin" || pwd != "my-fixed-password" {
		t.Errorf("fixed password not honored: user=%q pwd=%q seeded=%v", user, pwd, seeded)
	}

	if _, err := store.Verify("admin", "my-fixed-password"); err != nil {
		t.Errorf("Verify with fixed password should succeed: %v", err)
	}
}
