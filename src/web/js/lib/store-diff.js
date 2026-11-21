// lib/store-diff.js — Diff entre 2 stores : calcule les tuples ajoutés,
// retirés et inchangés entre le store actif et un second store.
//
// Compare les tuples de 2 stores OpenFGA et catégorise chaque
// tuple en `added` (dans B mais pas A), `removed` (dans A mais pas
// B) ou `common` (dans les 2).
//
// Pas d'appel backend : on fetch /api/tuples sur les 2 stores (via
// /api/stores/select) et on compare en mémoire. Plus simple que
// d'appeler /api/tuples/diff (qui prend 2 listes de tuples en body)
// et plus rapide (pas de sérialisation/désérialisation).

import { selectStore, fetchTuples } from './api.js';

/**
 * @typedef {Object} StoreDiff
 * @property {Array<{user, relation, object}>} added    — dans B, pas dans A
 * @property {Array<{user, relation, object}>} removed  — dans A, pas dans B
 * @property {Array<{user, relation, object}>} common   — dans les deux
 * @property {number} aTotal
 * @property {number} bTotal
 */

/**
 * Calcule le diff entre 2 listes de tuples.
 * @returns {StoreDiff}
 */
export function diffTuples(tuplesA, tuplesB) {
  const keyOf = t => `${t.user}#${t.relation}@${t.object}`;
  const setA = new Set(tuplesA.map(keyOf));
  const setB = new Set(tuplesB.map(keyOf));
  const added = [];
  const removed = [];
  const common = [];
  for (const t of tuplesA) {
    if (setB.has(keyOf(t))) common.push(t);
    else removed.push(t);
  }
  for (const t of tuplesB) {
    if (!setA.has(keyOf(t))) added.push(t);
  }
  return {
    added,
    removed,
    common,
    aTotal: tuplesA.length,
    bTotal: tuplesB.length,
  };
}

/**
 * Catégorise un tuple par rapport à un diff.
 * Renvoie 'added' | 'removed' | 'common' | 'unchanged' (pas dans A ni B).
 */
export function classifyTuple(t, diff) {
  if (!diff) return 'unchanged';
  const k = `${t.user}#${t.relation}@${t.object}`;
  if (diff.added.some(x => `${x.user}#${x.relation}@${x.object}` === k)) return 'added';
  if (diff.removed.some(x => `${x.user}#${x.relation}@${x.object}` === k)) return 'removed';
  if (diff.common.some(x => `${x.user}#${x.relation}@${x.object}` === k)) return 'common';
  return 'unchanged';
}

/**
 * Récupère les tuples d'un store via le backend.
 * Le store est spécifié via POST /api/stores/select (on bascule
 * temporairement le store actif, puis on le restore).
 *
 * Note : c'est "sale" de muter l'état global du backend, mais c'est
 * le seul moyen de réutiliser /api/tuples (qui lit le store actif).
 * On restore le store original à la fin.
 */
export async function fetchStoreTuples(storeId, currentStoreId) {
  await selectStore(storeId);
  try {
    const tuples = await fetchTuples();
    return tuples;
  } finally {
    if (currentStoreId) {
      await selectStore(currentStoreId);
    }
  }
}