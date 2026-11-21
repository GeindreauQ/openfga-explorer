// Package controllers — AuditController.
//
// Expose 3 endpoints qui couvrent le triplet Check / ListObjects /
// ListUsers du SDK OpenFGA. Tous acceptent un body JSON et renvoient
// du JSON.
//
//	POST /api/audit/check         {user, relation, object, context?}
//	POST /api/audit/list-objects  {user, relation, type, context?}
//	POST /api/audit/list-users    {object, relation, user_type, context?}
//
// Le champ `context` (optionnel) permet d'évaluer les conditions CEL :
// il est transmis tel quel à OpenFGA via le SDK.
package controllers

import (
	"encoding/json"
	"net/http"

	openfga "github.com/openfga/go-sdk"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// AuditController gère les endpoints d'audit (Check / ListObjects /
// ListUsers).
type AuditController struct {
	openfga openfgaclient.OpenFGA
}

// Compile-time assertion que *openfgaclient.Client implémente
// openfgaclient.OpenFGA.
var _ openfgaclient.OpenFGA = (*openfgaclient.Client)(nil)

// NewAuditController crée le contrôleur d'audit.
func NewAuditController(openfga openfgaclient.OpenFGA) *AuditController {
	return &AuditController{openfga: openfga}
}

// auditCheckRequest est le body de POST /api/audit/check.
type auditCheckRequest struct {
	User     string         `json:"user"`
	Relation string         `json:"relation"`
	Object   string         `json:"object"`
	Context  map[string]any `json:"context,omitempty"`
	// ContextualTuples : tuples valables pour cette seule requête.
	ContextualTuples []models.Tuple `json:"contextual_tuples,omitempty"`
}

// auditListObjectsRequest est le body de POST /api/audit/list-objects.
type auditListObjectsRequest struct {
	User     string         `json:"user"`
	Relation string         `json:"relation"`
	Type     string         `json:"type"`
	Context  map[string]any `json:"context,omitempty"`
	// ContextualTuples : tuples valables pour cette seule requête.
	ContextualTuples []models.Tuple `json:"contextual_tuples,omitempty"`
}

// auditListUsersRequest est le body de POST /api/audit/list-users.
type auditListUsersRequest struct {
	Object   string `json:"object"`
	Relation string `json:"relation"`
	UserType string `json:"user_type"`
	// UserRelation : filtre sur un userset (group#member) plutôt que sur
	// des objets simples.
	UserRelation string         `json:"user_relation,omitempty"`
	Context      map[string]any `json:"context,omitempty"`
	// ContextualTuples : tuples valables pour cette seule requête.
	ContextualTuples []models.Tuple `json:"contextual_tuples,omitempty"`
}

// Check traite POST /api/audit/check. Renvoie `{allowed: true|false}`.
// La résolution OpenFGA (via quelle relation l'accès a été accordé) est
// incluse si présente, utile pour comprendre pourquoi l'accès est
// refusé.
func (c *AuditController) Check(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req auditCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.User == "" || req.Relation == "" || req.Object == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "user, relation et object sont requis"))
		return
	}
	allowed, err := c.openfga.Check(r.Context(), effectiveStoreID(r, c.openfga), req.User, req.Relation, req.Object, openfgaclient.Query{Context: req.Context, Contextual: req.ContextualTuples})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"allowed": allowed,
		"tuple":   req,
	})
}

// ListObjects traite POST /api/audit/list-objects. Renvoie
// `{objects: ["type:id", ...]}`. Les objets sont ordonnés par le SDK.
func (c *AuditController) ListObjects(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req auditListObjectsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.User == "" || req.Relation == "" || req.Type == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "user, relation et type sont requis"))
		return
	}
	objects, err := c.openfga.ListObjects(r.Context(), effectiveStoreID(r, c.openfga), req.User, req.Relation, req.Type, openfgaclient.Query{Context: req.Context, Contextual: req.ContextualTuples})
	if err != nil {
		writeError(w, err)
		return
	}
	if objects == nil {
		objects = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"objects": objects,
		"count":   len(objects),
	})
}

// ListUsers traite POST /api/audit/list-users. Renvoie
// `{users: [{object:{type,id}, userset?:{...}, wildcard?:{...}}]}`.
// Chaque `User` est sérialisé tel quel depuis le SDK (objet simple,
// userset, ou wildcard `user:*`).
func (c *AuditController) ListUsers(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req auditListUsersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.Object == "" || req.Relation == "" || req.UserType == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "object, relation et user_type sont requis"))
		return
	}
	filter := []openfga.UserTypeFilter{{Type: req.UserType}}
	if req.UserRelation != "" {
		filter[0].Relation = &req.UserRelation
	}
	users, err := c.openfga.ListUsers(r.Context(), effectiveStoreID(r, c.openfga), req.Object, req.Relation, filter, openfgaclient.Query{Context: req.Context, Contextual: req.ContextualTuples})
	if err != nil {
		writeError(w, err)
		return
	}
	if users == nil {
		users = []openfga.User{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users": users,
		"count": len(users),
	})
}

// auditExpandRequest est le body de POST /api/audit/expand.
type auditExpandRequest struct {
	User     string `json:"user"`
	Relation string `json:"relation"`
	Object   string `json:"object"`
}

// Expand traite POST /api/audit/expand. Renvoie le chemin de
// résolution (suite de tuples) qui explique pourquoi `user#relation@object`
// est autorisé (ou pas). `resolved` est `true` si un chemin a été
// trouvé, `false` sinon (incluant "accès refusé car aucun tuple
// correspondant n'existe"). Chaque tuple est un TupleKey du SDK
// (user, relation, object).
func (c *AuditController) Expand(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req auditExpandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.User == "" || req.Relation == "" || req.Object == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "user, relation et object sont requis"))
		return
	}
	tuples, err := c.openfga.Expand(r.Context(), effectiveStoreID(r, c.openfga), req.User, req.Relation, req.Object)
	if err != nil {
		writeError(w, err)
		return
	}
	if tuples == nil {
		tuples = []openfga.TupleKey{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tuples":   tuples,
		"resolved": len(tuples) > 0,
	})
}
