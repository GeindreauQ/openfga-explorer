// controllers/home-stats.js — Contenu de l'accueil : store actif,
// chiffres, répartition des tuples par type et par relation.
//
// Lit `state.tuples`, `state.storeModel` et `connection`.

import { state } from '../lib/state.js';
import { escapeHtml } from '../lib/dom.js';
import { getResolvedStoreModel, cfg } from '../models/types.js';
import { connection } from '../config.js';
import { isKubernetesModel } from '../lib/k8s.js';
import { typeClass } from '../lib/type-style.js';

const TOP = 8;

const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

export function refreshHomeStats() {
  const tuples = state.tuples || [];
  const model = getResolvedStoreModel();
  let relCount = 0;
  for (const rels of model.relations.values()) relCount += rels.size;

  setText('home-stat-tuples', tuples.length.toLocaleString('fr-FR'));
  setText('home-stat-types', String(model.types.size));
  setText('home-stat-relations', String(relCount));
  setText('home-stat-stores', String(connection.stores?.length || 0));

  // En-tête : nom du store, identifiants, nature du modèle.
  const k8s = isKubernetesModel(state.storeModel);
  const storeName = connection.storeName || connection.stores?.find(st => st.id === connection.storeId)?.name;
  setText('home-title', connection.storeId ? (storeName || connection.storeId) : 'Aucun store sélectionné');
  const sub = document.getElementById('home-sub');
  if (sub) {
    const parts = [];
    if (connection.storeId) parts.push(`<span>store <code>${escapeHtml(connection.storeId)}</code></span>`);
    if (state.authorizationModelId) parts.push(`<span>modèle <code>${escapeHtml(state.authorizationModelId)}</code></span>`);
    if (k8s) parts.push('<span><i class="ti ti-brand-kubernetes" aria-hidden="true"></i> modèle du webhook Kubernetes</span>');
    if (!connection.configured) parts.push('<span>OpenFGA n\'est pas configuré côté serveur.</span>');
    else if (!connection.storeId) parts.push('<span>Choisissez un store dans la barre du haut.</span>');
    sub.innerHTML = parts.join('');
  }
  const kubectl = document.getElementById('home-task-kubectl');
  if (kubectl) kubectl.hidden = !k8s;

  const byType = new Map();
  const byRelation = new Map();
  for (const t of tuples) {
    const type = t.object.split(':')[0];
    byType.set(type, (byType.get(type) || 0) + 1);
    byRelation.set(t.relation, (byRelation.get(t.relation) || 0) + 1);
  }
  renderBars('home-types', byType, type => {
    const c = cfg(type);
    return `<i class="ti ${escapeHtml(c.icon || 'ti-circle-dot')} type-text ${typeClass(type)}" aria-hidden="true"></i>${escapeHtml(type)}`;
  });
  renderBars('home-relations', byRelation, rel => escapeHtml(rel));
}

function renderBars(id, counts, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    el.innerHTML = '<li class="home-empty">Aucun tuple dans ce store.</li>';
    return;
  }
  const max = rows[0][1];
  const shown = rows.slice(0, TOP);
  const rest = rows.slice(TOP).reduce((n, [, v]) => n + v, 0);
  el.innerHTML = shown.map(([key, n]) => `
    <li class="home-bar">
      <span class="home-bar-label" title="${escapeHtml(key)}">${label(key)}</span>
      <span class="home-bar-track" aria-hidden="true"><span class="home-bar-fill" data-pct="${Math.max(2, (n / max) * 100).toFixed(1)}"></span></span>
      <span class="home-bar-value">${n.toLocaleString('fr-FR')}</span>
    </li>`).join('') +
    (rest ? `<li class="home-empty">et ${rows.length - TOP} autres (${rest.toLocaleString('fr-FR')} tuples)</li>` : '');
  // Largeurs via CSSOM : la CSP refuse les attributs style.
  el.querySelectorAll('.home-bar-fill').forEach(f => { f.style.width = f.dataset.pct + '%'; });
}

document.addEventListener('store-model-changed', refreshHomeStats);
