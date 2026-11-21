// controllers/audit-page/index.js — Orchestrateur de la page Audit.
//
// Gère :
//   - showAuditPage() : entrée de page, init paresseuse, refresh au
//     changement de store
//   - onAuditResultsClick() : handler délégué sur le panneau de
//     résultats pour les boutons "Pourquoi ?" (Reverse/Forward)
//   - renderForm() : dispatch vers renderCheckForm/Reverse/Forward
//   - initAuditResizer() : split-pane redimensionnable
//
// API publique : seule `showAuditPage` est consommée par le router
// (import dynamique, cf. controllers/router.js).

import { $ } from '../../lib/dom.js';
import { state } from '../../lib/state.js';
import { isGraphActive, destroyGraph } from '../../views/graph.js';
import { renderCheckForm, renderReverseForm, renderForwardForm } from './forms.js';
import { renderEmptyResults } from './panel.js';
import { fetchAndRenderWhy } from './why.js';

let _currentMode = 'check';
let _initialized = false;

/** Affiche la page Audit (cache home, montre la section). */
export async function showAuditPage() {
  document.body.classList.remove('home-shown');
  $('home-dashboard')?.setAttribute('hidden', '');
  document.body.classList.remove('dsl-shown', 'audit-shown', 'io-shown');
  // Cache toutes les autres pages plein écran pour éviter qu'elles
  // restent visibles en arrière-plan (et que la dernière visitée
  // apparaisse en bas de la nouvelle page via scroll-down).
  for (const id of ['dsl-page', 'audit-page', 'io-page']) {
    $(id)?.setAttribute('hidden', '');
  }
  document.body.classList.add('audit-shown');
  $('audit-page')?.removeAttribute('hidden');

  if (isGraphActive()) destroyGraph();

  if (!_initialized) {
    _initialized = true;
    $('audit-home')?.addEventListener('click', async () => {
      const { showHome } = await import('../router.js');
      showHome();
    });
    document.querySelectorAll('#audit-tabs .audit-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-audit-mode');
        if (mode === _currentMode) return;
        _currentMode = mode;
        document.querySelectorAll('#audit-tabs .audit-tab').forEach(b => {
          const isActive = b.getAttribute('data-audit-mode') === mode;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', String(isActive));
        });
        renderForm();
      });
    });
    // Event delegation sur le panneau de résultats pour les boutons
    // "Pourquoi ?" (Reverse/Forward). On écoute au niveau du
    // conteneur pour ne pas avoir à rebrancher les handlers à chaque
    // re-render de la liste.
    $('audit-results')?.addEventListener('click', onAuditResultsClick);
    // Re-render automatique au changement de store. Sans ce hook, si
    // l'utilisateur est sur la page Audit quand il change de store,
    // le formulaire continue d'afficher les types/relations de
    // l'ancien store (et un éventuel résultat précédent reste figé).
    // `changeStore` (store.js) appelle déjà `loadDSL()` puis dispatch
    // `connection-refreshed` — on s'y cale pour repeupler les selects
    // et vider le panneau de résultats.
    document.addEventListener('connection-refreshed', () => {
      if ($('audit-page') && !$('audit-page').hasAttribute('hidden')) {
        renderForm();
        renderEmptyResults();
      }
    });
    initAuditResizer();
  }

  // Si le modèle n'a pas encore été chargé pour ce store (l'utilisateur a
  // cliqué la tuile Audit avant que loadDSL n'ait fini), on attend.
  if (!state.storeModel) {
    try {
      const { loadDSL } = await import('../dsl-page.js');
      await loadDSL();
    } catch (e) {
      console.warn('audit: loadDSL failed', e);
    }
  }

  renderForm();
  renderEmptyResults();
}

/** Rend le formulaire + zone de résultats pour le mode courant. */
function renderForm() {
  const root = $('audit-content');
  if (!root) return;
  root.innerHTML = '';
  const model = state.storeModel;
  if (!model) {
    root.innerHTML = '<p class="hint hint-padded">Aucun modèle d\'autorisation chargé pour ce store. Sélectionnez un store avec un modèle.</p>';
    renderEmptyResults('Sélectionnez un store avec un authorization model pour utiliser l\'audit.');
    return;
  }
  if (_currentMode === 'check') renderCheckForm(root);
  else if (_currentMode === 'reverse') renderReverseForm(root);
  else if (_currentMode === 'forward') renderForwardForm(root);
  // À chaque changement de mode, on remet le panneau de résultats à
  // l'état "ready" — les résultats du mode précédent n'ont plus de
  // sens.
  renderEmptyResults();
}

/**
 * Handler délégué sur #audit-results : réagit aux clics sur les
 * boutons `.audit-why-btn` (Reverse / Forward). Au premier clic, on
 * fetch /api/audit/expand et on rend l'arbre inline. Aux clics
 * suivants, on toggle juste l'ouverture.
 */
async function onAuditResultsClick(ev) {
  const btn = ev.target.closest('.audit-why-btn');
  if (!btn) return;
  const user = btn.dataset.whyUser;
  const relation = btn.dataset.whyRelation;
  const object = btn.dataset.whyObject;
  const li = btn.closest('li.audit-list-item');
  if (!li) return;
  const detail = li.querySelector('.audit-why-detail');
  if (!detail) return;
  // Si déjà chargé, on toggle juste l'affichage (pas de refetch).
  if (detail.dataset.loaded === '1') {
    detail.hidden = !detail.hidden;
    btn.classList.toggle('active', !detail.hidden);
    return;
  }
  // Premier clic : fetch + render.
  detail.hidden = false;
  btn.classList.add('active');
  await fetchAndRenderWhy(detail, { user, relation, object });
  detail.dataset.loaded = '1';
}

/** Initialise le séparateur redimensionnable du split-pane Audit. */
function initAuditResizer() {
  const resizer = $('audit-resizer');
  const split = $('audit-split');
  const left = $('audit-pane-form');
  if (!resizer || !split || !left) return;
  let dragging = false;
  let startX = 0;
  let startRatio = 0.42;
  resizer.addEventListener('mousedown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    const cs = window.getComputedStyle(left);
    const w = left.getBoundingClientRect().width;
    const total = split.getBoundingClientRect().width;
    startRatio = total > 0 ? w / total : 0.42;
    document.body.style.cursor = 'col-resize';
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const dx = ev.clientX - startX;
    const newRatio = Math.max(0.25, Math.min(0.7, startRatio + dx / rect.width));
    left.style.flex = `${newRatio} ${newRatio} 0`;
    const right = $('audit-pane-results');
    if (right) right.style.flex = `${1 - newRatio} ${1 - newRatio} 0`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  });
}