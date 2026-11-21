package controllers

import (
	"context"
	"net/http"
	"time"

	"github.com/GeindreauQ/openfga-explorer/config"
	"github.com/GeindreauQ/openfga-explorer/internal/openfgaclient"
)

// HealthController gère les endpoints /api/health et /api/health/live.
//
// /api/health/live est une sonde minimale (process up, pas d'I/O) pour
// les liveness/readiness probes Kubernetes. /api/health garde le JSON
// détaillé mais sans les champs sensibles (storeId, openfgaUrl,
// authDisabled) qui étaient jusqu'ici exposés sans authentification.
//
// /api/health/detail est exposé sous auth.Middleware pour les
// intégrateurs qui ont besoin de la liste complète des champs (URL
// upstream, ID de store, etc.).
type HealthController struct {
	cfg         config.Config
	openfga     openfgaclient.OpenFGA
	pingTimeout time.Duration
}

func NewHealthController(cfg config.Config, openfga openfgaclient.OpenFGA) *HealthController {
	return &HealthController{cfg: cfg, openfga: openfga, pingTimeout: 2 * time.Second}
}

// ServeHTTP implémente /api/health. Réponse JSON minimaliste — pas
// d'info sensible (storeId, openfgaUrl, authDisabled). Pour la version
// détaillée, voir /api/health/detail (auth-gated).
func (h *HealthController) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	status, _ := h.pingOpenFGA(r)
	httpStatus := http.StatusOK
	s := "ok"
	if status == "down" {
		s = "degraded"
		httpStatus = http.StatusServiceUnavailable
	}
	writeJSON(w, httpStatus, map[string]any{
		"status":  s,
		"openfga": status,
	})
}

// Live implémente /api/health/live. Renvoie toujours 200 tant que le
// process tourne. Aucun I/O — adapté aux liveness probes K8s qui ne
// doivent pas échouer quand OpenFGA est down (sinon le Pod est tué
// alors que l'Explorer lui-même est sain).
func (h *HealthController) Live(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// Detail implémente /api/health/detail (auth-gated). Renvoie le JSON
// complet incluant storeId, openfgaUrl, authDisabled — utile pour
// les outils de supervision qui ont un cookie de session.
func (h *HealthController) Detail(w http.ResponseWriter, r *http.Request) {
	storeID := ""
	if h.openfga != nil {
		storeID = effectiveStoreID(r, h.openfga)
	}
	status, pingErr := h.pingOpenFGA(r)

	resp := map[string]any{
		"status":       "ok",
		"configured":   h.cfg.ConfiguredOpenFGA(),
		"storeId":      storeID,
		"openfgaUrl":   h.cfg.OpenFGA.URL,
		"authDisabled": h.cfg.Auth.Disabled,
		"openfga":      status,
	}
	if status == "down" {
		resp["status"] = "degraded"
		if pingErr != nil {
			resp["openfgaError"] = pingErr.Error()
		}
		writeJSON(w, http.StatusServiceUnavailable, resp)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// pingOpenFGA renvoie le statut ("up"/"down"/"skipped") et l'erreur
// brute si applicable. L'erreur est exposée seulement sur /detail.
func (h *HealthController) pingOpenFGA(r *http.Request) (status string, err error) {
	if h.openfga == nil || !h.cfg.ConfiguredOpenFGA() {
		return "skipped", nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.pingTimeout)
	defer cancel()
	if pingErr := h.openfga.Ping(ctx); pingErr != nil {
		return "down", pingErr
	}
	return "up", nil
}
