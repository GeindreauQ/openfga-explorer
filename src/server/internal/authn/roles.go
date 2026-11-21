package authn

import (
	"net/http"
	"slices"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// RolePolicy attribue un rôle aux utilisateurs OIDC d'après leurs groupes
// (claim "groups" du jeton d'identité).
//
//   - AdminGroups vide : tout utilisateur OIDC est admin (comportement
//     historique, l'accès est alors filtré par le fournisseur d'identité).
//   - Membre d'un des AdminGroups : admin.
//   - Sinon, si ViewerGroups est vide ou contient un de ses groupes : viewer.
//   - Sinon : connexion refusée.
type RolePolicy struct {
	AdminGroups  []string
	ViewerGroups []string
}

// Assign renseigne user.Role, ou renvoie une erreur 403 si l'utilisateur
// n'a droit à aucun rôle.
func (p RolePolicy) Assign(user *models.User) *apperr.Error {
	if len(p.AdminGroups) == 0 || memberOf(user.Groups, p.AdminGroups) {
		user.Role = models.RoleAdmin
		return nil
	}
	if len(p.ViewerGroups) == 0 || memberOf(user.Groups, p.ViewerGroups) {
		user.Role = models.RoleViewer
		return nil
	}
	return apperr.New(http.StatusForbidden, "aucun groupe autorisé pour cet utilisateur")
}

func memberOf(groups, allowed []string) bool {
	return slices.ContainsFunc(groups, func(g string) bool { return slices.Contains(allowed, g) })
}
