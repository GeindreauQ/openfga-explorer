// controllers/tuples_io.go — Import / Export / Preview de tuples en JSONL.
//
// Format JSONL : un tuple par ligne, format
// `{"user":"user:alice","relation":"admin","object":"server:lakekeeper"}`.
// Compatible avec les outils de manipulation de JSON classiques
// (jq, awk, sed) et les pipelines shell.
//
// Routes :
//   GET  /api/export/tuples      → Content-Type application/jsonl, un tuple/ligne
//   POST /api/import/tuples      → parse + écrit par lot de 50, retourne
//                                  {imported, failed: [{line, error}]}.
//   POST /api/import/preview     → parse + déduplique SANS écrire, retourne
//                                  {will_import, duplicates_in_batch, failed}.
//                                  Permet un "dry-run" avant de confirmer.

package controllers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
	"github.com/GeindreauQ/openfga-explorer/models"
)

// ImportExportController gère GET /api/export/tuples,
// POST /api/import/tuples et POST /api/import/preview. On le sépare de
// TuplesController pour isoler la logique d'I/O batch (potentiellement
// volumineux) des handlers unitaires de TuplesController.
type ImportExportController struct {
	tuples *TuplesController
	broker *EventBroker
}

// NewImportExportController crée le contrôleur.
func NewImportExportController(tuples *TuplesController, broker *EventBroker) *ImportExportController {
	return &ImportExportController{tuples: tuples, broker: broker}
}

// Export traite GET /api/export/tuples. Renvoie le body en
// `application/jsonl`, un tuple par ligne.
func (c *ImportExportController) Export(w http.ResponseWriter, r *http.Request) {
	if c.tuples.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	storeID := effectiveStoreID(r, c.tuples.openfga)
	tuples, err := c.tuples.openfga.ReadAllTuples(r.Context(), storeID)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/jsonl")
	w.Header().Set("Content-Disposition",
		`attachment; filename="openfga-tuples-`+strconv.FormatInt(int64(len(tuples)), 10)+`.jsonl"`)
	enc := json.NewEncoder(w)
	for _, t := range tuples {
		if err := enc.Encode(t); err != nil {
			// On log mais on n'arrête pas l'export pour un tuple
			// mal formé (ne devrait pas arriver).
			continue
		}
	}
}

// importResultItem représente un échec sur une ligne de l'import ou
// un doublon dans le batch. Même structure pour Import et Preview
// pour que le frontend puisse afficher les erreurs de la même façon.
type importResultItem struct {
	Line  int    `json:"line"`
	Error string `json:"error"`
}

// importResult est la réponse JSON de POST /api/import/tuples.
// `Imported` est le nombre de tuples effectivement écrits ; `Failed`
// liste ceux en erreur (typiquement tuple invalide côté OpenFGA),
// un par entrée, avec ligne d'origine dans le JSONL.
type importResult struct {
	Imported int                `json:"imported"`
	Failed   []importResultItem `json:"failed"`
}

// previewResult est la réponse JSON de POST /api/import/preview. Idem
// `importResult` mais en lecture seule (rien n'est écrit) :
//   - `will_import` = tuples qui seraient effectivement ajoutés après
//     déduplication interne et filtrage des doublons déjà présents ;
//   - `duplicates_in_batch` = tuples en doublon DANS le JSONL fourni
//     (un même tuple écrit deux fois ne compte qu'une fois).
type previewResult struct {
	WillImport        int                `json:"will_import"`
	DuplicatesInBatch int                `json:"duplicates_in_batch"`
	Failed            []importResultItem `json:"failed"`
}

// analyzedTuple : un tuple valide + sa ligne d'origine dans le
// JSONL. On garde le numéro de ligne pour pouvoir le reporter dans
// `Failed` si le batch write échoue (sinon on perd l'info une fois
// les tuples batchés).
type analyzedTuple struct {
	Tuple models.Tuple
	Line  int
}

// analyzeResult est le retour interne de `analyzeTuples` : il
// transporte les tuples validés (sans les doublons du batch) pour
// qu'`Import` puisse les écrire. Preview l'ignore.
type analyzeResult struct {
	Valid             []analyzedTuple
	Failed            []importResultItem
	DuplicatesInBatch int
}

// Import traite POST /api/import/tuples. Lit le body ligne par ligne,
// parse chaque ligne comme un JSON models.Tuple, et écrit par lot
// de 50. Les tuples déjà existants (doublons exacts) sont comptés
// dans `imported` mais n'écrasent pas.
//
// Format body : text/plain ou application/jsonl, un JSON par ligne.
// Exemple :
//
//	{"user":"user:alice","relation":"admin","object":"server:lakekeeper"}
//	{"user":"user:bob","relation":"admin","object":"server:lakekeeper"}
func (c *ImportExportController) Import(w http.ResponseWriter, r *http.Request) {
	if c.tuples.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	if r.Body == nil {
		writeError(w, apperr.New(http.StatusBadRequest, "body vide"))
		return
	}
	defer r.Body.Close()

	analysis, err := analyzeTuples(r.Body)
	if err != nil {
		writeError(w, err)
		return
	}

	result := importResult{Imported: 0, Failed: analysis.Failed}
	batch := make([]analyzedTuple, 0, 50)
	storeID := effectiveStoreID(r, c.tuples.openfga)
	flushBatch := func() {
		if len(batch) == 0 {
			return
		}
		tuples := make([]models.Tuple, len(batch))
		for i, at := range batch {
			tuples[i] = at.Tuple
		}
		if werr := c.tuples.openfga.Write(r.Context(), storeID, tuples, nil); werr != nil {
			log.Printf("tuples_io: write batch failed: %v", werr)
			if rerr := c.tuples.openfga.Write(r.Context(), storeID, nil, tuples); rerr != nil {
				log.Printf("tuples_io: compensating delete also failed: %v (partial state remains in OpenFGA — use /api/import/preview before non-trivial commits)", rerr)
			}
			for _, at := range batch {
				result.Failed = append(result.Failed, importResultItem{
					Line:  at.Line,
					Error: werr.Error(),
				})
			}
		} else {
			result.Imported += len(tuples)
		}
		batch = batch[:0]
	}
	for _, at := range analysis.Valid {
		batch = append(batch, at)
		if len(batch) >= 50 {
			flushBatch()
		}
	}
	flushBatch()
	if c.broker != nil && result.Imported > 0 {
		c.broker.Publish(Event{
			Type:    "tuples.write",
			StoreID: storeID,
			Count:   result.Imported,
			Source:  "import",
		})
	}
	writeJSON(w, http.StatusOK, result)
}

// Preview traite POST /api/import/preview. Lit le body, parse +
// déduplique, mais N'ÉCRIT PAS dans OpenFGA. Renvoie un rapport
// `{will_import, duplicates_in_batch, failed}` que le frontend
// affiche dans une modale de confirmation avant que l'utilisateur
// ne re-clique sur "Importer" pour valider.
//
// Permet à l'utilisateur de voir combien de tuples vont être
// ajoutés et combien de lignes sont invalides AVANT de muter le
// store — critique pour les stores de prod.
func (c *ImportExportController) Preview(w http.ResponseWriter, r *http.Request) {
	if c.tuples.openfga == nil {
		writeError(w, apperr.ErrNotConfigured)
		return
	}
	if r.Body == nil {
		writeError(w, apperr.New(http.StatusBadRequest, "body vide"))
		return
	}
	defer r.Body.Close()

	analysis, err := analyzeTuples(r.Body)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, previewResult{
		WillImport:        len(analysis.Valid),
		DuplicatesInBatch: analysis.DuplicatesInBatch,
		Failed:            analysis.Failed,
	})
}

// analyzeTuples parse le body JSONL ligne par ligne et retourne :
//   - les tuples valides et uniques (dédupliqués au sein du batch),
//     chacun avec son numéro de ligne source
//   - la liste des échecs (ligne + raison)
//   - le nombre de doublons détectés à l'intérieur du batch (lignes
//     sautées mais comptées)
//
// Pas d'accès OpenFGA ici : la fonction est pure (I/O HTTP only).
// C'est ce qui permet à Preview de l'appeler sans risque de mutation.
func analyzeTuples(body io.Reader) (*analyzeResult, error) {
	result := &analyzeResult{
		Valid:  []analyzedTuple{},
		Failed: []importResultItem{},
	}
	seen := make(map[string]bool) // dédup intra-batch
	reader := bufio.NewReader(body)
	lineNum := 0
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil && err != io.EOF {
			return nil, apperr.New(http.StatusBadRequest, "lecture: "+err.Error())
		}
		if len(line) > 0 {
			lineNum++
			trimmed := strings.TrimSpace(string(line))
			if trimmed != "" {
				var t models.Tuple
				if jerr := json.Unmarshal([]byte(trimmed), &t); jerr != nil {
					result.Failed = append(result.Failed, importResultItem{
						Line:  lineNum,
						Error: fmt.Sprintf("JSON invalide: %s", jerr.Error()),
					})
				} else if t.User == "" || t.Relation == "" || t.Object == "" {
					result.Failed = append(result.Failed, importResultItem{
						Line:  lineNum,
						Error: "tuple incomplet (user/relation/object requis)",
					})
				} else {
					k := t.User + "#" + t.Relation + "@" + t.Object
					if seen[k] {
						result.DuplicatesInBatch++
						continue
					}
					seen[k] = true
					result.Valid = append(result.Valid, analyzedTuple{Tuple: t, Line: lineNum})
				}
			}
		}
		if err == io.EOF {
			break
		}
	}
	return result, nil
}
