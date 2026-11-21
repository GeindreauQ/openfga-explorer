// Package apperr définit le type d'erreur standard de l'API HTTP.
//
// L'explorer expose des erreurs JSON uniformes. Toutes les couches (services,
// controllers) propagent une *apperr.Error quand elles veulent piloter le
// code de statut HTTP ; le helper writeError du package controllers
// sérialise ce type en `{"error": "..."}` avec le bon statut.
package apperr

import (
	"errors"
	"net/http"
)

// Error est l'erreur standard renvoyée par les services. Le `Status`
// pilote le code HTTP de la réponse JSON ; le `Message` est exposé tel
// quel au frontend.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// From déballe une error en *Error si possible.
func From(err error) *Error {
	var ae *Error
	if errors.As(err, &ae) {
		return ae
	}
	return nil
}

// New construit une nouvelle Error.
func New(status int, message string) *Error {
	return &Error{Status: status, Message: message}
}

// Wrap enrobe `err` en *Error avec le statut fourni. Si `err` est déjà
// une *Error, retourne celle-ci telle quelle (idempotent).
func Wrap(status int, err error) *Error {
	if ae := From(err); ae != nil {
		return ae
	}
	return &Error{Status: status, Message: err.Error()}
}

// Erreurs standardisées réutilisées dans toute l'app.
var (
	ErrNotConfigured = &Error{
		Status:  http.StatusServiceUnavailable,
		Message: "OpenFGA non configuré : OPENFGA_URL manquant",
	}
	ErrNoStoreSelected = &Error{
		Status:  http.StatusBadRequest,
		Message: "aucun store sélectionné",
	}
	ErrInvalidJSON = &Error{
		Status:  http.StatusBadRequest,
		Message: "JSON invalide",
	}
	ErrUnauthenticated = &Error{
		Status:  http.StatusUnauthorized,
		Message: "non authentifié",
	}
	ErrRateLimited = &Error{
		Status:  http.StatusTooManyRequests,
		Message: "trop de tentatives, réessayez dans une minute",
	}
)
