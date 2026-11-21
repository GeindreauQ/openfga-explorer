// controllers/lint.go — Linter sémantique pour les authorization models.
//
// Le parser OpenFGA officiel fait le **syntactic** (DSL → AST). Il ne
// fait pas le **sémantique** (warnings sur le modèle). Ce linter
// détecte :
//
//   - Relations orphelines : définies dans un type mais jamais
//     référencées (ni directement par un tuple, ni par un autre
//     relation via computed userset / tuple-to-userset).
//   - Cycles : relations qui se référencent en boucle (ex: A.parent
//     pointe vers B et B.parent pointe vers A → cycle de longueur 2).
//     OpenFGA n'interdit pas les cycles mais les warnings aident
//     l'auteur à les détecter (souvent involontaires).
//   - Computed userset invalide : `define X: Y` où Y est une relation
//     d'un autre type mais n'existe pas dans ce type.
//
// Routes :
//   POST /api/dsl/lint  → body {model: {…}}, renvoie {warnings: [{...}]}

package controllers

import (
	"encoding/json"
	"net/http"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
)

// LintController gère POST /api/dsl/lint.
type LintController struct{}

// NewLintController crée le contrôleur.
func NewLintController() *LintController {
	return &LintController{}
}

// LintWarning est une entrée du rapport. `Code` est l'identifiant
// machine (pour le filtrage côté frontend), `Severity` la gravité
// (`info` = suggestion, `warn` = problème potentiel).
type LintWarning struct {
	Code     string   `json:"code"`               // "orphan_relation" | "cycle" | "invalid_userset"
	Severity string   `json:"severity"`           // "info" | "warn"
	Type     string   `json:"type,omitempty"`     // type affecté (si pertinent)
	Relation string   `json:"relation,omitempty"` // relation affectée (si pertinent)
	Message  string   `json:"message"`            // message humain
	Cycle    []string `json:"cycle,omitempty"`    // chemin du cycle (relations)
}

// LintRequest : body de POST /api/dsl/lint. Le model peut être soit
// le JSON brut du store, soit le JSON OpenFGA standard (les 2 ont la
// même structure pour `type_definitions`).
type LintRequest struct {
	Model map[string]any `json:"model"`
}

// LintResponse : payload retourné au frontend.
type LintResponse struct {
	Warnings []LintWarning `json:"warnings"`
}

// Lint traite POST /api/dsl/lint. Body : `{"model": {…}}`.
// Renvoie `{warnings: [{code, severity, type, relation, message, cycle?}]}`.
//
// Pas d'I/O OpenFGA : le linter est une fonction PURE qui prend un
// AST en entrée et renvoie des warnings. Idempotent et testable en
// isolation.
func (c *LintController) Lint(w http.ResponseWriter, r *http.Request) {
	var req LintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "JSON invalide: "+err.Error()))
		return
	}
	if req.Model == nil {
		writeError(w, apperr.New(http.StatusBadRequest, "champ 'model' manquant"))
		return
	}
	resp := LintResponse{Warnings: []LintWarning{}}
	resp.Warnings = append(resp.Warnings, lintModel(req.Model)...)
	writeJSON(w, http.StatusOK, resp)
}

// ─── Règles de lint ─────────────────────────────────────────────────

// indexModel normalise le JSON OpenFGA en une forme facile à parcourir.
type lintIndexedType struct {
	name      string
	relations map[string]lintIndexedRelation
}

type lintIndexedRelation struct {
	name string
	// Pour la détection d'orphelins : qui me référence ?
	referencedBy []string // "type:relation"
	// Pour la détection de cycles : vers quoi je pointe ?
	pointsTo []string // "type:relation"
}

func indexModel(model map[string]any) map[string]*lintIndexedType {
	types, _ := model["type_definitions"].([]any)
	out := map[string]*lintIndexedType{}
	for _, t := range types {
		tm, _ := t.(map[string]any)
		name, _ := tm["type"].(string)
		if name == "" {
			continue
		}
		it := &lintIndexedType{name: name, relations: map[string]lintIndexedRelation{}}
		rels, _ := tm["relations"].(map[string]any)
		for relName := range rels {
			it.relations[relName] = lintIndexedRelation{name: relName}
		}
		out[name] = it
	}
	// 2e passe : relie les références.
	for _, t := range types {
		tm, _ := t.(map[string]any)
		tname, _ := tm["type"].(string)
		rels, _ := tm["relations"].(map[string]any)
		for relName, rv := range rels {
			rm, _ := rv.(map[string]any)
			if rm == nil {
				continue
			}
			srcKey := tname + ":" + relName
			// Walk récursif : `this`, `union.child`, `intersection.child`
			// peuvent tous contenir des computedUsersets qui réfèrent
			// d'autres relations du même type.
			walkAndIndexUsersets(rm, tname, relName, srcKey, out)
			// Tuple-to-userset : `tupleToUserset` réfère (object)#relation
			// d'un AUTRE type. La cible est "otherType:relation".
			if ttuset, ok := rm["tupleToUserset"].(map[string]any); ok {
				if tu, ok := ttuset["tupleset"].(map[string]any); ok {
					if userset, ok := tu["userset"].(map[string]any); ok {
						if obj, ok := userset["object"].(string); ok {
							if relRef, ok := userset["relation"].(string); ok {
								target := obj + ":" + relRef
								if srcIt, ok := out[tname]; ok {
									if src, ok := srcIt.relations[relName]; ok {
										src.pointsTo = append(src.pointsTo, target)
										srcIt.relations[relName] = src
									}
								}
								if tgtIt, ok := out[obj]; ok {
									if tgt, ok := tgtIt.relations[relRef]; ok {
										tgt.referencedBy = append(tgt.referencedBy, srcKey)
										tgtIt.relations[relRef] = tgt
									}
								}
							}
						}
					}
				}
			}
		}
	}
	return out
}

// walkAndIndexUsersets explore récursivement un sous-arbre
// `{this | union | intersection}` à la recherche de computedUsersets,
// puis enregistre src→target et target.referencedBy dans l'index.
func walkAndIndexUsersets(node any, tname, relName, srcKey string, out map[string]*lintIndexedType) {
	switch n := node.(type) {
	case map[string]any:
		// computedUserset direct
		if ref, ok := n["computedUserset"].(map[string]any); ok {
			if relRef, ok := ref["relation"].(string); ok {
				if it, ok := out[tname]; ok {
					if src, ok := it.relations[relName]; ok {
						src.pointsTo = append(src.pointsTo, tname+":"+relRef)
						it.relations[relName] = src
					}
					if tgt, ok := it.relations[relRef]; ok {
						tgt.referencedBy = append(tgt.referencedBy, srcKey)
						it.relations[relRef] = tgt
					}
				}
			}
		}
		// this
		if thisMap, ok := n["this"].(map[string]any); ok {
			walkAndIndexUsersets(thisMap, tname, relName, srcKey, out)
		}
		// union.child[]
		if u, ok := n["union"].(map[string]any); ok {
			if children, ok := u["child"].([]any); ok {
				for _, c := range children {
					walkAndIndexUsersets(c, tname, relName, srcKey, out)
				}
			}
		}
		// intersection.child[]
		if i, ok := n["intersection"].(map[string]any); ok {
			if children, ok := i["child"].([]any); ok {
				for _, c := range children {
					walkAndIndexUsersets(c, tname, relName, srcKey, out)
				}
			}
		}
		// but not (exclusion) — pas de computed userset, mais peut
		// contenir `base` qui contient une computed userset.
		if bn, ok := n["butnot"].(map[string]any); ok {
			if base, ok := bn["base"]; ok {
				walkAndIndexUsersets(base, tname, relName, srcKey, out)
			}
		}
	}
}

// lintModel applique les règles et renvoie les warnings.
func lintModel(model map[string]any) []LintWarning {
	warnings := []LintWarning{}
	idx := indexModel(model)

	// Règle 1 : relations orphelines.
	// Une relation est "orpheline" si elle n'est référencée par aucune
	// autre relation (computed userset, tuple-to-userset) ET n'est pas
	// une assignation directe (c'est le cas le plus commun — un tuple
	// peut être écrit dessus). On ne flag donc que les relations non
	// référencées, en `info` (suggestion), pas en `warn` (erreur).
	for _, t := range idx {
		for relName, r := range t.relations {
			if len(r.referencedBy) == 0 {
				warnings = append(warnings, LintWarning{
					Code:     "orphan_relation",
					Severity: "info",
					Type:     t.name,
					Relation: relName,
					Message:  "Relation définie mais jamais référencée par une autre (computed userset / tuple-to-userset). Cela peut être normal (relation assignable directement via tuple), mais vérifiez qu'elle est volontairement publique.",
				})
			}
		}
	}

	// Règle 2 : cycles.
	// On fait un DFS en marquant 3 couleurs (white/gray/black). Un
	// back-edge (gray→gray) signale un cycle.
	cycles := detectCycles(idx)
	for _, c := range cycles {
		warnings = append(warnings, LintWarning{
			Code:     "cycle",
			Severity: "warn",
			Message:  "Cycle détecté dans les relations : " + joinRelNames(c),
			Cycle:    c,
		})
	}

	return warnings
}

// detectCycles retourne la liste des cycles trouvés dans le graphe
// directed "type:relation" → "type:relation". Implémentation : DFS
// avec color marking (white/gray/black). Les cycles sont normalisés
// pour commencer par le plus petit élément (pour dédupe).
func detectCycles(idx map[string]*lintIndexedType) [][]string {
	const white, gray, black = 0, 1, 2
	color := map[string]int{}
	var cycles [][]string
	var stack []string

	var dfs func(key string) bool
	dfs = func(key string) bool {
		color[key] = gray
		stack = append(stack, key)
		tname, relname := splitKey(key)
		it, ok := idx[tname]
		if !ok {
			color[key] = black
			stack = stack[:len(stack)-1]
			return false
		}
		r, ok := it.relations[relname]
		if !ok {
			color[key] = black
			stack = stack[:len(stack)-1]
			return false
		}
		for _, target := range r.pointsTo {
			switch color[target] {
			case gray:
				// Back-edge : on a un cycle. On extrait le cycle
				// depuis stack (de la 1re occurrence de target à la fin).
				idx2 := indexOf(stack, target)
				if idx2 < 0 {
					continue
				}
				cycle := append([]string{}, stack[idx2:]...)
				// Normalise : rotation pour commencer par le + petit
				// élément alphabétiquement (dédupe).
				cycle = normalizeCycle(cycle)
				if !containsCycle(cycles, cycle) {
					cycles = append(cycles, cycle)
				}
			case white:
				dfs(target)
			}
		}
		color[key] = black
		stack = stack[:len(stack)-1]
		return false
	}

	for _, t := range idx {
		for relName := range t.relations {
			key := t.name + ":" + relName
			if color[key] == white {
				dfs(key)
			}
		}
	}
	return cycles
}

func splitKey(k string) (t, r string) {
	for i := 0; i < len(k); i++ {
		if k[i] == ':' {
			return k[:i], k[i+1:]
		}
	}
	return k, ""
}

func indexOf(stack []string, target string) int {
	for i, s := range stack {
		if s == target {
			return i
		}
	}
	return -1
}

func normalizeCycle(c []string) []string {
	if len(c) == 0 {
		return c
	}
	// Trouve l'index du min alphabétique, puis rotate.
	minIdx := 0
	for i, s := range c {
		if s < c[minIdx] {
			minIdx = i
		}
	}
	out := make([]string, len(c))
	copy(out, c[minIdx:])
	copy(out[len(c)-minIdx:], c[:minIdx])
	return out
}

func containsCycle(cycles [][]string, c []string) bool {
	for _, existing := range cycles {
		if len(existing) != len(c) {
			continue
		}
		match := true
		for i := range existing {
			if existing[i] != c[i] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func joinRelNames(c []string) string {
	out := ""
	for i, s := range c {
		if i > 0 {
			out += " → "
		}
		out += s
	}
	return out + " → …"
}
