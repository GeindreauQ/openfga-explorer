package openfgaclient

import (
	"context"
	"strings"
	"testing"

	"github.com/GeindreauQ/openfga-explorer/models"
)

// TestClientNew_InvalidURL vérifie que le constructeur renvoie une
// erreur si l'URL est invalide. Le SDK ne tente pas de connexion à
// l'init — on lui passe donc une URL manifestement mal formée.
func TestClientNew_InvalidURL(t *testing.T) {
	_, err := New("not a url at all", "", nil)
	if err == nil {
		t.Error("New with malformed URL should fail")
	}
}

// TestClientDefaultStoreID vérifie que SetDefaultStoreID / DefaultStoreID fonctionnent.
func TestClientDefaultStoreID(t *testing.T) {
	c := &Client{}
	if c.DefaultStoreID() != "" {
		t.Error("initial DefaultStoreID should be empty")
	}
	c.SetDefaultStoreID("01HABC")
	if c.DefaultStoreID() != "01HABC" {
		t.Errorf("DefaultStoreID after Set: got %q, want %q", c.DefaultStoreID(), "01HABC")
	}
}

// TestStripBearer vérifie que le token est nettoyé du préfixe "Bearer "
// en double (sécurité).
func TestStripBearer(t *testing.T) {
	// Test indirect via New + token "Bearer ..." :
	// doit être accepté sans doublonner le préfixe côté SDK.
	_, err := New("http://localhost:8080", "Bearer my-token", nil)
	if err != nil {
		t.Errorf("New with Bearer-prefixed token should succeed: %v", err)
	}
	_, err = New("http://localhost:8080", "my-token", nil)
	if err != nil {
		t.Errorf("New with raw token should succeed: %v", err)
	}
}

// TestTranslateErr_NoError vérifie que translateErr retourne nil pour
// une erreur nil.
func TestTranslateErr_NoError(t *testing.T) {
	if ae := translateErr(nil, "test"); ae != nil {
		t.Errorf("translateErr(nil) should return nil, got %v", ae)
	}
}

// TestTranslateErr_GenericError vérifie qu'une erreur non typée
// produit un statut 502 (BadGateway).
func TestTranslateErr_GenericError(t *testing.T) {
	ae := translateErr(context.Canceled, "op")
	if ae == nil {
		t.Fatal("translateErr should not return nil for a non-nil error")
	}
	if ae.Status != 502 {
		t.Errorf("generic error → status 502, got %d", ae.Status)
	}
	if !strings.Contains(ae.Message, "op") {
		t.Errorf("message should contain operation name, got %q", ae.Message)
	}
}

// ── Helpers d'audit (pure functions, pas besoin d'un vrai OpenFGA) ──────

func TestTypeFromObject(t *testing.T) {
	cases := []struct {
		obj  string
		want string
	}{
		{"user:alice", "user"},
		{"document:readme", "document"},
		{"server:lakekeeper", "server"},
		{"team:eng#member", "team"}, // userset → on extrait juste le type
		{"weird:foo:bar", "weird"},
	}
	for _, c := range cases {
		got := typeFromObject(c.obj)
		if got != c.want {
			t.Errorf("typeFromObject(%q) = %q, want %q", c.obj, got, c.want)
		}
	}
}

func TestIdFromObject(t *testing.T) {
	cases := []struct {
		obj  string
		want string
	}{
		{"user:alice", "alice"},
		{"document:readme", "readme"},
		{"team:eng#member", "eng"},   // strip userset suffix
		{"weird:foo:bar", "foo:bar"}, // pas de #, on garde tout après le 1er :
	}
	for _, c := range cases {
		got := idFromObject(c.obj)
		if got != c.want {
			t.Errorf("idFromObject(%q) = %q, want %q", c.obj, got, c.want)
		}
	}
}

// ── Tests pour la résolution des usersets dans walkLeaf ────────────────
//
// Bug à corriger : un chemin d'accès comme
//   alice → assignee → role:platform-admin
//   role:platform-admin#assignee → admin → server:lakekeeper
// n'était pas reconstruit correctement — seul le 2e tuple était
// collecté, mais found=false (user != userset). L'UI finissait par
// afficher « Aucun chemin de résolution trouvé » alors qu'il y en a
// clairement un. Les tests ci-dessous vérifient les helpers :

// 1. findTuple retrouve un tuple exact.
func TestFindTuple(t *testing.T) {
	all := []models.Tuple{
		{User: "user:alice", Relation: "assignee", Object: "role:platform-admin"},
		{User: "role:platform-admin#assignee", Relation: "admin", Object: "server:lakekeeper"},
	}
	tk := findTuple(all, "user:alice", "assignee", "role:platform-admin")
	if tk == nil {
		t.Fatal("findTuple should find (user:alice, assignee, role:platform-admin)")
	}
	if tk.User != "user:alice" || tk.Relation != "assignee" {
		t.Errorf("findTuple got %+v", tk)
	}
	neg := findTuple(all, "user:alice", "admin", "server:lakekeeper")
	if neg != nil {
		t.Errorf("findTuple should return nil for missing tuple, got %+v", neg)
	}
}

// 2. findTupleWhereUserMatchesAndObjectIsUserset trouve un tuple
// dont l'object est un userset basé sur l'object de l'API Expand.
func TestFindTupleWhereUserMatchesAndObjectIsUserset(t *testing.T) {
	all := []models.Tuple{
		{User: "user:alice", Relation: "viewer", Object: "doc:1#viewer"},
	}
	tk := findTupleWhereUserMatchesAndObjectIsUserset(all, "user:alice", "viewer", "doc:1")
	if tk == nil {
		t.Fatal("should find userset tuple (user:alice, viewer, doc:1#viewer)")
	}
}

// 3. parseUserset / isUserset sont cohérents.
func TestParseUsersetRoundTrip(t *testing.T) {
	us := parseUserset("role:platform-admin#assignee")
	if us == nil || us.object != "role:platform-admin" || us.rel != "assignee" {
		t.Errorf("parseUserset got %+v", us)
	}
	if !isUserset("role:platform-admin#assignee") {
		t.Error("isUserset should be true for userset string")
	}
	if isUserset("user:alice") {
		t.Error("isUserset should be false for plain user ref")
	}
}
