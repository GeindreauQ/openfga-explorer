// Interface OpenFGA : définit le contrat utilisé par les controllers.
// Permet de mocker l'OpenFGA en tests et de substituer une autre
// implémentation si besoin (par exemple un cache local).
//
// Modèle de store :
//
//   - En mode AUTH_ENABLED (multi-utilisateur), chaque appel OpenFGA
//     reçoit un storeID explicite issu de la session. Cela évite le
//     bug de l'ancien modèle où le store ID était global et partagé
//     entre utilisateurs.
//   - En mode AUTH_DISABLED (demo mono-utilisateur), storeID peut être
//     vide et le client utilise DefaultStoreID() comme fallback.
//
// Toutes les méthodes propagent des *apperr.Error avec un code HTTP
// sémantiquement correct.
package openfgaclient

import (
	"context"

	"github.com/GeindreauQ/openfga-explorer/models"
	openfga "github.com/openfga/go-sdk"
)

type OpenFGA interface {
	// DefaultStoreID renvoie le store de fallback utilisé quand un
	// appel OpenFGA reçoit storeID == "" (mode AUTH_DISABLED=1, où
	// aucune session n'existe pour porter un store).
	DefaultStoreID() string
	// SetDefaultStoreID pose le store de fallback. Typiquement appelé
	// une fois au boot par main.go avec le premier store disponible.
	SetDefaultStoreID(id string)

	// Ping vérifie que l'instance OpenFGA est joignable et que le
	// token (si fourni) est valide. L'implémentation choisit l'appel
	// le plus léger possible (typiquement ListStores, qui exerce
	// connectivité + auth + compat API).
	Ping(ctx context.Context) error

	ListStores(ctx context.Context) ([]models.Store, error)

	// Toutes les méthodes ci-dessous opèrent sur le store identifié
	// par storeID. En AUTH_ENABLED ce storeID vient de la session.
	// En AUTH_DISABLED, le caller peut passer "" pour utiliser
	// DefaultStoreID().
	ReadAllTuples(ctx context.Context, storeID string) ([]models.Tuple, error)
	Write(ctx context.Context, storeID string, writes, deletes []models.Tuple) error

	// WriteAuthorizationModelRaw envoie un authorization model brut au
	// store identifié. Le `schemaVersion` est appliqué si non vide ; les
	// `typeDefs` et `conditions` sont sérialisés tels quels.
	WriteAuthorizationModelRaw(ctx context.Context, storeID, schemaVersion string, typeDefs []openfga.TypeDefinition, conditions *map[string]openfga.Condition) (string, error)

	// ListAuthorizationModels renvoie les authorization models du store,
	// du plus récent au plus ancien, sous forme de map[string]any brute.
	ListAuthorizationModels(ctx context.Context, storeID string) ([]map[string]any, error)

	// Check demande à OpenFGA si `user` a `relation` sur `object`.
	Check(ctx context.Context, storeID, user, relation, object string, q Query) (bool, error)

	// ListObjects renvoie tous les `objects` du type `objectType` que
	// `user` peut atteindre via `relation`.
	ListObjects(ctx context.Context, storeID, user, relation, objectType string, q Query) ([]string, error)

	// ListUsers renvoie tous les users (filtrés par `userTypeFilter`)
	// qui ont `relation` sur `object`.
	ListUsers(ctx context.Context, storeID, object, relation string, userTypeFilter []openfga.UserTypeFilter, q Query) ([]openfga.User, error)

	// Expand renvoie tous les tuples qui expliquent pourquoi
	// `user#relation@object` est autorisé (ou refusé).
	Expand(ctx context.Context, storeID, user, relation, object string) ([]openfga.TupleKey, error)

	// ReadAssertions renvoie les assertions associées à un authorization
	// model dans le store identifié.
	ReadAssertions(ctx context.Context, storeID, authorizationModelID string) ([]openfga.Assertion, error)

	// WriteAssertions remplace les assertions pour un authorization model
	// dans le store identifié.
	WriteAssertions(ctx context.Context, storeID, authorizationModelID string, assertions []openfga.Assertion) error

	// ReadAuthorizationModel renvoie un authorization model spécifique
	// par son ID dans le store identifié.
	ReadAuthorizationModel(ctx context.Context, storeID, id string) (map[string]any, error)
}

// Compile-time assertion : *Client implémente OpenFGA.
var _ OpenFGA = (*Client)(nil)

// Query complète une requête Check / ListObjects / ListUsers.
type Query struct {
	// Context : variables des conditions CEL.
	Context map[string]any
	// Contextual : tuples valables pour cette seule requête (non écrits),
	// par exemple l'appartenance à un groupe tirée d'un jeton.
	Contextual []models.Tuple
}
