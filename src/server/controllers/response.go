// Package controllers contient les handlers HTTP. Chaque controller
// dépend uniquement des services / packages internal, jamais d'un
// autre controller, pour garder un couplage minimal.
package controllers

import (
	"encoding/json"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/authn"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
)

// writeJSON sérialise `v` en JSON et écrit la réponse avec le bon
// Content-Type. Helper partagé par tous les controllers.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError écrit une réponse JSON d'erreur. Si l'erreur est une
// *apperr.Error, son Status est utilisé ; sinon on retourne 500.
func writeError(w http.ResponseWriter, err error) {
	if ae := apperr.From(err); ae != nil {
		writeJSON(w, ae.Status, map[string]any{"error": ae.Message})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
	}
}

// effectiveStoreID retourne le store ID OpenFGA à utiliser pour la
// requête courante, choisi par /api/stores/select : celui de la session
// quand l'authentification est active, sinon celui du cookie de sélection
// du navigateur. À défaut, le store par défaut du client (premier store
// disponible, posé au démarrage).
//
// Renvoie "" si rien n'est posé — au caller de traduire en erreur
// (cf. apperr.ErrNoStoreSelected).
func effectiveStoreID(r *http.Request, client openfgaclient.OpenFGA) string {
	if sess := authn.SessionFromContext(r.Context()); sess != nil {
		if sess.StoreID != "" {
			return sess.StoreID
		}
	} else if c, err := r.Cookie(storeCookie); err == nil && validStoreID(c.Value) {
		return c.Value
	}
	if client != nil {
		return client.DefaultStoreID()
	}
	return ""
}

// storeCookie garde le store choisi par un navigateur quand
// l'authentification est désactivée (pas de session où le ranger).
const storeCookie = "openfga_explorer_store"

// validStoreID accepte un identifiant de store OpenFGA (ULID, 26 caractères
// Crockford base32) : le cookie vient du navigateur, on ne relaie pas
// n'importe quoi à OpenFGA.
func validStoreID(id string) bool {
	if len(id) != 26 {
		return false
	}
	for _, ch := range id {
		if !(ch >= '0' && ch <= '9' || ch >= 'A' && ch <= 'Z') {
			return false
		}
	}
	return true
}
