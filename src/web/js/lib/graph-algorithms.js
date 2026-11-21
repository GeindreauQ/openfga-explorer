// lib/graph-algorithms.js — Algorithmes de graphe sur les tuples.
//
// Toutes les opérations sont PURES et FRONTEND-ONLY : on travaille
// sur `state.tuples` (déjà chargé), pas sur le backend. Le graphe
// est dirigé : un nœud `user:X` pointe vers un nœud `object:Y` via
// une arête étiquetée par la `relation` du tuple.
//
// Algorithmes exposés :
//   - detectCycles()    : cycles dans le graphe de tuples
//   - findShortestPath() : chemin entre 2 nœuds via relations
//   - connectedComponents() : composantes connexes (ignore les users
//     orphelins, ne retourne que les composantes d'objets liés)
//   - blastRadius(node) : tous les users qui peuvent atteindre node
//     via N hops (réutilise la BFS du focus voisinage)
//
// Complexité : O(V + E) pour les 3 premiers, O(V + E) pour blastRadius.
// Adapté à des stores < 100k tuples (au-delà, voir le mode virtualisé
// dans `views/cards.js`).

import { state } from './state.js';

/**
 * Construit un graphe dirigé à partir de state.tuples.
 * Renvoie {nodes: Set<string>, edges: Array<{from, to, relation}>}.
 *
 * Convention : un tuple (user:U, rel, object:O) devient une arête
 * U → O étiquetée `rel`. Le focus voisinage utilise la même
 * convention (cf. graph-svg.js).
 */
export function buildGraph() {
  const nodes = new Set();
  const edges = [];
  for (const t of state.tuples) {
    const u = stripUserset(t.user);
    const o = stripUserset(t.object);
    nodes.add(u);
    nodes.add(o);
    edges.push({ from: u, to: o, relation: t.relation });
  }
  return { nodes, edges };
}

/** Retire le suffixe `#relation` d'un identifiant userset. */
function stripUserset(raw) {
  const i = raw.indexOf('#');
  return i < 0 ? raw : raw.slice(0, i);
}

/**
 * Construit une map d'adjacence forward (u → [(rel, o)]) et reverse
 * (o → [(rel, u)]) à partir de state.tuples.
 */
export function buildAdjacency() {
  const fwd = new Map(); // u → [{rel, o}]
  const rev = new Map(); // o → [{rel, u}]
  for (const t of state.tuples) {
    const u = stripUserset(t.user);
    const o = stripUserset(t.object);
    if (!fwd.has(u)) fwd.set(u, []);
    if (!rev.has(o)) rev.set(o, []);
    fwd.get(u).push({ rel: t.relation, o });
    rev.get(o).push({ rel: t.relation, u });
  }
  return { fwd, rev };
}

/**
 * Détecte les cycles dans le graphe de tuples via DFS 3-couleurs.
 * Renvoie un tableau de cycles, chacun étant un Array<{from, rel, to}>.
 *
 * Algorithme : pour chaque nœud non visité, on lance un DFS. Si
 * on rencontre un nœud en cours de visite (gris), on a un cycle :
 * on extrait le chemin de la pile.
 *
 * Note : O(V + E) mais peut être coûteux sur des graphes denses.
 */
export function detectCycles() {
  const adj = buildAdjacency();
  const color = new Map(); // node → 0 (white) / 1 (gray) / 2 (black)
  const stack = [];
  const cycles = [];
  const seenCycle = new Set(); // dédup par signature de nœuds

  function dfs(node) {
    color.set(node, 1);
    stack.push(node);
    const nexts = adj.fwd.get(node) || [];
    for (const { rel, o } of nexts) {
      const c = color.get(o) || 0;
      if (c === 1) {
        // Back-edge : cycle. On extrait de la pile.
        const idx = stack.indexOf(o);
        if (idx >= 0) {
          const cycNodes = stack.slice(idx);
          cycNodes.push(o); // ferme le cycle
          // Signature pour dédup (triée)
          const sig = [...cycNodes].sort().join('→');
          if (!seenCycle.has(sig)) {
            seenCycle.add(sig);
            const cycEdges = [];
            for (let i = 0; i < cycNodes.length - 1; i++) {
              cycEdges.push({ from: cycNodes[i], to: cycNodes[i + 1], relation: '→' });
            }
            cycles.push(cycEdges);
          }
        }
      } else if (c === 0) {
        dfs(o);
      }
    }
    color.set(node, 2);
    stack.pop();
  }

  for (const node of adj.fwd.keys()) {
    if (!color.get(node)) dfs(node);
  }
  // Les nœuds qui n'ont que des arêtes entrantes ne sont jamais
  // visités depuis fwd.keys(). On les visite aussi pour ne pas
  // rater de cycles qui ne commencent pas par une source.
  const allNodes = new Set([...adj.fwd.keys(), ...adj.rev.keys()]);
  for (const node of allNodes) {
    if (!color.get(node)) dfs(node);
  }
  return cycles;
}

/**
 * Trouve le plus court chemin entre `from` et `to` via BFS.
 * Renvoie un Array<{from, rel, to}> ou null si pas de chemin.
 *
 * Note : "plus court" = moins d'arêtes, pas pondéré. Les tuples
 * OpenFGA n'ont pas de poids sémantique.
 */
export function findShortestPath(from, to) {
  if (from === to) return [];
  const adj = buildAdjacency();
  if (!adj.fwd.has(from)) return null;
  const visited = new Set([from]);
  const queue = [[from]];
  while (queue.length > 0) {
    const path = queue.shift();
    const last = path[path.length - 1];
    const nexts = adj.fwd.get(last) || [];
    for (const { rel, o } of nexts) {
      if (visited.has(o)) continue;
      const newPath = [...path, o];
      if (o === to) {
        // Convertit en arêtes.
        const edges = [];
        for (let i = 0; i < newPath.length - 1; i++) {
          const edge = (adj.fwd.get(newPath[i]) || [])
            .find(e => e.o === newPath[i + 1]);
          edges.push({
            from: newPath[i],
            relation: edge?.rel || '?',
            to: newPath[i + 1],
          });
        }
        return edges;
      }
      visited.add(o);
      queue.push(newPath);
    }
  }
  return null;
}

/**
 * Renvoie les composantes connexes du graphe en suivant UNIQUEMENT
 * les arêtes forward (un user vers ses objects). Chaque composante
 * est un Array<string> de nœuds.
 *
 * On retourne des arrays (pas des Sets) pour faciliter la sérialisation
 * JSON (Set → {} par défaut dans JSON.stringify).
 *
 * Cas d'usage : identifier des "îlots" de données non liés (= signe
 * de modèle mal conçu, e.g. 2 systèmes qui n'ont aucun lien entre
 * eux dans le même store).
 */
export function connectedComponents() {
  const adj = buildAdjacency();
  const allNodes = new Set([...adj.fwd.keys(), ...adj.rev.keys()]);
  const visited = new Set();
  const components = [];
  for (const start of allNodes) {
    if (visited.has(start)) continue;
    const comp = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop();
      if (visited.has(n)) continue;
      visited.add(n);
      comp.add(n);
      for (const { o } of adj.fwd.get(n) || []) {
        if (!visited.has(o)) stack.push(o);
      }
      // Pas de follow des arêtes inverses : on ne groupe que ce qui
      // est lié dans le sens user → object.
    }
    components.push([...comp]);
  }
  // Tri : composantes les plus grosses d'abord.
  components.sort((a, b) => b.length - a.length);
  return components;
}

/**
 * Blast radius : depuis un nœud racine, BFS forward jusqu'à N hops.
 * Renvoie un Array<string> des nœuds atteignables (sans la racine).
 *
 * Note : très similaire à getReachableNodes() du focus voisinage.
 * Ici on l'expose comme algorithme générique, consommable par
 * d'autres UI (audit, diff, etc.).
 */
export function blastRadius(root, depth = 3) {
  const adj = buildAdjacency();
  const reachable = new Set();
  if (depth <= 0) return [];
  let frontier = [stripUserset(root)];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const n of frontier) {
      const outs = adj.fwd.get(n) || [];
      for (const { o } of outs) {
        if (!reachable.has(o) && o !== stripUserset(root)) {
          reachable.add(o);
          next.push(o);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return [...reachable];
}