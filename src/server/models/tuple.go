// Package models contient les types du domaine (Tuple, Store, User, Session).
package models

// Tuple est la représentation simplifiée d'un tuple échangée avec le frontend.
type Tuple struct {
	User     string `json:"user"`
	Relation string `json:"relation"`
	Object   string `json:"object"`
}

// Store représente un store OpenFGA. ID est l'ULID retourné par OpenFGA,
// Name est le label lisible (modifiable, potentiellement non unique).
type Store struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// StoreRef enrichit un Store avec un drapeau `Active` indiquant
// si c'est le store actuellement sélectionné côté backend.
type StoreRef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
}

// AuthModel représente un modèle d'autorisation (résultat d'un write).
// Seul l'ID est utilisé par le frontend.
type AuthModel struct {
	ID string `json:"authorization_model_id"`
}
