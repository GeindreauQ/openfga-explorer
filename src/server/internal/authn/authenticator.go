// Package authn regroupe les abstractions d'authentification.
//
// Architecture :
//
//   - Authenticator : interface de haut niveau. Une implémentation par
//     méthode d'auth (Local, OIDC, future LDAP…). Le contrôleur
//     /auth/* intercepte la requête, choisit l'authenticator actif et
//     lui délègue la validation des credentials.
//
//   - SessionStore : interface pour le stockage des sessions actives.
//     L'implémentation in-memory (MemorySessionStore) suffit pour un
//     déploiement mono-instance. Pour du multi-replicas, il suffira
//     d'ajouter une impl Redis sans changer le code appelant.
//
//   - UserStore : interface pour les utilisateurs locaux (avec mot de
//     passe bcrypt). Indépendante du SessionStore : un user peut être
//     vérifié sans créer de session (par exemple pour /api/me).
//
// Le câblage concret (quelle Authenticator instancier en fonction de
// la config) se fait dans main.go via NewAuthenticator.
package authn

import (
	"context"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// Authenticator valide des credentials et établit (ou refuse) une
// session. Chaque méthode d'auth fournit une implémentation.
type Authenticator interface {
	// Name identifie la méthode ("local", "oidc"). Sert à discriminer
	// dans les logs et dans la page /login.
	Name() string

	// Enabled indique si cette méthode est active (configurée).
	Enabled() bool

	// Login redirige ou rend le formulaire initial de la méthode
	// (cas OIDC : redirige vers le provider ; cas local : no-op).
	// Pour les méthodes sans pré-redirection (local), c'est un no-op.
	Login(w http.ResponseWriter, r *http.Request) error

	// Callback termine le flow d'auth (OIDC : échange le code ;
	// local : vérifie username/password depuis le form body).
	// Renvoie un *models.User peuplé, prêt à être associé à une session.
	Callback(ctx context.Context, r *http.Request) (*models.User, *apperr.Error)
}

// AuthenticatorSet regroupe tous les authenticators actifs. Le contrôleur
// /auth/* interroge Set.Enabled("local"/"oidc") pour afficher ou non les
// formulaires correspondants, et délègue à Set.Match() pour router une
// soumission de credentials vers la bonne implémentation.
type AuthenticatorSet struct {
	all []Authenticator
}

// NewAuthenticatorSet crée un set à partir des authenticators fournis.
// Les authenticators nil ou non-enabled sont ignorés.
func NewAuthenticatorSet(auths ...Authenticator) *AuthenticatorSet {
	set := &AuthenticatorSet{}
	for _, a := range auths {
		if a != nil && a.Enabled() {
			set.all = append(set.all, a)
		}
	}
	return set
}

// ByName renvoie l'authenticator portant ce nom, ou nil.
func (s *AuthenticatorSet) ByName(name string) Authenticator {
	for _, a := range s.all {
		if a.Name() == name {
			return a
		}
	}
	return nil
}

// Enabled indique si au moins un authenticator est actif.
func (s *AuthenticatorSet) Enabled() bool { return len(s.all) > 0 }

// All itère sur les authenticators actifs (utile pour la page /login).
func (s *AuthenticatorSet) All() []Authenticator { return s.all }

// Has vérifie la présence d'un authenticator par nom.
func (s *AuthenticatorSet) Has(name string) bool { return s.ByName(name) != nil }
