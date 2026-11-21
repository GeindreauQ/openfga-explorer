package authn

import (
	"net/http"
	"testing"

	"github.com/GeindreauQ/openfga-explorer/models"
)

func TestRolePolicy(t *testing.T) {
	cases := []struct {
		name   string
		policy RolePolicy
		groups []string
		role   string
		denied bool
	}{
		{"sans groupes configurés : admin", RolePolicy{}, nil, models.RoleAdmin, false},
		{"membre admin", RolePolicy{AdminGroups: []string{"fga-admins"}}, []string{"x", "fga-admins"}, models.RoleAdmin, false},
		{"hors admin, viewers libres : viewer", RolePolicy{AdminGroups: []string{"fga-admins"}}, []string{"x"}, models.RoleViewer, false},
		{"membre viewer", RolePolicy{AdminGroups: []string{"a"}, ViewerGroups: []string{"v"}}, []string{"v"}, models.RoleViewer, false},
		{"admin prime sur viewer", RolePolicy{AdminGroups: []string{"a"}, ViewerGroups: []string{"v"}}, []string{"v", "a"}, models.RoleAdmin, false},
		{"aucun groupe autorisé : refusé", RolePolicy{AdminGroups: []string{"a"}, ViewerGroups: []string{"v"}}, []string{"x"}, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := &models.User{Groups: c.groups}
			err := c.policy.Assign(u)
			if c.denied {
				if err == nil || err.Status != http.StatusForbidden {
					t.Fatalf("attendu 403, obtenu %v (role %q)", err, u.Role)
				}
				return
			}
			if err != nil || u.Role != c.role {
				t.Fatalf("role = %q, err = %v ; attendu %q", u.Role, err, c.role)
			}
		})
	}
}

func TestCanWrite(t *testing.T) {
	if !(&models.User{}).CanWrite() || !(&models.User{Role: models.RoleAdmin}).CanWrite() {
		t.Error("un utilisateur sans rôle (session antérieure) ou admin doit pouvoir écrire")
	}
	if (&models.User{Role: models.RoleViewer}).CanWrite() {
		t.Error("un viewer ne doit pas pouvoir écrire")
	}
}
