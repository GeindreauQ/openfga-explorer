package controllers

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// StoresController gère /api/stores (liste + switch à chaud).
type StoresController struct {
	openfga openfgaclient.OpenFGA
	// secureCookies pose Secure sur le cookie de sélection du store
	// (authentification désactivée).
	secureCookies bool
}

func NewStoresController(openfga openfgaclient.OpenFGA, secureCookies bool) *StoresController {
	return &StoresController{openfga: openfga, secureCookies: secureCookies}
}

// List renvoie la liste des stores OpenFGA. Le store actif est marqué.
// Le "store actif" est désormais le store de l'utilisateur courant
// (session) ou, en mode AUTH_DISABLED, le default du client.
func (c *StoresController) List(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	stores, err := c.openfga.ListStores(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	currentID := effectiveStoreID(r, c.openfga)
	out := make([]models.StoreRef, 0, len(stores))
	for _, st := range stores {
		out = append(out, models.StoreRef{
			ID:     st.ID,
			Name:   st.Name,
			Active: st.ID == currentID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"stores": out})
}

type selectRequest struct {
	StoreID string `json:"storeId"`
}

// Select change le store actif après vérification de son existence. Le
// choix est propre au navigateur : rangé dans la session, ou dans un
// cookie quand l'authentification est désactivée.
//
// Un storeId vide ("") désélectionne : on log côté serveur et on
// signale "aucun store actif" à l'UI.
func (c *StoresController) Select(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req selectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.StoreID == "" {
		log.Printf("stores: deselect requested by %s", r.RemoteAddr)
		c.applyStoreChange(w, r, "")
		writeJSON(w, http.StatusOK, map[string]any{
			"storeId":   "",
			"storeName": "",
		})
		return
	}
	stores, err := c.openfga.ListStores(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	found := false
	var foundName string
	for _, st := range stores {
		if st.ID == req.StoreID {
			found = true
			foundName = st.Name
			break
		}
	}
	if !found {
		writeError(w, apperr.New(http.StatusNotFound, "store introuvable: "+req.StoreID))
		return
	}
	c.applyStoreChange(w, r, req.StoreID)
	writeJSON(w, http.StatusOK, map[string]any{
		"storeId":   req.StoreID,
		"storeName": foundName,
	})
}

// applyStoreChange range le store choisi dans la session, ou à défaut
// dans le cookie du navigateur : deux utilisateurs ont chacun le leur.
func (c *StoresController) applyStoreChange(w http.ResponseWriter, r *http.Request, storeID string) {
	if sess := authn.SessionFromContext(r.Context()); sess != nil {
		// MemorySessionStore partage les *Session par référence : la
		// mutation en place est visible côté serveur.
		sess.StoreID = storeID
		return
	}
	cookie := &http.Cookie{
		Name: storeCookie, Value: storeID, Path: "/",
		HttpOnly: true, Secure: c.secureCookies, SameSite: http.SameSiteLaxMode,
		MaxAge: 365 * 24 * 3600,
	}
	if storeID == "" {
		cookie.MaxAge = -1
	}
	http.SetCookie(w, cookie)
}
