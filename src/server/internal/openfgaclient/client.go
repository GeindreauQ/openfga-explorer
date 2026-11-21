// Package openfgaclient encapsule le SDK OpenFGA officiel
// (github.com/openfga/go-sdk) derrière une façade stable utilisée par les
// controllers. Tous les échanges HTTP, retries et sérialisations sont
// délégués au SDK ; ce package ne fait que :
//
//   - mapper les modèles OpenFGA (Store, Tuple, AuthorizationModel) vers
//     les types internes du projet (models.Tuple, models.Store) ;
//   - traduire les erreurs SDK en *apperr.Error pour les controllers ;
//   - passer à chaque requête le store qu'elle vise (option StoreId du
//     SDK) : aucun état partagé, les appels concurrents sont indépendants.
//
// Aucune logique métier ici : c'est une couche d'adaptation fine. Ajouter
// une nouvelle méthode = un appel SDK + une traduction d'erreur.
//
// Store visé par un appel :
//
//   - storeID passé à la méthode : celui du navigateur appelant (session,
//     ou cookie de sélection quand l'authentification est désactivée) ;
//   - defaultStoreID sinon : premier store disponible, posé au démarrage.
package openfgaclient

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	openfga "github.com/openfga/go-sdk"
	fgaSdkClient "github.com/openfga/go-sdk/client"
	"github.com/openfga/go-sdk/credentials"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// Client est le client OpenFGA utilisé par les controllers. Il encapsule
// le SDK officiel et gère l'état mutable du store ID (default + per-call).
type Client struct {
	sdk *fgaSdkClient.OpenFgaClient

	// defaultStoreID est le store de fallback (cf. doc du package).
	muDefault      sync.RWMutex
	defaultStoreID string
}

// New construit le client OpenFGA à partir de l'URL et du token.
// Le default store ID est vide au démarrage ; il est posé au boot par
// main.go bootstrapStore avec le premier store disponible.
//
// Token peut être vide (pas d'auth) ou un Bearer brut (sans préfixe).
// oauth, s'il est fourni, remplace le token : chaque requête porte un jeton
// OAuth2 obtenu par client_credentials (OpenFGA en authn.method: oidc).
func New(apiURL, token string, oauth *ClientCredentials) (*Client, error) {
	cfg := &fgaSdkClient.ClientConfiguration{
		ApiUrl: strings.TrimRight(apiURL, "/"),
		Debug:  false,
		RetryParams: &openfga.RetryParams{
			MaxRetry:    3,
			MinWaitInMs: 100,
		},
	}
	if oauth != nil {
		cfg.HTTPClient = &http.Client{Transport: oauth}
	} else if token != "" {
		cfg.Credentials = &credentials.Credentials{
			Method: credentials.CredentialsMethodApiToken,
			Config: &credentials.Config{ApiToken: strings.TrimPrefix(token, "Bearer ")},
		}
	}
	sdk, err := fgaSdkClient.NewSdkClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("openfga sdk init: %w", err)
	}
	return &Client{sdk: sdk}, nil
}

// DefaultStoreID renvoie le store de fallback. Lecture concurrente safe.
func (c *Client) DefaultStoreID() string {
	c.muDefault.RLock()
	defer c.muDefault.RUnlock()
	return c.defaultStoreID
}

// SetDefaultStoreID pose le store de fallback.
func (c *Client) SetDefaultStoreID(id string) {
	c.muDefault.Lock()
	c.defaultStoreID = id
	c.muDefault.Unlock()
}

// resolveStoreID résout le storeID effectif : si la valeur passée est
// non-vide, on l'utilise, sinon on tombe sur defaultStoreID.
func (c *Client) resolveStoreID(storeID string) string {
	if storeID != "" {
		return storeID
	}
	return c.DefaultStoreID()
}

// withStore résout le store de l'appel et le passe à fn, qui le donne au
// SDK requête par requête (option StoreId) : les appels concurrents sur
// des stores différents ne partagent aucun état et ne s'attendent pas.
// Si aucun store n'est résolu, fn n'est pas appelée et
// ErrNoStoreSelected est retourné.
func (c *Client) withStore(storeID string, fn func(storeID string) error) error {
	effective := c.resolveStoreID(storeID)
	if effective == "" {
		return apperr.ErrNoStoreSelected
	}
	return fn(effective)
}

// expandFunc appelle Expand sur un store déjà résolu.
type expandFunc func(ctx context.Context, relation, object string) (*openfga.UsersetTree, error)

// ── Stores ─────────────────────────────────────────────────────────────────

// Ping vérifie la joignabilité de l'instance OpenFGA et la validité du
// token. On s'appuie sur ListStores : c'est l'appel le plus léger qui
// exerce simultanément connectivité HTTP, auth (token) et compat API.
func (c *Client) Ping(ctx context.Context) error {
	resp, err := c.sdk.ListStores(ctx).Options(fgaSdkClient.ClientListStoresOptions{}).Execute()
	if err != nil {
		return translateErr(err, "ping openfga")
	}
	_ = resp
	return nil
}

// ListStores renvoie tous les stores existants sur l'instance.
func (c *Client) ListStores(ctx context.Context) ([]models.Store, error) {
	resp, err := c.sdk.ListStores(ctx).Options(fgaSdkClient.ClientListStoresOptions{}).Execute()
	if err != nil {
		return nil, translateErr(err, "list stores")
	}
	out := make([]models.Store, 0, len(resp.Stores))
	for _, s := range resp.Stores {
		out = append(out, models.Store{ID: s.Id, Name: s.Name})
	}
	return out, nil
}

// ── Tuples ────────────────────────────────────────────────────────────────

// ReadAllTuples récupère l'intégralité des tuples du store en paginant.
func (c *Client) ReadAllTuples(ctx context.Context, storeID string) ([]models.Tuple, error) {
	var all []models.Tuple
	err := c.withStore(storeID, func(id string) error {
		var err error
		all, err = c.readAllTuples(ctx, id)
		return err
	})
	return all, err
}

// readAllTuples lit tous les tuples d'un store résolu, page par page.
func (c *Client) readAllTuples(ctx context.Context, storeID string) ([]models.Tuple, error) {
	all := []models.Tuple{}
	const pageSize = 100
	var token string
	for {
		opts := fgaSdkClient.ClientReadOptions{PageSize: ptrInt32(pageSize), StoreId: &storeID}
		if token != "" {
			opts.ContinuationToken = &token
		}
		resp, err := c.sdk.Read(ctx).Options(opts).Execute()
		if err != nil {
			return nil, translateErr(err, "read tuples")
		}
		for _, t := range resp.Tuples {
			all = append(all, models.Tuple{
				User:     t.Key.User,
				Relation: t.Key.Relation,
				Object:   t.Key.Object,
			})
		}
		token = resp.ContinuationToken
		if token == "" {
			return all, nil
		}
	}
}

// Write applique des écritures et/ou suppressions de tuples sur le store.
func (c *Client) Write(ctx context.Context, storeID string, writes, deletes []models.Tuple) error {
	if len(writes) == 0 && len(deletes) == 0 {
		return apperr.New(http.StatusBadRequest, "aucune écriture ni suppression fournie")
	}
	return c.withStore(storeID, func(id string) error {
		body := fgaSdkClient.ClientWriteRequest{}
		for _, t := range writes {
			body.Writes = append(body.Writes, fgaSdkClient.ClientTupleKey{
				User: t.User, Relation: t.Relation, Object: t.Object,
			})
		}
		for _, t := range deletes {
			body.Deletes = append(body.Deletes, fgaSdkClient.ClientTupleKeyWithoutCondition{
				User: t.User, Relation: t.Relation, Object: t.Object,
			})
		}
		_, err := c.sdk.Write(ctx).Body(body).Options(fgaSdkClient.ClientWriteOptions{StoreId: &id}).Execute()
		if err != nil {
			return translateErr(err, "write tuples")
		}
		return nil
	})
}

// ── Authorization models ──────────────────────────────────────────────────

// WriteAuthorizationModelRaw envoie un authorization model brut au store.
func (c *Client) WriteAuthorizationModelRaw(ctx context.Context, storeID, schemaVersion string, typeDefs []openfga.TypeDefinition, conditions *map[string]openfga.Condition) (string, error) {
	if schemaVersion == "" {
		schemaVersion = "1.1"
	}
	var modelID string
	err := c.withStore(storeID, func(id string) error {
		body := openfga.WriteAuthorizationModelRequest{
			SchemaVersion:   schemaVersion,
			TypeDefinitions: typeDefs,
		}
		if conditions != nil {
			body.Conditions = conditions
		}
		resp, err := c.sdk.WriteAuthorizationModel(ctx).Body(body).
			Options(fgaSdkClient.ClientWriteAuthorizationModelOptions{StoreId: &id}).Execute()
		if err != nil {
			return translateErr(err, "write authorization model")
		}
		modelID = resp.AuthorizationModelId
		return nil
	})
	return modelID, err
}

// ListAuthorizationModels renvoie les authorization models du store, du
// plus récent au plus ancien.
func (c *Client) ListAuthorizationModels(ctx context.Context, storeID string) ([]map[string]any, error) {
	var out []map[string]any
	err := c.withStore(storeID, func(id string) error {
		resp, err := c.sdk.ReadAuthorizationModels(ctx).
			Options(fgaSdkClient.ClientReadAuthorizationModelsOptions{StoreId: &id}).Execute()
		if err != nil {
			return translateErr(err, "list authorization models")
		}
		out = make([]map[string]any, 0, len(resp.AuthorizationModels))
		for _, m := range resp.AuthorizationModels {
			out = append(out, map[string]any{
				"id":               m.Id,
				"schema_version":   m.SchemaVersion,
				"type_definitions": m.TypeDefinitions,
				"conditions":       m.Conditions,
			})
		}
		return nil
	})
	return out, err
}

// ReadAuthorizationModel renvoie un authorization model spécifique par ID.
func (c *Client) ReadAuthorizationModel(ctx context.Context, storeID, id string) (map[string]any, error) {
	var out map[string]any
	err := c.withStore(storeID, func(store string) error {
		opts := fgaSdkClient.ClientReadAuthorizationModelOptions{
			AuthorizationModelId: &id,
			StoreId:              &store,
		}
		resp, err := c.sdk.ReadAuthorizationModel(ctx).Options(opts).Execute()
		if err != nil {
			return translateErr(err, "read authorization model")
		}
		if resp == nil || resp.AuthorizationModel == nil {
			return apperr.New(http.StatusNotFound, "authorization model not found")
		}
		m := resp.AuthorizationModel
		out = map[string]any{
			"id":               m.Id,
			"schema_version":   m.SchemaVersion,
			"type_definitions": m.TypeDefinitions,
			"conditions":       m.Conditions,
		}
		return nil
	})
	return out, err
}

// ── Audit (Check / ListObjects / ListUsers / Expand) ──────────────────────

// Check demande à OpenFGA si `user` a `relation` sur `object`.
func (c *Client) Check(ctx context.Context, storeID, user, relation, object string, q Query) (bool, error) {
	var allowed bool
	err := c.withStore(storeID, func(id string) error {
		body := fgaSdkClient.ClientCheckRequest{
			User:     user,
			Relation: relation,
			Object:   object,
		}
		if q.Context != nil {
			body.Context = &q.Context
		}
		body.ContextualTuples = q.contextual()
		resp, err := c.sdk.Check(ctx).Body(body).Options(fgaSdkClient.ClientCheckOptions{StoreId: &id}).Execute()
		if err != nil {
			return translateErr(err, "check")
		}
		if resp.Allowed != nil {
			allowed = *resp.Allowed
		}
		return nil
	})
	return allowed, err
}

// ListObjects renvoie tous les `objects` du type `objectType` que
// `user` peut atteindre via `relation`.
func (c *Client) ListObjects(ctx context.Context, storeID, user, relation, objectType string, q Query) ([]string, error) {
	var objects []string
	err := c.withStore(storeID, func(id string) error {
		body := fgaSdkClient.ClientListObjectsRequest{
			User:     user,
			Relation: relation,
			Type:     objectType,
		}
		if q.Context != nil {
			body.Context = &q.Context
		}
		body.ContextualTuples = q.contextual()
		resp, err := c.sdk.ListObjects(ctx).Body(body).Options(fgaSdkClient.ClientListObjectsOptions{StoreId: &id}).Execute()
		if err != nil {
			return translateErr(err, "list-objects")
		}
		objects = resp.Objects
		return nil
	})
	return objects, err
}

// ListUsers renvoie tous les users qui ont `relation` sur `object` dans le store.
func (c *Client) ListUsers(ctx context.Context, storeID, object, relation string, userTypeFilter []openfga.UserTypeFilter, q Query) ([]openfga.User, error) {
	var users []openfga.User
	err := c.withStore(storeID, func(id string) error {
		body := fgaSdkClient.ClientListUsersRequest{
			Object:      openfga.FgaObject{Type: typeFromObject(object), Id: idFromObject(object)},
			Relation:    relation,
			UserFilters: userTypeFilter,
		}
		if q.Context != nil {
			body.Context = &q.Context
		}
		body.ContextualTuples = q.contextual()
		resp, err := c.sdk.ListUsers(ctx).Body(body).Options(fgaSdkClient.ClientListUsersOptions{StoreId: &id}).Execute()
		if err != nil {
			return translateErr(err, "list-users")
		}
		users = resp.Users
		return nil
	})
	return users, err
}

// Expand renvoie les tuples qui matérialisent le chemin de résolution
// entre `user` et `object` via `relation` dans le store.
//
// Implémentation : on utilise l'endpoint natif OpenFGA Expand plutôt
// qu'un DFS maison, pour profiter automatiquement de toutes les
// subtilités du DSL ; walkLeaf retrouve ensuite les tuples du chemin.
func (c *Client) Expand(ctx context.Context, storeID, user, relation, object string) ([]openfga.TupleKey, error) {
	if relation == "" || object == "" {
		return nil, nil
	}
	var result []openfga.TupleKey
	err := c.withStore(storeID, func(id string) error {
		expand := expandFunc(func(ctx context.Context, relation, object string) (*openfga.UsersetTree, error) {
			return c.expandNative(ctx, id, relation, object)
		})
		tree, err := expand(ctx, relation, object)
		if err != nil {
			return err
		}
		if tree == nil || tree.Root == nil {
			result = nil
			return nil
		}
		allTuples, err := c.readAllTuples(ctx, id)
		if err != nil {
			return translateErr(err, "expand")
		}
		tuplesByUser := make(map[string][]models.Tuple)
		for _, t := range allTuples {
			tuplesByUser[t.User] = append(tuplesByUser[t.User], t)
		}
		var foundPath []openfga.TupleKey
		var found bool
		var walk func(n *openfga.Node) bool
		walk = func(n *openfga.Node) bool {
			if n == nil || found {
				return found
			}
			if n.Leaf != nil {
				return walkLeaf(ctx, n.Leaf, relation, object, allTuples, tuplesByUser, user, &foundPath, &found, expand)
			}
			if n.Difference != nil {
				baseNode := n.Difference.Base
				subNode := n.Difference.Subtract
				if walk(&baseNode) {
					return true
				}
				return walk(&subNode)
			}
			if n.Union != nil {
				for _, child := range n.Union.Nodes {
					if walk(&child) {
						return true
					}
				}
				return false
			}
			if n.Intersection != nil {
				for _, child := range n.Intersection.Nodes {
					if !walk(&child) {
						return false
					}
				}
				return true
			}
			return false
		}
		walk(tree.Root)
		if !found {
			result = nil
			return nil
		}
		for i, j := 0, len(foundPath)-1; i < j; i, j = i+1, j-1 {
			foundPath[i], foundPath[j] = foundPath[j], foundPath[i]
		}
		result = foundPath
		return nil
	})
	return result, err
}

// expandNative appelle l'endpoint natif OpenFGA Expand sur un store résolu.
func (c *Client) expandNative(ctx context.Context, storeID, relation, object string) (*openfga.UsersetTree, error) {
	resp, err := c.sdk.Expand(ctx).Body(fgaSdkClient.ClientExpandRequest{
		Relation: relation,
		Object:   object,
	}).Options(fgaSdkClient.ClientExpandOptions{StoreId: &storeID}).Execute()
	if err != nil {
		return nil, translateErr(err, "expand")
	}
	if resp == nil || resp.Tree == nil {
		return nil, nil
	}
	return resp.Tree, nil
}

// walkLeaf explore une feuille du UsersetTree (utilisateurs directs,
// usersets, wildcards) et reconstruit le chemin de tuples vers `user`.
func walkLeaf(ctx context.Context, l *openfga.Leaf, relation, object string, allTuples []models.Tuple, tuplesByUser map[string][]models.Tuple, user string, foundPath *[]openfga.TupleKey, found *bool, expand expandFunc) bool {
	if *found {
		return true
	}
	if l.Users != nil {
		for _, u := range l.Users.Users {
			if u == user {
				for _, t := range tuplesByUser[u] {
					if t.Relation == relation && (t.Object == object || isObjectUsersetFor(t.Object, object, relation)) {
						*foundPath = append(*foundPath, openfga.TupleKey{
							User: t.User, Relation: t.Relation, Object: t.Object,
						})
						*found = true
						return true
					}
				}
				continue
			}
			if isUserset(u) {
				us := parseUserset(u)
				if us == nil {
					continue
				}
				connector := findTuple(allTuples, user, us.rel, us.object)
				if connector == nil {
					continue
				}
				target := findTuple(allTuples, u, relation, object)
				if target == nil {
					target = findTupleWhereUserMatchesAndObjectIsUserset(allTuples, u, relation, object)
				}
				if target == nil {
					continue
				}
				*foundPath = append(*foundPath,
					openfga.TupleKey{User: connector.User, Relation: connector.Relation, Object: connector.Object},
					openfga.TupleKey{User: target.User, Relation: target.Relation, Object: target.Object},
				)
				*found = true
				return true
			}
			if isWildcard(u) {
				target := findTuple(allTuples, u, relation, object)
				if target == nil {
					continue
				}
				*foundPath = append(*foundPath, openfga.TupleKey{
					User: target.User, Relation: target.Relation, Object: target.Object,
				})
				*found = true
				return true
			}
		}
		return false
	}
	if l.Computed != nil {
		us := parseUserset(l.Computed.Userset)
		if us == nil {
			return false
		}
		// Note : cet appel récursif enfreint la règle du mutex mais il
		// est déjà tenu par Expand() — pas de re-entrée possible puisque
		// la goroutine est la même. ctx est propagé depuis Expand()
		// pour conserver deadline + annulation côté client.
		sub, err := expand(ctx, us.rel, us.object)
		if err != nil || sub == nil || sub.Root == nil {
			return false
		}
		return walkNodeInto(ctx, sub.Root, us.rel, us.object, allTuples, tuplesByUser, user, foundPath, found, expand)
	}
	if l.TupleToUserset != nil {
		for _, comp := range l.TupleToUserset.Computed {
			if comp.Userset == "" {
				continue
			}
			us := parseUserset(comp.Userset)
			if us == nil {
				continue
			}
			sub, err := expand(ctx, us.rel, us.object)
			if err != nil || sub == nil || sub.Root == nil {
				continue
			}
			if walkNodeInto(ctx, sub.Root, us.rel, us.object, allTuples, tuplesByUser, user, foundPath, found, expand) {
				return true
			}
		}
		return false
	}
	return false
}

func walkNodeInto(ctx context.Context, n *openfga.Node, relation, object string, allTuples []models.Tuple, tuplesByUser map[string][]models.Tuple, user string, foundPath *[]openfga.TupleKey, found *bool, expand expandFunc) bool {
	if n == nil || *found {
		return *found
	}
	if n.Leaf != nil {
		return walkLeaf(ctx, n.Leaf, relation, object, allTuples, tuplesByUser, user, foundPath, found, expand)
	}
	if n.Difference != nil {
		baseNode := n.Difference.Base
		subNode := n.Difference.Subtract
		if walkNodeInto(ctx, &baseNode, relation, object, allTuples, tuplesByUser, user, foundPath, found, expand) {
			return true
		}
		return walkNodeInto(ctx, &subNode, relation, object, allTuples, tuplesByUser, user, foundPath, found, expand)
	}
	if n.Union != nil {
		for _, child := range n.Union.Nodes {
			if walkNodeInto(ctx, &child, relation, object, allTuples, tuplesByUser, user, foundPath, found, expand) {
				return true
			}
		}
		return false
	}
	if n.Intersection != nil {
		for _, child := range n.Intersection.Nodes {
			if !walkNodeInto(ctx, &child, relation, object, allTuples, tuplesByUser, user, foundPath, found, expand) {
				return false
			}
		}
		return true
	}
	return false
}

// ── Assertions ────────────────────────────────────────────────────────────

// ReadAssertions lit les assertions d'un authorization model dans le store.
func (c *Client) ReadAssertions(ctx context.Context, storeID, authorizationModelID string) ([]openfga.Assertion, error) {
	var result []openfga.Assertion
	err := c.withStore(storeID, func(id string) error {
		opts := fgaSdkClient.ClientReadAssertionsOptions{
			AuthorizationModelId: &authorizationModelID,
			StoreId:              &id,
		}
		resp, err := c.sdk.ReadAssertions(ctx).Options(opts).Execute()
		if err != nil {
			return translateErr(err, "read assertions")
		}
		if resp == nil || resp.Assertions == nil {
			result = []openfga.Assertion{}
			return nil
		}
		result = *resp.Assertions
		return nil
	})
	return result, err
}

// WriteAssertions écrit (remplace) les assertions d'un authorization model
// dans le store.
func (c *Client) WriteAssertions(ctx context.Context, storeID, authorizationModelID string, assertions []openfga.Assertion) error {
	return c.withStore(storeID, func(id string) error {
		opts := fgaSdkClient.ClientWriteAssertionsOptions{
			AuthorizationModelId: &authorizationModelID,
			StoreId:              &id,
		}
		body := make(fgaSdkClient.ClientWriteAssertionsRequest, 0, len(assertions))
		for _, a := range assertions {
			body = append(body, fgaSdkClient.ClientAssertion{
				User:        a.TupleKey.User,
				Relation:    a.TupleKey.Relation,
				Object:      a.TupleKey.Object,
				Expectation: a.Expectation,
			})
		}
		_, err := c.sdk.WriteAssertions(ctx).Body(body).Options(opts).Execute()
		if err != nil {
			return translateErr(err, "write assertions")
		}
		return nil
	})
}

// ── Traduction d'erreurs ──────────────────────────────────────────────────

// translateErr convertit une erreur du SDK en *apperr.Error avec un code
// HTTP sémantiquement correct. Le frontend reçoit un JSON `{"error":"…"}`
// uniforme et peut afficher le message directement.
func translateErr(err error, op string) *apperr.Error {
	if err == nil {
		return nil
	}
	var authErr openfga.FgaApiAuthenticationError
	var notFoundErr openfga.FgaApiNotFoundError
	var validationErr openfga.FgaApiValidationError
	var rateLimitErr openfga.FgaApiRateLimitExceededError
	var internalErr openfga.FgaApiInternalError

	switch {
	case errors.As(err, &authErr):
		return apperr.New(http.StatusBadGateway, op+": "+err.Error())
	case errors.As(err, &notFoundErr):
		return apperr.New(http.StatusNotFound, op+": "+err.Error())
	case errors.As(err, &validationErr):
		return apperr.New(http.StatusBadRequest, op+": "+err.Error())
	case errors.As(err, &rateLimitErr):
		return apperr.New(http.StatusTooManyRequests, op+": "+err.Error())
	case errors.As(err, &internalErr):
		return apperr.New(http.StatusBadGateway, op+": "+err.Error())
	}

	return apperr.New(http.StatusBadGateway, op+": "+err.Error())
}

// ── Helpers OpenFGA object parsing ────────────────────────────────────────

// typeFromObject extrait le type d'un identifiant OpenFGA "type:id".
func typeFromObject(obj string) string {
	for i, c := range obj {
		if c == ':' {
			return obj[:i]
		}
	}
	return obj
}

func idFromObject(obj string) string {
	for i, c := range obj {
		if c == ':' {
			id := obj[i+1:]
			for j, c2 := range id {
				if c2 == '#' {
					return id[:j]
				}
			}
			return id
		}
	}
	return obj
}

func isObjectUsersetFor(tupleObject, apiObject, apiRelation string) bool {
	idx := indexOfString(tupleObject, "#")
	if idx < 0 {
		return false
	}
	base := tupleObject[:idx]
	rel := tupleObject[idx+1:]
	return base == apiObject && rel == apiRelation
}

func findTuple(allTuples []models.Tuple, subject, relation, object string) *models.Tuple {
	for i := range allTuples {
		t := &allTuples[i]
		if t.User == subject && t.Relation == relation && t.Object == object {
			return t
		}
	}
	return nil
}

func findTupleWhereUserMatchesAndObjectIsUserset(allTuples []models.Tuple, subject, relation, object string) *models.Tuple {
	for i := range allTuples {
		t := &allTuples[i]
		if t.User == subject && t.Relation == relation && isObjectUsersetFor(t.Object, object, relation) {
			return t
		}
	}
	return nil
}

func indexOfString(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func isUserset(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == '#' {
			return true
		}
	}
	return false
}

func isWildcard(s string) bool {
	return len(s) >= 2 && s[len(s)-1] == '*'
}

type parsedUserset struct {
	object string
	rel    string
}

func parseUserset(s string) *parsedUserset {
	for i := 0; i < len(s); i++ {
		if s[i] == '#' {
			return &parsedUserset{object: s[:i], rel: s[i+1:]}
		}
	}
	return nil
}

func ptrInt32(v int32) *int32 { return &v }

func (q Query) contextual() []fgaSdkClient.ClientContextualTupleKey {
	if len(q.Contextual) == 0 {
		return nil
	}
	out := make([]fgaSdkClient.ClientContextualTupleKey, 0, len(q.Contextual))
	for _, t := range q.Contextual {
		out = append(out, fgaSdkClient.ClientContextualTupleKey{User: t.User, Relation: t.Relation, Object: t.Object})
	}
	return out
}
