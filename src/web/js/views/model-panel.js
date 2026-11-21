// Modale présentant le modèle d'autorisation du STORE ACTIF.
//
// Tout vient de `getResolvedStoreModel()` (peuplé par loadDSL via
// `setActiveStoreModel`). Aucune référence à un schéma hardcodé.
// Si le store n'a pas encore de modèle chargé, on affiche un état
// vide plutôt que d'inventer des types.

import { $, escapeHtml } from '../lib/dom.js';
import { getResolvedStoreModel, cfg, activeModelSource } from '../models/types.js';
import { buildAllNodes } from '../lib/state.js';
import { state } from '../lib/state.js';
import { connection } from '../config.js';
import { typeClass } from '../lib/type-style.js';

/** Ouvre la modale du modèle d'autorisation du store actif. */
export function openModel() {
  const res = getResolvedStoreModel();
  const body = $('model-body');
  const schemaEl = $('model-schema');

  // Header : source courante (store / none) + nom du store.
  const sourceLabel = activeModelSource() === 'store' ? 'store actif' : 'aucun modèle chargé';
  const storeName = connection.storeName || connection.storeId || '—';
  schemaEl.textContent = `— ${sourceLabel} : ${storeName}`;

  // Compteur d'instances par type dans les tuples chargés.
  const counts = {};
  buildAllNodes().forEach(n => counts[n.type] = (counts[n.type] || 0) + 1);

  const types = [...res.types];
  if (types.length === 0) {
    body.innerHTML = `
      <p class="hint">Aucun modèle chargé pour ce store.</p>
      <p class="hint">Ouvre l'éditeur DSL ou applique un modèle via <code>POST /api/dsl/apply</code>.</p>
    `;
    $('model-backdrop').classList.add('open');
    return;
  }

  body.innerHTML = types.sort().map(type => {
    const c = cfg(type);
    const tc = typeClass(type);
    const rels = res.relations.get(type) || new Map();
    const directEntries = [...rels.entries()];
    const instCount = counts[type] || 0;

    const directHtml = directEntries.length
      ? directEntries.map(([rel, specs]) => `
          <div class="tuple-row model-rel-row">
            <span class="rel-badge type-fill ${tc}">${escapeHtml(rel)}</span>
            <span class="tuple-arrow">←</span>
            <span class="model-rel-subjects">${escapeHtml([...specs].join(', '))}</span>
          </div>`).join('')
      : '<p class="hint model-terminal">Aucune relation directe (type terminal).</p>';

    return `
      <div class="model-type">
        <div class="model-type-head">
          <div class="node-icon type-bg ${tc}">
            <i class="ti ${c.icon}" aria-hidden="true"></i>
          </div>
          <div class="model-type-name">
            <div class="node-id">${escapeHtml(type)}</div>
          </div>
          <span class="rel-badge rel-badge-muted">${instCount} instance${instCount > 1 ? 's' : ''}</span>
        </div>
        ${directEntries.length ? `<div class="section-label section-label-first">Relations directes (${directEntries.length})</div>${directHtml}` : ''}
      </div>`;
  }).join('');

  $('model-backdrop').classList.add('open');
}

/** Ferme la modale. */
export function closeModel() {
  $('model-backdrop').classList.remove('open');
}

/** Ferme la modale si le clic vise le fond. */
export function onModelBackdropClick(e) {
  if (e.target === $('model-backdrop')) closeModel();
}

// keep `state` referenced (utilisé indirectement par buildAllNodes).
void state;