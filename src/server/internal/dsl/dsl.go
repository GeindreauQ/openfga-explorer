// Package dsl encapsule le parsing du DSL OpenFGA côté serveur.
//
// Contrairement à un parser maison (qui duplique ~1000 lignes du frontend),
// on s'appuie sur le package officiel `github.com/openfga/language/pkg/go`
// qui implémente la grammaire ANTLR officielle. On bénéficie ainsi de :
//
//   - la couverture complète du DSL (conditions CEL, or/and/but not,
//     tuple-to-userset, userset rewrite, wildcards) ;
//   - la compatibilité ascendante avec les futures évolutions du DSL ;
//   - des messages d'erreur de qualité (avec position).
//
// L'API publique est volontairement thin :
//
//   - Parse(text)        : DSL texte → map[string]any (AST OpenFGA standard)
//   - ParseJSON(text)    : JSON OpenFGA → map[string]any (ré-empaquetage)
//   - SerializeToDSL(json): AST OpenFGA → DSL .fga (round-trip)
//
// Pas de struct intermédiaire propriétaire : le format de sortie est
// directement le JSON OpenFGA officiel (type_definitions + conditions),
// ce qui évite tout mapping exotique.
package dsl

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/openfga/language/pkg/go/transformer"
)

// Parse convertit un texte DSL OpenFGA en map[string]any au format JSON
// officiel (`{schema_version, type_definitions, conditions, errors}`).
// Le frontend peut consommer directement la sortie ou la reconvertir en
// DSL via SerializeToDSL.
//
// Une chaîne vide ou composée uniquement de commentaires/blancs renvoie
// une map vide sans erreur.
//
// La valeur de retour contient **toujours** un champ `errors` :
//   - tableau vide si parsing réussi ;
//   - sinon une entrée par erreur `{line, message}`.
//
// Le pipeline interne utilise `parseDSL` (qui retourne le listener
// ANTLR avec ses ErrorListener) puis ré-invoque
// `transformDSLToJSONObject` pour récupérer le modèle. Les deux
// parsings passent par le même compilateur officiel, donc leurs
// sorties sont identiques.
func Parse(text string) (map[string]any, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return map[string]any{"errors": []any{}}, nil
	}
	noComments := stripAllComments(trimmed)
	if strings.TrimSpace(noComments) == "" {
		return map[string]any{"errors": []any{}}, nil
	}

	// 1. Parse DSL → AuthorizationModel (mode "haute niveau").
	jsonStr, err := transformer.TransformDSLToJSON(noComments)
	if err != nil {
		// Erreur fatale (exception ANTLR).
		return nil, fmt.Errorf("dsl parse: %w", err)
	}

	// 2. Re-parse pour récupérer les erreurs structurelles.
	_, errListener := transformer.ParseDSL(noComments)
	out := map[string]any{}
	if jsonStr != "" {
		var parsed map[string]any
		if uerr := json.Unmarshal([]byte(jsonStr), &parsed); uerr != nil {
			return nil, fmt.Errorf("dsl parse: json unmarshal: %w", uerr)
		}
		for k, v := range parsed {
			out[k] = v
		}
	}

	// 3. Extrait les erreurs de l'ErrorListener (champs non exportés
	// dans la lib, donc on utilise juste Error()).
	errors := []any{}
	if errListener != nil && errListener.Errors != nil {
		for _, e := range errListener.Errors.Errors {
			errors = append(errors, map[string]any{"message": e.Error()})
		}
	}
	if errors == nil {
		errors = []any{}
	}
	out["errors"] = errors
	return out, nil
}

// stripAllComments retire toutes les lignes qui sont uniquement des
// commentaires `# ...`. Le parser officiel rejette un texte ne
// contenant que des commentaires.
func stripAllComments(text string) string {
	var sb strings.Builder
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	return sb.String()
}

// ParseJSON convertit un JSON OpenFGA standard en map[string]any
// normalisée (équivalente à Parse(SerializeToDSL(text))). Utile pour
// l'endpoint `GET /api/dsl` qui renvoie le JSON du store tel quel.
func ParseJSON(text string) (map[string]any, error) {
	if text == "" {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return nil, fmt.Errorf("dsl json parse: %w", err)
	}
	return out, nil
}

// SerializeToDSL fait l'inverse de Parse : AST OpenFGA → texte DSL .fga.
// Permet de reconvertir un JSON de store en DSL pour l'éditeur.
func SerializeToDSL(jsonText string) (string, error) {
	dsl, err := transformer.TransformJSONStringToDSL(jsonText)
	if err != nil {
		return "", fmt.Errorf("dsl serialize: %w", err)
	}
	if dsl == nil {
		return "", nil
	}
	return *dsl, nil
}
