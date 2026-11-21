// DSLController expose les endpoints /api/dsl pour l'édition du DSL
// d'autorisation OpenFGA.
//
// Stratégie : aucune logique de parsing ici. Toute la complexité est
// déléguée au package internal/dsl qui s'appuie sur le parser officiel
// openfga/language (ANTLR). Ce controller est juste un proxy HTTP qui :
//
//  1. décode la requête (body JSON ou form-encoded)
//  2. appelle internal/dsl.Parse ou internal/dsl.SerializeToDSL
//  3. renvoie la réponse
//
// Routes :
//
//	GET  /api/dsl          → introspecte le store actif et renvoie le
//	                        dernier authorization model en JSON OpenFGA
//	POST /api/dsl/parse    → parse un DSL .fga → JSON OpenFGA
//	POST /api/dsl/apply    → applique un DSL .fga au store actif
package controllers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	openfga "github.com/openfga/go-sdk"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/internal/dsl"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
)

// DSLController gère /api/dsl.
//
// `broker` est optionnel : s'il est nil, les Apply ne sont pas
// publiés (utile pour les tests). En prod il est non-nil (cf. main.go).
type DSLController struct {
	openfga openfgaclient.OpenFGA
	broker  *EventBroker
}

// NewDSLController crée le controller DSL.
func NewDSLController(openfga openfgaclient.OpenFGA, broker *EventBroker) *DSLController {
	return &DSLController{openfga: openfga, broker: broker}
}

// Get introspecte le store OpenFGA actif et renvoie le dernier
// authorization model en JSON OpenFGA standard. 404 si le store n'a
// aucun modèle.
func (c *DSLController) Get(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	models, err := c.openfga.ListAuthorizationModels(r.Context(), storeID)
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusBadGateway, err))
		return
	}
	if len(models) == 0 {
		writeError(w, apperr.New(http.StatusNotFound, "store sans authorization model"))
		return
	}
	out := models[0]
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(out)
}

// Parse transforme un texte DSL en JSON OpenFGA standard. Utilisé par
// l'éditeur live pour prévisualiser la conversion.
//
// La réponse expose en plus de `type_definitions` un alias `types`
// (le frontend historique consomme `types`), ainsi qu'un entier
// `error_count` au niveau racine (= len(parsed["errors"])) pour les
// scripts d'automatisation qui n'inspectent pas le tableau.
func (c *DSLController) Parse(w http.ResponseWriter, r *http.Request) {
	text := readBodyOrFormField(r, "text")
	if text == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "champ 'text' manquant"))
		return
	}
	parsed, err := dsl.Parse(text)
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusBadRequest, err))
		return
	}
	out := map[string]any{}
	for k, v := range parsed {
		out[k] = v
	}
	if errors, ok := parsed["errors"].([]any); ok {
		out["error_count"] = len(errors)
		if tds, ok := parsed["type_definitions"].([]any); ok {
			out["types"] = tds
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// Apply envoie le DSL parsé au store OpenFGA courant. Le DSL est
// converti en JSON via le parser officiel puis poussé tel quel sur
// l'endpoint /authorization-models du store.
func (c *DSLController) Apply(w http.ResponseWriter, r *http.Request) {
	text := readBodyOrFormField(r, "text")
	if text == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "champ 'text' manquant"))
		return
	}
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	parsed, err := dsl.Parse(text)
	if err != nil {
		writeError(w, apperr.New(http.StatusBadRequest, "DSL invalide : "+err.Error()))
		return
	}
	if len(asTypes(parsed)) == 0 {
		writeError(w, apperr.New(http.StatusBadRequest, "aucun type dans le DSL"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	modelID, err := c.openfga.WriteAuthorizationModelRaw(
		r.Context(),
		storeID,
		asString(parsed["schema_version"]),
		asTypes(parsed),
		asConditions(parsed),
	)
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusInternalServerError, err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authorization_model_id": modelID,
		"schema_version":         asString(parsed["schema_version"]),
		"types":                  len(asTypes(parsed)),
		"conditions":             len(asConditionsMap(parsed)),
	})
	if c.broker != nil {
		c.broker.Publish(Event{
			Type:    "dsl.apply",
			StoreID: storeID,
			ModelID: modelID,
			Types:   len(asTypes(parsed)),
		})
	}
}

// ListVersions renvoie tous les authorization models du store actif,
// du plus récent au plus ancien. GET /api/dsl/versions
func (c *DSLController) ListVersions(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	models, err := c.openfga.ListAuthorizationModels(r.Context(), storeID)
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusBadGateway, err))
		return
	}
	if models == nil {
		models = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": models})
}

// GetVersion renvoie un authorization model spécifique par son ID.
// GET /api/dsl/versions/{id}
func (c *DSLController) GetVersion(w http.ResponseWriter, r *http.Request) {
	if c.openfga == nil {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "OpenFGA non configuré"))
		return
	}
	storeID := effectiveStoreID(r, c.openfga)
	if storeID == "" {
		writeError(w, apperr.New(http.StatusServiceUnavailable, "store non sélectionné"))
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeError(w, apperr.New(http.StatusBadRequest, "id requis"))
		return
	}
	model, err := c.openfga.ReadAuthorizationModel(r.Context(), storeID, id)
	if err != nil {
		writeError(w, apperr.Wrap(http.StatusBadGateway, err))
		return
	}
	writeJSON(w, http.StatusOK, model)
}

// readBodyOrFormField lit le champ `text` depuis un body JSON, un
// form-encoded body, ou le body brut (fallback).
func readBodyOrFormField(r *http.Request, field string) string {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/json") {
		var body struct {
			Text string `json:"text"`
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err == nil {
			return body.Text
		}
	}
	if err := r.ParseForm(); err == nil {
		if v := r.FormValue(field); v != "" {
			return v
		}
	}
	raw, _ := io.ReadAll(r.Body)
	return string(raw)
}

// ── Helpers de mappeage JSON OpenFGA ────────────────────────────────────────

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asPtrString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func asTypes(parsed map[string]any) []openfga.TypeDefinition {
	raw, _ := parsed["type_definitions"].([]any)
	out := make([]openfga.TypeDefinition, 0, len(raw))
	for _, t := range raw {
		tm, ok := t.(map[string]any)
		if !ok {
			continue
		}
		name := asString(tm["type"])
		if name == "" {
			continue
		}
		out = append(out, openfga.TypeDefinition{
			Type:      name,
			Relations: asRelationsMap(tm["relations"]),
			Metadata:  asMetadata(tm["metadata"]),
		})
	}
	return out
}

func asRelationsMap(v any) *map[string]openfga.Userset {
	raw, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]openfga.Userset, len(raw))
	for name, body := range raw {
		bm, ok := body.(map[string]any)
		if !ok {
			continue
		}
		out[name] = asUserset(bm)
	}
	return &out
}

func asUserset(m map[string]any) openfga.Userset {
	u := openfga.Userset{}
	if v, ok := m["this"]; ok {
		if mm, ok := v.(map[string]any); ok {
			u.This = &mm
		}
	}
	if v, ok := m["computedUserset"]; ok {
		if mm, ok := v.(map[string]any); ok {
			u.ComputedUserset = &openfga.ObjectRelation{
				Object:   asPtrString(asString(mm["object"])),
				Relation: asPtrString(asString(mm["relation"])),
			}
		}
	}
	if v, ok := m["tupleToUserset"]; ok {
		if mm, ok := v.(map[string]any); ok {
			ttu := &openfga.TupleToUserset{}
			if tsm, ok := mm["tupleset"].(map[string]any); ok {
				ttu.Tupleset = openfga.ObjectRelation{
					Object:   asPtrString(asString(tsm["object"])),
					Relation: asPtrString(asString(tsm["relation"])),
				}
			}
			if cum, ok := mm["computedUserset"].(map[string]any); ok {
				ttu.ComputedUserset = openfga.ObjectRelation{
					Object:   asPtrString(asString(cum["object"])),
					Relation: asPtrString(asString(cum["relation"])),
				}
			}
			u.TupleToUserset = ttu
		}
	}
	if v, ok := m["union"]; ok {
		u.Union = asUsersets(v)
	}
	if v, ok := m["intersection"]; ok {
		u.Intersection = asUsersets(v)
	}
	if v, ok := m["difference"]; ok {
		if mm, ok := v.(map[string]any); ok {
			base, _ := mm["base"].(map[string]any)
			sub, _ := mm["subtract"].(map[string]any)
			u.Difference = &openfga.Difference{
				Base:     asUserset(base),
				Subtract: asUserset(sub),
			}
		}
	}
	return u
}

func asUsersets(v any) *openfga.Usersets {
	mm, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	raw, _ := mm["child"].([]any)
	children := make([]openfga.Userset, 0, len(raw))
	for _, c := range raw {
		if cm, ok := c.(map[string]any); ok {
			children = append(children, asUserset(cm))
		}
	}
	return &openfga.Usersets{Child: children}
}

func asMetadata(v any) *openfga.Metadata {
	mm, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	rels, _ := mm["relations"].(map[string]any)
	if rels == nil {
		return nil
	}
	out := make(map[string]openfga.RelationMetadata, len(rels))
	for name, body := range rels {
		bm, _ := body.(map[string]any)
		rm := openfga.RelationMetadata{}
		if directly, ok := bm["directly_related_user_types"].([]any); ok {
			refs := make([]openfga.RelationReference, 0, len(directly))
			for _, d := range directly {
				if dm, ok := d.(map[string]any); ok {
					ref := openfga.RelationReference{}
					if s, ok := dm["type"].(string); ok {
						ref.Type = s
					}
					if s, ok := dm["relation"].(string); ok && s != "" {
						ref.Relation = &s
					}
					if _, hasWild := dm["wildcard"]; hasWild {
						wc := map[string]interface{}{}
						ref.Wildcard = &wc
					}
					if s, ok := dm["condition"].(string); ok && s != "" {
						ref.Condition = &s
					}
					refs = append(refs, ref)
				}
			}
			rm.DirectlyRelatedUserTypes = &refs
		}
		out[name] = rm
	}
	return &openfga.Metadata{Relations: &out}
}

func asConditions(parsed map[string]any) *map[string]openfga.Condition {
	raw, ok := parsed["conditions"].(map[string]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	out := make(map[string]openfga.Condition, len(raw))
	for name, body := range raw {
		bm, ok := body.(map[string]any)
		if !ok {
			continue
		}
		c := openfga.Condition{
			Name:       asString(bm["name"]),
			Expression: asString(bm["expression"]),
		}
		if params, ok := bm["parameters"].(map[string]any); ok {
			pm := make(map[string]openfga.ConditionParamTypeRef, len(params))
			for pname, pbody := range params {
				pmap, _ := pbody.(map[string]any)
				tn := asString(pmap["type_name"])
				if tn == "" {
					tn = "TYPE_NAME_ANY"
				}
				pm[pname] = openfga.ConditionParamTypeRef{TypeName: openfga.TypeName(tn)}
			}
			c.Parameters = &pm
		}
		out[name] = c
	}
	return &out
}

func asConditionsMap(parsed map[string]any) map[string]openfga.Condition {
	if c := asConditions(parsed); c != nil {
		return *c
	}
	return nil
}
