package controllers

import "testing"

// TestLintModel_NoCycles vérifie qu'un modèle linéaire ne produit aucun
// warning de cycle.
func TestLintModel_NoCycles(t *testing.T) {
	model := map[string]any{
		"type_definitions": []any{
			map[string]any{
				"type": "document",
				"relations": map[string]any{
					"viewer": map[string]any{"this": map[string]any{}},
				},
			},
		},
	}
	warnings := lintModel(model)
	for _, w := range warnings {
		if w.Code == "cycle" {
			t.Errorf("unexpected cycle warning: %+v", w)
		}
	}
}

// TestLintModel_DirectCycle vérifie qu'un cycle entre deux relations
// du même type est détecté.
func TestLintModel_DirectCycle(t *testing.T) {
	model := map[string]any{
		"type_definitions": []any{
			map[string]any{
				"type": "user",
				"relations": map[string]any{
					"a": map[string]any{
						"computedUserset": map[string]any{"object": "", "relation": "b"},
					},
					"b": map[string]any{
						"computedUserset": map[string]any{"object": "", "relation": "a"},
					},
				},
			},
		},
	}
	warnings := lintModel(model)
	var foundCycle bool
	for _, w := range warnings {
		if w.Code == "cycle" {
			foundCycle = true
			break
		}
	}
	if !foundCycle {
		t.Errorf("expected cycle warning, got %+v", warnings)
	}
}

// TestLintModel_CrossTypeCycle vérifie qu'un cycle entre relations de
// types différents est détecté (ex: A.foo référence B.bar, et B.bar
// référence A.foo via tuple-to-userset).
func TestLintModel_CrossTypeCycle(t *testing.T) {
	model := map[string]any{
		"type_definitions": []any{
			map[string]any{
				"type": "repo",
				"relations": map[string]any{
					"owner": map[string]any{
						"computedUserset": map[string]any{"object": "", "relation": "name"},
					},
					"name": map[string]any{
						"computedUserset": map[string]any{"object": "", "relation": "owner"},
					},
				},
			},
		},
	}
	warnings := lintModel(model)
	var foundCycle bool
	for _, w := range warnings {
		if w.Code == "cycle" {
			foundCycle = true
			break
		}
	}
	if !foundCycle {
		t.Errorf("expected cycle warning for cross-type relation graph, got %+v", warnings)
	}
}

// TestLintModel_TupleToUsersetReference vérifie qu'un tupleToUserset
// vers un autre type est correctement indexé (et peut donc être
// traversé dans la détection de cycles).
func TestLintModel_TupleToUsersetReference(t *testing.T) {
	model := map[string]any{
		"type_definitions": []any{
			map[string]any{
				"type": "document",
				"relations": map[string]any{
					"parent": map[string]any{"this": map[string]any{}},
					"viewer": map[string]any{
						"tupleToUserset": map[string]any{
							"tupleset": map[string]any{
								"object":   "",
								"relation": "parent",
							},
							"computedUserset": map[string]any{
								"object":   "",
								"relation": "viewer",
							},
						},
					},
				},
			},
		},
	}
	warnings := lintModel(model)
	for _, w := range warnings {
		if w.Code == "cycle" {
			t.Errorf("self-referencing tuple-to-userset should not produce a cross-type cycle warning here, got %+v", w)
		}
	}
}

// TestLintModel_OrphanRelation vérifie qu'une relation jamais référencée
// produit un warning "orphan_relation" (info-level).
func TestLintModel_OrphanRelation(t *testing.T) {
	model := map[string]any{
		"type_definitions": []any{
			map[string]any{
				"type": "document",
				"relations": map[string]any{
					"viewer":            map[string]any{"this": map[string]any{}},
					"completely_unused": map[string]any{"this": map[string]any{}},
				},
			},
		},
	}
	warnings := lintModel(model)
	var foundOrphan bool
	for _, w := range warnings {
		if w.Code == "orphan_relation" && w.Relation == "completely_unused" {
			foundOrphan = true
			break
		}
	}
	if !foundOrphan {
		t.Errorf("expected orphan_relation warning for 'completely_unused', got %+v", warnings)
	}
}
