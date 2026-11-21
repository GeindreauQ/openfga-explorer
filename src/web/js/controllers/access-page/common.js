// controllers/access-page/common.js — Briques partagées des onglets de la
// page Accès : contexte (modèle, tuples, cluster), champs de formulaire,
// rendu des chemins d'accès.

import { escapeHtml } from '../../lib/dom.js';
import { state, setTuples } from '../../lib/state.js';
import { fetchTuples } from '../../lib/api.js';
import { isKubernetesModel } from '../../lib/k8s.js';
import { knownObjects, explainAccess, splitObject } from '../../lib/access.js';

const CLUSTER_KEY = 'openfga-explorer.access.cluster';

/** Contexte courant : modèle, tuples, et cluster si le modèle est celui du webhook. */
export function context() {
  const model = state.storeModel;
  const k8s = isKubernetesModel(model);
  return { model, tuples: state.tuples || [], k8s, cluster: k8s ? clusterName() : '' };
}

/** Cluster choisi : saisie de l'en-tête, sinon le premier cluster connu, sinon "default". */
export function clusterName() {
  const input = document.getElementById('access-cluster');
  const typed = input?.value.trim();
  if (typed) return typed;
  const known = knownObjects(state.tuples || [], 'cluster');
  return known.length ? splitObject(known[0])[1] : 'default';
}

export function initClusterField() {
  const input = document.getElementById('access-cluster');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  try { input.value = localStorage.getItem(CLUSTER_KEY) || ''; } catch { /* stockage indisponible */ }
  input.addEventListener('change', () => {
    try { localStorage.setItem(CLUSTER_KEY, input.value.trim()); } catch { /* idem */ }
    input.dispatchEvent(new CustomEvent('access-cluster-changed', { bubbles: true }));
  });
}

export function refreshClusterField(ctx) {
  const wrap = document.getElementById('access-cluster-wrap');
  if (wrap) wrap.hidden = !ctx.k8s;
  const list = document.getElementById('access-cluster-list');
  if (list) list.innerHTML = options(knownObjects(ctx.tuples, 'cluster').map(o => splitObject(o)[1]));
  const input = document.getElementById('access-cluster');
  if (input && !input.value) input.placeholder = clusterName();
}

/**
 * Tuples de rattachement que le webhook ajoute à chaque requête
 * (cluster:<c> cluster namespace:<ns>) : sans eux, les droits donnés sur le
 * cluster ne descendent pas sur les namespaces dans OpenFGA.
 */
export function clusterLinks(ctx, namespaces) {
  if (!ctx.k8s) return [];
  return namespaces.map(ns => ({ user: `cluster:${ctx.cluster}`, relation: 'cluster', object: ns }));
}

/** Recharge les tuples du store après une écriture. */
export async function reloadTuples() {
  setTuples(await fetchTuples());
}

export function options(values, selected) {
  return values.map(v => `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

export function field(label, control, hint = '') {
  return `<label class="access-field"><span class="access-label">${label}</span>${control}${hint ? `<span class="access-hint">${hint}</span>` : ''}</label>`;
}

/** Badge d'un objet ou sujet OpenFGA : type en discret, id en évidence. */
export function ref(value) {
  const [type, rest] = splitObject(value);
  return `<span class="access-ref"><span class="access-ref-type">${escapeHtml(type)}:</span>${escapeHtml(rest)}</span>`;
}

export function relationChip(rel, kind = '') {
  return `<span class="access-rel ${kind}">${escapeHtml(rel)}</span>`;
}

/**
 * Rend les chemins qui expliquent un accès. Chaque chemin se lit de gauche
 * à droite : l'appartenance au groupe, le tuple qui donne le droit, puis
 * les rattachements jusqu'à l'objet demandé.
 */
export function renderPaths(paths, { contextual = [] } = {}) {
  if (!paths.length) {
    return '<p class="access-empty-line">Aucun chemin trouvé dans les tuples : l\'accès peut venir d\'une condition, d\'un joker ou d\'un modèle plus profond que ce que l\'explorer suit.</p>';
  }
  const isContextual = t => contextual.some(c => c.user === t.user && c.relation === t.relation && c.object === t.object);
  const step = (t, i) => `${i ? '<i class="ti ti-arrow-narrow-right access-path-arrow" aria-hidden="true"></i>' : ''}
    <span class="access-path-step${isContextual(t) ? ' contextual' : ''}" title="${isContextual(t) ? 'tuple contextuel (ajouté à la requête, non stocké)' : 'tuple stocké'}">
      ${ref(t.user)} ${relationChip(t.relation)} ${ref(t.object)}
    </span>`;
  return `<ol class="access-paths">${paths.slice(0, 6).map(p => `<li>${[p.membership, p.tuple, ...p.via].filter(Boolean).map(step).join('')}</li>`).join('')}</ol>`;
}

export function explain(ctx, extraTuples, subject, object, relation) {
  return explainAccess({ model: ctx.model, tuples: [...ctx.tuples, ...extraTuples], subject, object, relation });
}

export function loading(text = 'Chargement…') {
  return `<div class="access-loading"><i class="ti ti-loader-2 spin" aria-hidden="true"></i> ${escapeHtml(text)}</div>`;
}

export function emptyState(icon, title, text) {
  return `<div class="access-empty"><i class="ti ${icon}" aria-hidden="true"></i><strong>${escapeHtml(title)}</strong><span>${text}</span></div>`;
}

/** Lance des requêtes avec au plus `limit` en parallèle. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
