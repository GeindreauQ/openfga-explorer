// Package controllers expose le middleware de protection CSRF.
//
// Modèle : double-submit cookie-like pattern, mais sans cookie —
// utiliser la session serveur comme source de vérité évite le risque
// que le navigateur envoie automatiquement le token (ce qui annulerait
// la protection). Le token est :
//
//   - généré à la création de session (32 bytes random, cf. session.go) ;
//   - exposé via /api/me dans le JSON `{ csrf_token: "..." }` ;
//   - renvoyé par le frontend dans le header `X-CSRF-Token` sur toute
//     méthode non-safe (POST, PUT, PATCH, DELETE).
//
// Le middleware compare header == session.CSRFToken en constant time.
// Méthodes safe (GET, HEAD, OPTIONS) passent sans vérification : le
// token ne peut pas être leaké via une GET quel que soit le contexte
// (pas de cookie, pas de query string, pas de body).
package controllers

import (
	"crypto/subtle"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/authn"
)

// CSRFHeader est le header HTTP transporté par le frontend.
const CSRFHeader = "X-CSRF-Token"

// CSRFRequired retourne un middleware qui vérifie X-CSRF-Token sur
// POST/PUT/PATCH/DELETE. En AUTH_DISABLED=1, le middleware laisse
// passer (auth.Middleware ne pose pas de session dans le context).
//
// La comparaison est faite avec subtle.ConstantTimeCompare pour
// éviter les timing attacks sur la longueur du token.
func CSRFRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess := authn.SessionFromContext(r.Context())
		if sess == nil {
			next.ServeHTTP(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		provided := r.Header.Get(CSRFHeader)
		if provided == "" {
			http.Error(w, "missing "+CSRFHeader+" header", http.StatusForbidden)
			return
		}
		if subtle.ConstantTimeCompare([]byte(provided), []byte(sess.CSRFToken)) != 1 {
			http.Error(w, "invalid "+CSRFHeader+" token", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
