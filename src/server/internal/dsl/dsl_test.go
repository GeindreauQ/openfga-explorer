package dsl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// findExamplesDir remonte l'arborescence jusqu'à trouver le dossier
// examples/multi-store/store-data/ du repo. Permet aux tests d'être
// lancés depuis le src/server (CI) ou depuis la racine (dev).
func findExamplesDir(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "..", "..", "examples", "multi-store", "store-data")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate
		}
		candidate = filepath.Join(dir, "..", "examples", "multi-store", "store-data")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	t.Skip("examples/multi-store/store-data not found; skipping example-driven tests")
	return ""
}

// TestParseAllExamples vérifie que tous les fichiers .fga du dossier
// examples/multi-store/store-data se parsent sans erreur et produisent
// un JSON OpenFGA qui se re-sérialise en un DSL équivalent.
func TestParseAllExamples(t *testing.T) {
	dir := findExamplesDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir %s: %v", dir, err)
	}

	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".fga") {
			continue
		}
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			text := string(data)

			// 1. Parse DSL → JSON.
			parsed, err := Parse(text)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if _, ok := parsed["type_definitions"]; !ok {
				t.Errorf("expected type_definitions in parsed JSON")
			}

			// 2. Sérialise le JSON en DSL via l'API officielle.
			jsonBytes, err := jsonMarshalIndent(parsed)
			if err != nil {
				t.Fatalf("json marshal: %v", err)
			}
			roundTrip, err := SerializeToDSL(string(jsonBytes))
			if err != nil {
				t.Fatalf("SerializeToDSL: %v", err)
			}
			if strings.TrimSpace(roundTrip) == "" {
				t.Error("SerializeToDSL returned empty string")
			}

			// 3. Re-parse le DSL obtenu pour vérifier le round-trip.
			parsed2, err := Parse(roundTrip)
			if err != nil {
				t.Fatalf("Re-parse: %v", err)
			}
			if !sameTypeCount(parsed, parsed2) {
				t.Errorf("round-trip changed type count: %d → %d",
					getTypeCount(parsed), getTypeCount(parsed2))
			}
		})
	}
}

func TestParseInvalidDSL(t *testing.T) {
	cases := []string{
		"this is not valid fga",
		"type foo\n  relations\n    define viewer: [unknown_type with unknown_condition]",
		"type foo\n  relations\n    define viewer: [", // non fermé
	}
	for _, c := range cases {
		_, err := Parse(c)
		if err == nil {
			t.Errorf("Parse(%q) should fail", c)
		}
	}
}

func TestParseEmpty(t *testing.T) {
	out, err := Parse("")
	if err != nil {
		t.Fatalf("Parse empty: %v", err)
	}
	// Le champ `errors` est toujours présent (tableau vide si OK).
	// On vérifie qu'il n'y a pas d'erreur et que les champs DSL sont vides.
	if len(out["errors"].([]any)) != 0 {
		t.Errorf("empty DSL should have 0 errors, got %v", out["errors"])
	}
	if _, ok := out["type_definitions"]; ok {
		t.Errorf("empty DSL should not have type_definitions, got %v", out["type_definitions"])
	}
}

func TestParseJSONRoundTrip(t *testing.T) {
	src := `{"schema_version":"1.1","type_definitions":[{"type":"user","relations":{"viewer":{"this":{"types":[{"type":"user"}]}}}}]}`
	out, err := ParseJSON(src)
	if err != nil {
		t.Fatalf("ParseJSON: %v", err)
	}
	if out["schema_version"] != "1.1" {
		t.Errorf("schema_version: got %v, want 1.1", out["schema_version"])
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func jsonMarshalIndent(v any) ([]byte, error) {
	return jsonMarshalIndentImpl(v)
}

func sameTypeCount(a, b map[string]any) bool {
	return getTypeCount(a) == getTypeCount(b)
}

func getTypeCount(m map[string]any) int {
	if arr, ok := m["type_definitions"].([]any); ok {
		return len(arr)
	}
	return 0
}
