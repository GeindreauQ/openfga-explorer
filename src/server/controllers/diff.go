// controllers/diff.go — Comparaison structurelle de deux authorization
// models OpenFGA.
//
// Endpoint : POST /api/diff {model_a_id, model_b_id} → compare les
// types, relations et conditions des deux modèles et renvoie un diff
// structuré (added/removed/changed). Pas de diff textuel — comparaison
// directe des structures JSON.

package controllers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
)

// DiffController gère POST /api/diff.
type DiffController struct {
	openfga openfgaclient.OpenFGA
}

// NewDiffController crée le contrôleur.
func NewDiffController(openfga openfgaclient.OpenFGA) *DiffController {
	return &DiffController{openfga: openfga}
}

// diffRequest est le body de POST /api/diff.
type diffRequest struct {
	ModelAID string `json:"model_a_id"`
	ModelBID string `json:"model_b_id"`
}

// diffType représente un type dans le diff. Champs optionnels :
//   - Added/Removed : le type n'existe que dans A ou B.
//   - ChangedRels   : si présent, ce sont les relations ajoutées/
//     supprimées/modifiées dans ce type. Structure : {added, removed,
//     changed} où changed est {name: {aBody, bBody}}.
type diffType struct {
	Type        string          `json:"type"`
	Added       bool            `json:"added,omitempty"`
	Removed     bool            `json:"removed,omitempty"`
	ChangedRels *diffRelsChange `json:"changed_relations,omitempty"`
}

// diffRelsChange : relations ajoutées, supprimées, modifiées dans un
// type qui existe des deux côtés mais avec un contenu différent.
type diffRelsChange struct {
	Added   []string                  `json:"added"`
	Removed []string                  `json:"removed"`
	Changed map[string]map[string]any `json:"changed"` // name → {a, b}
}

// diffCondition : idem pour les conditions (aBody, bBody : le body brut
// {name, expression, parameters}).
type diffCondition struct {
	Condition string          `json:"condition"`
	Added     bool            `json:"added,omitempty"`
	Removed   bool            `json:"removed,omitempty"`
	Changed   *map[string]any `json:"changed,omitempty"` // {a, b}
}

// diffResponse : payload retourné au frontend.
type diffResponse struct {
	AddedTypes        []diffType      `json:"added_types"`
	RemovedTypes      []diffType      `json:"removed_types"`
	ChangedTypes      []diffType      `json:"changed_types"`
	AddedConditions   []diffCondition `json:"added_conditions"`
	RemovedConditions []diffCondition `json:"removed_conditions"`
	ChangedConditions []diffCondition `json:"changed_conditions"`
}

// Diff traite POST /api/diff. Charge les deux modèles (en supposant
// qu'ils existent dans le store actif — OpenFGA peut en stocker
// plusieurs par version), les compare et renvoie le diff.
func (c *DiffController) Diff(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	var req diffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.ModelAID == "" || req.ModelBID == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "model_a_id et model_b_id sont requis"))
		return
	}
	if req.ModelAID == req.ModelBID {
		writeError(w, apperr.New(http.StatusBadRequest, "model_a_id et model_b_id doivent être différents"))
		return
	}
	a, err := c.fetchModel(r, req.ModelAID)
	if err != nil {
		writeError(w, err)
		return
	}
	b, err := c.fetchModel(r, req.ModelBID)
	if err != nil {
		writeError(w, err)
		return
	}
	resp := computeDiff(a, b)
	writeJSON(w, http.StatusOK, resp)
}

// fetchModel récupère un authorization model par son ID. OpenFGA ne
// fournit pas un endpoint dédié : on liste tous les modèles et on
// trouve celui qui matche.
func (c *DiffController) fetchModel(r *http.Request, modelID string) (map[string]any, error) {
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		return nil, apperr.New(http.StatusServiceUnavailable, "store non sélectionné")
	}
	models, err := c.openfga.ListAuthorizationModels(r.Context(), storeID)
	if err != nil {
		return nil, apperr.Wrap(http.StatusInternalServerError,
			fmt.Errorf("list models: %w", err))
	}
	for _, m := range models {
		if id, ok := m["id"].(string); ok && id == modelID {
			return m, nil
		}
	}
	return nil, apperr.New(http.StatusNotFound, "modèle introuvable: "+modelID)
}

// computeDiff compare deux authorization models et produit un diff
// structurel. Format intermédiaire : on normalise les types en
// {name, relations: {relName: body}} et les conditions en
// {name, body}.
func computeDiff(a, b map[string]any) diffResponse {
	aTypes := indexTypes(a)
	bTypes := indexTypes(b)
	aConds := indexConditions(a)
	bConds := indexConditions(b)

	resp := diffResponse{
		AddedTypes:        []diffType{},
		RemovedTypes:      []diffType{},
		ChangedTypes:      []diffType{},
		AddedConditions:   []diffCondition{},
		RemovedConditions: []diffCondition{},
		ChangedConditions: []diffCondition{},
	}

	// Types
	for name, aT := range aTypes {
		if bT, ok := bTypes[name]; ok {
			// Présent dans les deux : on compare les relations.
			if ch := diffRelations(aT.relations, bT.relations); ch != nil {
				resp.ChangedTypes = append(resp.ChangedTypes, diffType{
					Type:        name,
					ChangedRels: ch,
				})
			}
		} else {
			// Présent que dans A : removed.
			resp.RemovedTypes = append(resp.RemovedTypes, diffType{Type: name, Removed: true})
		}
	}
	for name := range bTypes {
		if _, ok := aTypes[name]; !ok {
			resp.AddedTypes = append(resp.AddedTypes, diffType{Type: name, Added: true})
		}
	}

	// Conditions
	for name, aC := range aConds {
		if bC, ok := bConds[name]; ok {
			if !equalJSON(aC.body, bC.body) {
				resp.ChangedConditions = append(resp.ChangedConditions, diffCondition{
					Condition: name,
					Changed:   &map[string]any{"a": aC.body, "b": bC.body},
				})
			}
		} else {
			resp.RemovedConditions = append(resp.RemovedConditions,
				diffCondition{Condition: name, Removed: true})
		}
	}
	for name := range bConds {
		if _, ok := aConds[name]; !ok {
			resp.AddedConditions = append(resp.AddedConditions,
				diffCondition{Condition: name, Added: true})
		}
	}

	return resp
}

type indexedType struct {
	relations map[string]map[string]any
}

// indexTypes extrait la map {typeName: {relations: {relName: body}}}
// depuis un authorization model. Le body de chaque relation est un
// map[string]any brut (this, union, intersection, etc.).
func indexTypes(m map[string]any) map[string]indexedType {
	out := map[string]indexedType{}
	types, _ := m["type_definitions"].([]any)
	for _, t := range types {
		tm, _ := t.(map[string]any)
		name, _ := tm["type"].(string)
		rels, _ := tm["relations"].(map[string]any)
		out[name] = indexedType{relations: make(map[string]map[string]any)}
		for k, v := range rels {
			if vb, ok := v.(map[string]any); ok {
				out[name].relations[k] = vb
			}
		}
	}
	return out
}

func indexConditions(m map[string]any) map[string]struct{ body map[string]any } {
	out := map[string]struct{ body map[string]any }{}
	conds, _ := m["conditions"].(map[string]any)
	for name, v := range conds {
		if vb, ok := v.(map[string]any); ok {
			out[name] = struct{ body map[string]any }{body: vb}
		}
	}
	return out
}

// diffRelations compare les relations de deux versions d'un même type.
// Retourne nil si elles sont identiques.
func diffRelations(a, b map[string]map[string]any) *diffRelsChange {
	out := &diffRelsChange{
		Added:   []string{},
		Removed: []string{},
		Changed: map[string]map[string]any{},
	}
	for name, aB := range a {
		if bB, ok := b[name]; ok {
			if !equalJSON(aB, bB) {
				out.Changed[name] = map[string]any{"a": aB, "b": bB}
			}
		} else {
			out.Removed = append(out.Removed, name)
		}
	}
	for name := range b {
		if _, ok := a[name]; !ok {
			out.Added = append(out.Added, name)
		}
	}
	if len(out.Added) == 0 && len(out.Removed) == 0 && len(out.Changed) == 0 {
		return nil
	}
	return out
}

// equalJSON compare deux corps JSON (map[string]any) via sérialisation
// + comparaison. Approche simple qui évite une dépendance sur un diff
// library.
func equalJSON(a, b map[string]any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}
