package controllers

import (
	"encoding/json"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// TuplesController gère /api/tuples (GET / POST / DELETE).
//
// `broker` est optionnel : s'il est nil, les écritures/suppressions
// ne sont pas publiées (utile pour les tests unitaires et pour les
// setups qui n'exposent pas SSE). En prod, il est toujours non-nil
// (cf. main.go).
type TuplesController struct {
	openfga openfgaclient.OpenFGA
	broker  *EventBroker
}

func NewTuplesController(openfga openfgaclient.OpenFGA, broker *EventBroker) *TuplesController {
	return &TuplesController{openfga: openfga, broker: broker}
}

type tupleRequest struct {
	Tuples []models.Tuple `json:"tuples"`
}

func (c *TuplesController) List(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	tuples, err := c.openfga.ReadAllTuples(r.Context(), storeID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tuples": tuples})
}

func (c *TuplesController) Write(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req tupleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if len(req.Tuples) == 0 {
		writeError(w, apperr.New(http.StatusBadRequest, "aucun tuple à écrire"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if err := c.openfga.Write(r.Context(), storeID, req.Tuples, nil); err != nil {
		writeError(w, err)
		return
	}
	// Publication SSE — best-effort (non-bloquant, drop si pas d'abonné).
	c.publishWrite(storeID, req.Tuples)
	writeJSON(w, http.StatusOK, map[string]any{"written": len(req.Tuples)})
}

func (c *TuplesController) Delete(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req tupleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if len(req.Tuples) == 0 {
		writeError(w, apperr.New(http.StatusBadRequest, "aucun tuple à supprimer"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if err := c.openfga.Write(r.Context(), storeID, nil, req.Tuples); err != nil {
		writeError(w, err)
		return
	}
	c.publishWrite(storeID, req.Tuples)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": len(req.Tuples)})
}

// publishWrite envoie un événement SSE après une mutation de tuples.
// storeID est passé explicitement (vs l'ancien modèle qui le lisait
// depuis le client global) pour rester cohérent avec le scoping
// per-user de la requête.
func (c *TuplesController) publishWrite(storeID string, tuples []models.Tuple) {
	if c.broker == nil {
		return
	}
	c.broker.Publish(Event{
		Type:    "tuples.write",
		StoreID: storeID,
		Count:   len(tuples),
		Source:  "manual",
	})
}
