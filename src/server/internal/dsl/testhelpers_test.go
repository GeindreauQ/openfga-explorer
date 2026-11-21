package dsl

import "encoding/json"

// jsonMarshalIndentImpl factorise json.MarshalIndent pour les tests.
func jsonMarshalIndentImpl(v any) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}
