// controllers/assertions.go — Assertions (tests unitaires du modèle).
//
// Les assertions OpenFGA permettent de définir des cas de test :
//
//	(user, relation, object) → {allowed: true/false}
//
// et de les évaluer contre le authorization model actif. C'est
// l'équivalent des tests unitaires pour un modèle d'autorisation.
//
// Routes :
//
//	GET  /api/assertions             → liste les assertions du modèle actif
//	POST /api/assertions             → écrit (remplace) les assertions
//	POST /api/assertions/check       → évalue une assertion via Check
package controllers

import (
	"encoding/json"
	"net/http"

	openfga "github.com/openfga/go-sdk"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
)

// AssertionsController gère /api/assertions.
type AssertionsController struct {
	openfga openfgaclient.OpenFGA
}

// NewAssertionsController crée le controller.
func NewAssertionsController(openfga openfgaclient.OpenFGA) *AssertionsController {
	return &AssertionsController{openfga: openfga}
}

// Get renvoie les assertions du dernier authorization model.
// GET /api/assertions?authorization_model_id=xxx
func (c *AssertionsController) Get(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	modelID := r.URL.Query().Get("authorization_model_id")
	assertions, err := c.openfga.ReadAssertions(r.Context(), storeID, modelID)
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusBadGateway, err))
		return
	}
	if assertions == nil {
		assertions = []openfga.Assertion{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"assertions": assertions,
	})
}

// Write remplace toutes les assertions du modèle actif.
// POST /api/assertions  body: { authorization_model_id: "...", assertions: [...] }
func (c *AssertionsController) Write(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	var body struct {
		AuthorizationModelID string              `json:"authorization_model_id"`
		Assertions           []openfga.Assertion `json:"assertions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "body JSON invalide: "+err.Error()))
		return
	}
	if body.AuthorizationModelID == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "authorization_model_id requis"))
		return
	}
	if len(body.Assertions) == 0 {
		writeError(w, apperr.New(http.StatusBadRequest, "au moins une assertion requise"))
		return
	}
	if err := c.openfga.WriteAssertions(r.Context(), storeID, body.AuthorizationModelID, body.Assertions); err != nil {
		writeError(w, apperr.Wrap(http.StatusBadGateway, err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"written": len(body.Assertions),
	})
}

// Check évalue une assertion unique via l'endpoint Check d'OpenFGA.
// POST /api/assertions/check  body: { user, relation, object }
func (c *AssertionsController) Check(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	var body struct {
		User     string         `json:"user"`
		Relation string         `json:"relation"`
		Object   string         `json:"object"`
		Context  map[string]any `json:"context,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "body JSON invalide: "+err.Error()))
		return
	}
	if body.User == "" || body.Relation == "" || body.Object == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "user, relation et object requis"))
		return
	}
	allowed, err := c.openfga.Check(r.Context(), storeID, body.User, body.Relation, body.Object, openfgaclient.Query{Context: body.Context})
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusBadGateway, err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":     body.User,
		"relation": body.Relation,
		"object":   body.Object,
		"allowed":  allowed,
	})
}
