// controllers/store.js — Gère la sélection du store actif.
//
// Responsabilités :
//   - appel POST /api/stores/select
//   - mise à jour de l'état de connexion
//   - rechargement des tuples
//   - rechargement du DSL via loadDSL (du controller DSL)
//   - gestion des erreurs + toast

import { $ } from '../lib/dom.js';
import { setStoreModel, setTuples } from '../lib/state.js';
import { fetchTuples, selectStore } from '../lib/api.js';
import { connection, renderIndicator } from '../config.js';
import { render } from '../views/cards.js';
import { syncFocusUI } from './focus.js';
import { clearFocus } from '../lib/state.js';
import { toast } from '../lib/toast.js';
import { setUrlParam } from '../lib/url-state.js';
import { refreshHomeStats } from './home-stats.js';

let _loadFromAPI = async () => {};
let _loadDSL = async () => {};

/** Permet à main.js d'injecter les références cycliques. */
export function wireStore(deps) {
  if (deps.loadFromAPI) _loadFromAPI = deps.loadFromAPI;
  if (deps.loadDSL) _loadDSL = deps.loadDSL;
}

/**
 * Change le store actif côté backend, met à jour l'état de connexion
 * et recharge les tuples. Gère aussi le reset du focus pour repartir
 * d'un état propre.
 *
 * Le dropdown natif change de valeur SYNCHRONEMENT (avant le 1er
 * `await`), ce qui donne l'impression à l'utilisateur que le store a
 * changé alors que les stats (async, ~50ms) montrent encore les
 * anciennes valeurs. On évite ce mismatch en marquant les compteurs
 * "loading" dès l'entrée dans la fonction, puis en restorant les
 * valeurs réelles une fois le switch terminé.
 */
export async function changeStore(storeId) {
  // Cas "Aucun Store Sélectionné" : on clear localement sans appeler
  // le backend. Utile pour que l'utilisateur puisse explicitement
  // remettre à zéro la sélection (l'API backend n'a pas d'endpoint
  // "unset" — on ne peut que sélectionner un store spécifique).
  if (!storeId) {
    connection.storeId = '';
    connection.storeName = '';
    for (const s of connection.stores) s.active = false;
    window.__focusResetClickHistory?.();
    setTuples([]);
    setStoreModel(null);
    render();
    renderIndicator();
    refreshHomeStats();
    document.dispatchEvent(new CustomEvent('connection-refreshed', { detail: { connection } }));
    // Sérialise le "deselect" dans l'URL : on retire la clé store pour
    // refléter qu'aucun store n'est actif.
    setUrlParam('store', '');
    toast('Aucun store sélectionné.');
    return;
  }
  if (storeId === connection.storeId) return;
  markHomeStatsLoading(true);
  try {
    const res = await selectStore(storeId);
    connection.storeId = res.storeId || storeId;
    connection.storeName = res.storeName || connection.stores.find(s => s.id === storeId)?.name || '';
    for (const s of connection.stores) s.active = (s.id === storeId);
    const select = document.getElementById('store-select');
    if (select) select.value = storeId;
    // Sérialise le store actif dans l'URL pour partage / refresh.
    setUrlParam('store', storeId);
    window.__focusResetClickHistory?.();
    clearFocus();
    await _loadFromAPI();
    try { await _loadDSL(); } catch (e) { console.warn('changeStore: loadDSL failed', e); }
    renderIndicator();
    // Met à jour les stats du hero (tuples/types/relations/stores) +
    // déclenche un événement connection-refreshed pour les listeners
    // qui s'abonnent à un changement global.
    markHomeStatsLoading(false);
    refreshHomeStats();
    document.dispatchEvent(new CustomEvent('connection-refreshed', { detail: { connection } }));
    toast(`Store actif : ${connection.storeName || connection.storeId}`);
  } catch (err) {
    markHomeStatsLoading(false);
    toast('Changement de store impossible : ' + err.message, true);
    console.error(err);
    const sel = $('store-select');
    if (sel) sel.value = connection.storeId || '';
  }
}

/**
 * Bascule les compteurs home en état "loading" (tirets) pendant un
 * changement de store, pour éviter que l'utilisateur ne voie les
 * anciennes valeurs pendant la transition async.
 */
function markHomeStatsLoading(loading) {
  for (const id of ['home-stat-tuples', 'home-stat-types', 'home-stat-relations']) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (loading) {
      if (!el.dataset.prev) el.dataset.prev = el.textContent;
      el.textContent = '—';
    } else {
      delete el.dataset.prev;
    }
  }
}

/**
 * Charge les tuples depuis OpenFGA via le backend. Exposé ici pour
 * main.js (qui peut l'appeler depuis l'init).
 */
export async function loadFromAPI() {
  if (!connection.configured) {
    toast('OpenFGA non configuré côté serveur', true);
    return;
  }
  if (!connection.storeId) {
    toast('Aucun store sélectionné — choisis-en un dans la toolbar', true);
    return;
  }
  try {
    const tuples = await fetchTuples();
    setTuples(tuples);
    render();
    syncFocusUI();
    refreshHomeStats();
    toast(`${tuples.length} tuples chargés depuis ${connection.storeName || connection.storeId}`);
  } catch (err) {
    toast('Erreur : ' + err.message, true);
    console.error(err);
  }
}