// LocalAuthenticator implémente Authenticator pour le login par
// username/password contre le UserStore local.
package authn

import (
	"context"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// LocalAuthenticator valide des credentials depuis un UserStore en
// mémoire. Pas de flow de redirection : le form HTML est rendu
// directement sur /login.
type LocalAuthenticator struct {
	users UserStore
}

// NewLocalAuthenticator crée un authenticator local.
func NewLocalAuthenticator(users UserStore) *LocalAuthenticator {
	return &LocalAuthenticator{users: users}
}

// Name retourne "local".
func (a *LocalAuthenticator) Name() string { return "local" }

// Enabled : l'auth locale est active dès qu'un UserStore est présent.
// (Si l'opérateur ne veut QUE de l'OIDC, il peut ne pas instancier
// d'authenticator local dans main.go.)
func (a *LocalAuthenticator) Enabled() bool { return a.users != nil }

// Login : no-op pour l'auth locale (le form est rendu par le handler /login
// directement, pas via un redirect).
func (a *LocalAuthenticator) Login(_ http.ResponseWriter, _ *http.Request) error {
	return nil
}

// Callback parse le form body (username/password), vérifie via UserStore
// et renvoie le *models.User peuplé.
func (a *LocalAuthenticator) Callback(_ context.Context, r *http.Request) (*models.User, *apperr.Error) {
	if err := r.ParseForm(); err != nil {
		return nil, apperr.Wrap(http.StatusBadRequest, err)
	}
	username := r.PostFormValue("username")
	password := r.PostFormValue("password")
	if username == "" || password == "" {
		return nil, apperr.New(http.StatusBadRequest, "Veuillez renseigner nom d'utilisateur et mot de passe")
	}
	user, err := a.users.Verify(username, password)
	if err != nil {
		// Message générique pour ne pas révéler si l'utilisateur existe.
		return nil, apperr.New(http.StatusUnauthorized, "Identifiants invalides")
	}
	return user, nil
}
