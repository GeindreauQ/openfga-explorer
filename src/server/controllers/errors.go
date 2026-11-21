// Package controllers — helpers de réponse HTTP (writeJSON,
// writeError) qui vivent dans `response.go`. Les erreurs standard
// du domaine sont définies dans `internal/apperr/errors.go`.
//
// Ce fichier existe uniquement parce que `controllers/` est importé
// comme un seul package Go ; il fournit la doc de package commune
// et empêche un fichier vide qui ferait échouer `go build`.
//
// Toute nouvelle fonction liée aux controllers doit aller dans
// `response.go` ou un fichier `<topic>.go` dédié, pas ici.
package controllers

// keep the file non-empty so `go build` doesn't complain
var _placeholder = struct{}{}
