// Helpers pour propager la Session active dans le context HTTP.
//
// auth.Middleware pose la *Session dans r.Context() via une clé privée.
// Les controllers en aval la relèvent sans re-parser le cookie.
//
// On garde la clé dans un type privé (ctxKey) et non dans `string` pour
// éviter les collisions avec d'autres packages qui mettraient une valeur
// sous la même string.
package authn

import "context"

// ctxKey est le type des clés privées du context pour cette package.
type ctxKey int

const (
	sessionKey ctxKey = iota
)

// WithSession retourne un nouveau context ctx enrichi avec sess. Le
// context donné peut être nil.
func WithSession(ctx context.Context, sess *Session) context.Context {
	if sess == nil {
		return ctx
	}
	return context.WithValue(ctx, sessionKey, sess)
}

// SessionFromContext renvoie la *Session posée par auth.Middleware, ou
// nil si aucune n'est présente (cas AUTH_DISABLED=1).
func SessionFromContext(ctx context.Context) *Session {
	if ctx == nil {
		return nil
	}
	if s, ok := ctx.Value(sessionKey).(*Session); ok {
		return s
	}
	return nil
}
