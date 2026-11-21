// views/store-diff-panel.js — Panneau "Diff avec un autre store".
//
// Permet de sélectionner un 2e store et de comparer ses tuples
// avec le store actif. Affiche un rapport :
//   - X tuples ajoutés (dans B mais pas A)   → vert
//   - Y tuples supprimés (dans A mais pas B) → rouge
//   - Z tuples communs (dans les deux)         → gris
// Et colore les arêtes du graphe courant en fonction du diff.

import { $, escapeHtml } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { connection } from '../config.js';
import { diffTuples, classifyTuple, fetchStoreTuples } from '../lib/store-diff.js';
import { render } from './cards.js';
import { toast } from '../lib/toast.js';

let _initialized = false;
let _diff = null; // StoreDiff courant
let _storeBId = null;

export function initStoreDiffPanel() {
  if (_initialized) return;
  _initialized = true;
  $('btn-compare-store')?.addEventListener('click', openStorePicker);
  $('btn-store-diff-close')?.addEventListener('click', closeStoreDiffPanel);
  $('store-diff-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target === $('store-diff-backdrop')) closeStoreDiffPanel();
  });
  $('btn-store-diff-clear')?.addEventListener('click', clearDiff);
}

/** Ouvre le picker pour choisir le store B. */
function openStorePicker() {
  const sel = $('store-diff-pick-b');
  if (!sel) return;
  // Remplit le select avec les stores disponibles (sauf actif).
  const stores = (connection.stores || [])
    .filter(s => s.id !== connection.storeId);
  sel.innerHTML = stores.map(s =>
    `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
  ).join('');
  $('store-diff-picker')?.classList.add('open');
}

function closeStorePicker() {
  $('store-diff-picker')?.classList.remove('open');
}

/** Lance le diff après que l'utilisateur a choisi le store B. */
async function runDiff() {
  const sel = $('store-diff-pick-b');
  const storeBId = sel?.value;
  if (!storeBId) return;
  _storeBId = storeBId;
  closeStorePicker();
  $('store-diff-backdrop')?.classList.add('open');
  setDiffLoading();
  try {
    const tuplesA = state.tuples || [];
    const tuplesB = await fetchStoreTuples(storeBId, connection.storeId);
    _diff = diffTuples(tuplesA, tuplesB);
    renderDiffReport();
  } catch (e) {
    setDiffError(e.message);
  }
}

function setDiffLoading() {
  const body = $('store-diff-body');
  if (body) body.innerHTML = `<div class="audit-results-loading"><div class="audit-spinner"></div><p>Calcul du diff…</p></div>`;
}

function setDiffError(msg) {
  const body = $('store-diff-body');
  if (body) body.innerHTML = `<p class="audit-error">${escapeHtml(msg)}</p>`;
}

function renderDiffReport() {
  const body = $('store-diff-body');
  if (!body || !_diff) return;
  const storeB = connection.stores?.find(s => s.id === _storeBId);
  const storeAName = connection.storeName || connection.storeId || 'A';
  const storeBName = storeB?.name || _storeBId || 'B';

  body.innerHTML = `
    <div class="store-diff-summary">
      <div class="store-diff-store">
        <strong>${escapeHtml(storeAName)}</strong>
        <span class="store-diff-count">${_diff.aTotal} tuples</span>
      </div>
      <div class="store-diff-arrow">⇄</div>
      <div class="store-diff-store">
        <strong>${escapeHtml(storeBName)}</strong>
        <span class="store-diff-count">${_diff.bTotal} tuples</span>
      </div>
    </div>
    <div class="store-diff-stats">
      <div class="store-diff-stat added">
        <i class="ti ti-plus" aria-hidden="true"></i>
        <strong>${_diff.added.length}</strong>
        <span>ajouté${_diff.added.length > 1 ? 's' : ''}</span>
      </div>
      <div class="store-diff-stat removed">
        <i class="ti ti-minus" aria-hidden="true"></i>
        <strong>${_diff.removed.length}</strong>
        <span>supprimé${_diff.removed.length > 1 ? 's' : ''}</span>
      </div>
      <div class="store-diff-stat common">
        <i class="ti ti-equal" aria-hidden="true"></i>
        <strong>${_diff.common.length}</strong>
        <span>commun${_diff.common.length > 1 ? 's' : ''}</span>
      </div>
    </div>
    <div class="store-diff-toggles">
      <p class="hint">
        Les arêtes du graphe sont maintenant colorées :
        <span class="diff-legend added">vert = ajoutées</span>,
        <span class="diff-legend removed">rouge = supprimées</span>,
        <span class="diff-legend common">gris = communes</span>.
      </p>
    </div>
  `;
  // Badge "Diff actif" dans le view-switch : permet de rouvrir le
  // rapport sans relancer le calcul.
  const switchEl = $('view-switch');
  if (switchEl && !$('diff-active-badge')) {
    const badge = document.createElement('button');
    badge.id = 'diff-active-badge';
    badge.className = 'btn diff-badge';
    badge.title = 'Voir le rapport de diff (cards colorées dans la grille)';
    badge.innerHTML = `<i class="ti ti-arrows-exchange" aria-hidden="true"></i> Diff actif`;
    badge.addEventListener('click', () => {
      $('store-diff-backdrop')?.classList.add('open');
    });
    switchEl.appendChild(badge);
  }
  // Re-render la grille avec les classes CSS de diff.
  render();
}

function clearDiff() {
  _diff = null;
  _storeBId = null;
  $('store-diff-backdrop')?.classList.remove('open');
  $('store-diff-body').innerHTML = '';
  // Masque aussi le badge "Diff actif" dans le toolbar.
  const badge = $('diff-active-badge');
  if (badge) badge.remove();
  render();
}

/** Rouvre le modal rapport (utilisé depuis le badge "Diff actif"). */
export function reopenStoreDiffPanel() {
  if (!_diff) return;
  $('store-diff-backdrop')?.classList.add('open');
}

function closeStoreDiffPanel() {
  // Ferme le modal SANS effacer le diff. L'utilisateur peut ainsi
  // consulter le graph (avec les cards colorées) tout en ayant le
  // rapport sous les yeux. Pour effacer, il a un bouton dédié.
  $('store-diff-backdrop')?.classList.remove('open');
}

/** Exporté pour que cards.js puisse colorer les arêtes. */
export function getCurrentDiff() {
  return _diff;
}

export function classifyCurrentTuple(t) {
  return classifyTuple(t, _diff);
}

// Init au boot : wire le bouton "Compare" dans le picker
document.addEventListener('DOMContentLoaded', () => {
  $('btn-store-diff-run')?.addEventListener('click', runDiff);
  $('btn-store-diff-cancel')?.addEventListener('click', closeStorePicker);
  // Le bouton "Fermer" (X en haut) ferme le modal SANS effacer le
  // diff — les cards restent colorées pour pouvoir comparer visuellement
  // tout en consultant le graph.
  $('btn-store-diff-close')?.addEventListener('click', closeStoreDiffPanel);
});