package models

// User est l'utilisateur authentifié. Les claims sont populés depuis
// le token ID OIDC (sub, email, name) ou depuis le store local
// (Username, Email, Name).
type User struct {
	Subject       string   `json:"sub"` // ID stable (OIDC) OU "local:<name>" (built-in)
	Email         string   `json:"email"`
	EmailVerified bool     `json:"email_verified"`
	Name          string   `json:"name"`
	PreferredName string   `json:"preferred_username"`
	Roles         []string `json:"roles"`
	Groups        []string `json:"groups"`
	// Source indique l'origine de l'utilisateur : "oidc" ou "local".
	Source string `json:"source"`
	// BuiltIn (uniquement pour Source == "local") : true pour les comptes
	// créés au boot (admin par défaut).
	BuiltIn bool `json:"built_in,omitempty"`
	// Role : RoleAdmin (lecture et écriture) ou RoleViewer (lecture seule).
	// Vide pour les sessions antérieures aux rôles : traité comme admin.
	Role string `json:"role"`
}

// Rôles applicatifs.
const (
	RoleAdmin  = "admin"
	RoleViewer = "viewer"
)

// DisplayName renvoie le nom à afficher dans l'UI.
func (u *User) DisplayName() string {
	if u.Name != "" {
		return u.Name
	}
	if u.PreferredName != "" {
		return u.PreferredName
	}
	if u.Email != "" {
		return u.Email
	}
	return u.Subject
}

// CanWrite indique si l'utilisateur peut modifier OpenFGA (tuples,
// modèle, assertions). Seul le rôle viewer est en lecture seule.
func (u *User) CanWrite() bool {
	return u != nil && u.Role != RoleViewer
}
