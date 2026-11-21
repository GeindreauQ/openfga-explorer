// État applicatif partagé et dérivation des nœuds à partir des tuples.

import { parseType, parseId } from './dom.js';

/** État mutable de l'application. */
export const state = {
  tuples: [],                 // liste de { user, relation, object }
  activeTypes: new Set(),     // filtres de type ; vide = tous les types
  currentView: 'cards',       // 'cards' | 'graph'
  currentModalNode: null,     // nœud affiché dans la modale de détail
  // AST du modèle d'autorisation du store actif. Alimenté par
  // loadDSL() après chaque switch de store. Les vues qui ont besoin
  // des "relations directement assignables" / "sujets autorisés"
  // lisent ce cache. Toujours issu de l'introspection OpenFGA
  // (GET /stores/{id}/authorization_models) — pas de fallback fichier.
  storeModel: null,
  // ID de l'authorization model actif. Mis à jour par loadDSL() à
  // partir de la réponse de GET /api/dsl.
  authorizationModelId: null,
  // Timestamp de la dernière mutation locale (write/import/delete).
  // Utilisé par le listener SSE pour éviter de refetch quand un
  // event tuples.write correspond à NOTRE propre écriture (le round-trip
  // réseau a déjà ramené l'état à jour).
  lastLocalWriteAt: 0,
  // Liste tampon : tuples en attente de commit.
  // Quand l'utilisateur clique "Ajouter + push", le tuple est ajouté
  // ici au lieu d'être pushé immédiatement. Il sera pushé en bloc
  // via "Commit all" depuis le panneau Tampon.
  // Format : Array<{tuple: {user, relation, object}, id: string, addedAt: number}>.
  pendingAdds: [],
  // Idem pour les suppressions en attente.
  pendingRemoves: [],
  // Focus voisinage : nœud racine + profondeur HOP.
  // Partagé entre la vue cartes et la vue graphe (Cytoscape).
  focusRoot: '',
  focusDepth: 0,
};

/** Ajoute un tuple au tampon. */
export function addToPending(tuple) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.pendingAdds.push({ tuple, id, addedAt: Date.now() });
}

/** Retire un tuple du tampon par id. */
export function removeFromPending(id) {
  state.pendingAdds = state.pendingAdds.filter(p => p.id !== id);
  state.pendingRemoves = state.pendingRemoves.filter(p => p.id !== id);
}

/** Vide le tampon (après un commit ou un discard). */
export function clearPending() {
  state.pendingAdds = [];
  state.pendingRemoves = [];
}

/** Compte les tuples en attente. */
export function pendingCount() {
  return state.pendingAdds.length + state.pendingRemoves.length;
}

/** Remplace l'ensemble des tuples et réinitialise les filtres de type. */
export function setTuples(tuples) {
  state.tuples = tuples;
  state.activeTypes.clear();
}

/** Met à jour l'AST du modèle actif. Appelé par loadDSL(). */
export function setStoreModel(parsed) {
  state.storeModel = parsed;
  // Les pages qui dépendent du modèle (Accès, accueil) se mettent à jour.
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('store-model-changed'));
}

/** Bascule un type dans la sélection de filtres. */
export function toggleType(type) {
  if (state.activeTypes.has(type)) state.activeTypes.delete(type);
  else state.activeTypes.add(type);
}

/**
 * Construit la liste des nœuds (objets et sujets) à partir des tuples,
 * avec leurs relations entrantes et sortantes. Les usersets « type:id#rel »
 * sont rattachés au nœud de base « type:id ».
 */
export function buildAllNodes() {
  const map = {};
  for (const t of state.tuples) {
    ['user', 'object'].forEach(side => {
      const raw = t[side].split('#')[0];
      const type = parseType(raw);
      const id = parseId(raw);
      if (!map[raw]) map[raw] = { raw, type, id, incoming: [], outgoing: [] };
    });
    const oKey = t.object.split('#')[0];
    const uKey = t.user.split('#')[0];
    if (map[oKey]) map[oKey].incoming.push(t);
    if (map[uKey]) map[uKey].outgoing.push(t);
  }
  return Object.values(map);
}

/** Identifiants déjà présents pour un type donné, triés. */
export function existingIds(type) {
  const ids = new Set();
  buildAllNodes().forEach(n => {
    if (n.type === type) ids.add(n.id);
  });
  return [...ids].sort();
}

// ── Focus voisinage (nœud racine + profondeur HOP) ─────────────────────────
// Extraits de graph-svg.js lors du cleanup de la vue SVG. Ces fonctions
// sont partagées entre la vue cartes, la vue graphe Cytoscape, et le
// contrôleur de focus. Les appels à triggerGraphRender/recomputeFocus
// (spécifiques SVG) ne sont pas reproduits ici — chaque vue réagit
// via ses propres mécanismes (refreshCytoscapeFocus, etc.).

export function setFocusRoot(raw) {
  state.focusRoot = raw || '';
  if (state.focusRoot && state.focusDepth === 0) state.focusDepth = 1;
  if (!state.focusRoot) state.focusDepth = 0;
}

export function setFocusDepth(n) {
  state.focusDepth = Math.max(0, Math.min(5, n | 0));
}

export function clearFocus() {
  state.focusRoot = '';
  state.focusDepth = 0;
}

export function getFocusState() {
  return { root: state.focusRoot, depth: state.focusDepth };
}

export function getFocusableNodes() {
  return buildAllNodes().map(n => ({
    raw: n.raw, type: n.type, id: n.id,
    label: parseType(n.raw) + ':' + n.id,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

export function getRelevantRelations(root, depth) {
  if (!root || depth <= 0) {
    return [...new Set(state.tuples.map(t => t.relation))].sort();
  }
  const adj = {};
  const addEdge = (a, b) => {
    if (a === b) return;
    (adj[a] = adj[a] || new Set()).add(b);
    (adj[b] = adj[b] || new Set()).add(a);
  };
  for (const t of state.tuples) {
    const u = t.user.split('#')[0];
    const o = t.object.split('#')[0];
    if (u && o) addEdge(u, o);
  }
  if (!(root in adj)) {
    const rels = new Set();
    for (const t of state.tuples) {
      if (t.user.split('#')[0] === root || t.object.split('#')[0] === root) rels.add(t.relation);
    }
    if (rels.size === 0) return [...new Set(state.tuples.map(t => t.relation))].sort();
    return [...rels].sort();
  }
  const seen = new Set([root]);
  const dist = { [root]: 0 };
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    const d = dist[cur];
    if (d === depth) continue;
    const neigh = adj[cur];
    if (!neigh) continue;
    for (const n of neigh) {
      if (n in dist) continue;
      dist[n] = d + 1;
      seen.add(n);
      queue.push(n);
    }
  }
  const rels = new Set();
  for (const t of state.tuples) {
    const u = t.user.split('#')[0];
    const o = t.object.split('#')[0];
    if (seen.has(u) || seen.has(o)) rels.add(t.relation);
  }
  if (rels.size === 0) return [...new Set(state.tuples.map(t => t.relation))].sort();
  return [...rels].sort();
}
