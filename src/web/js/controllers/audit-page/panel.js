// controllers/audit-page/panel.js — Helpers du panneau de résultats.
//
// Centralise les 3 manipulations possibles du panneau de droite :
//   - setResults(html)        : remplace le contenu par du HTML
//   - setResultsLoading(text) : affiche un spinner + message
//   - renderEmptyResults(msg) : remet l'état "ready" (placeholder vide)
//
// Module pur (aucun import interne audit-page), pour éviter les cycles
// avec les autres modules du dossier (forms ↔ run ↔ index).

import { $, escapeHtml } from '../../lib/dom.js';

/** Affiche un état vide/placeholder dans le panneau de résultats. */
export function renderEmptyResults(message) {
  const out = $('audit-results');
  if (!out) return;
  const msg = message || 'Lance une requête pour voir les résultats ici.';
  out.innerHTML = `
    <div class="audit-results-empty">
      <i class="ti ti-arrow-narrow-right" aria-hidden="true"></i>
      <p>${escapeHtml(msg)}</p>
    </div>`;
}

/** Helper : écrit du HTML dans le panneau de résultats (droite). */
export function setResults(html) {
  const out = $('audit-results');
  if (out) out.innerHTML = html;
}

/** Helper : affiche un état "loading" dans le panneau de résultats. */
export function setResultsLoading(text) {
  setResults(`<div class="audit-results-loading">
    <div class="audit-spinner" aria-hidden="true"></div>
    <p>${escapeHtml(text || 'Requête en cours…')}</p>
  </div>`);
}