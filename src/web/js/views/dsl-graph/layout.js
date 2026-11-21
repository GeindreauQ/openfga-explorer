// views/dsl-graph/layout.js — Layout force-directed (Web Worker) +
// manipulation du viewBox (zoom / fit) et drag des nœuds.
//
// Toutes les fonctions lisent/écrivent dans `state` (cf. state.js).
// Pas de dépendance vers les autres modules internes du graphe.

import { state } from './state.js';

// ── Worker force-directed ─────────────────────────────────────────────────

/**
 * Retourne l'instance singleton du worker. Si elle n'existe pas encore,
 * on la crée avec les handlers standards (résolution des promises par
 * `gen`, drop des réponses orphelines).
 */
export function ensureWorker() {
  if (state.layoutWorker) return state.layoutWorker;
  state.layoutWorker = new Worker(
    // Le worker est partagé avec views/graph-svg.js (lui-même
    // sibling de views/dsl-graph/ dans views/), donc chemin parent.
    new URL('../graph-layout-worker.js', import.meta.url),
    { type: 'module' }
  );
  state.layoutWorker.onmessage = (ev) => {
    const { gen, positions } = ev.data;
    const pending = state.pendingResolvers.get(gen);
    if (!pending) return;
    state.pendingResolvers.delete(gen);
    pending.resolve({ gen, positions });
  };
  state.layoutWorker.onerror = (e) => {
    console.error('dsl layout worker error:', e.message || e);
    for (const [, pending] of state.pendingResolvers) {
      pending.resolve({ gen: -1, positions: {} });
    }
    state.pendingResolvers.clear();
  };
  return state.layoutWorker;
}

/**
 * Déclenche un calcul de layout asynchrone. Renvoie une Promise<{gen,
 * positions}> — le caller vérifie ensuite que `gen` correspond bien à
 * la dernière demande (course possible si l'utilisateur clique "Relancer
 * le layout" pendant un calcul en cours).
 */
export function requestLayout(nodes, edges, W, H, warmStart) {
  const worker = ensureWorker();
  const gen = ++state.latestGen;
  return new Promise((resolve) => {
    state.pendingResolvers.set(gen, { resolve });
    // Le worker attend {raw, incoming, outgoing} pour les nodes et
    // {from, to} pour les edges — on adapte depuis le format DSL.
    const wNodes = nodes.map(n => ({
      raw: n.id,
      incoming: edges.filter(e => e.to === n.id).map(e => e.from),
      outgoing: edges.filter(e => e.from === n.id).map(e => e.to),
    }));
    const wEdges = edges.map(e => ({ from: e.from, to: e.to }));
    worker.postMessage({ gen, nodes: wNodes, edges: wEdges, W, H, positions: warmStart });
  });
}

/**
 * Lance un layout asynchrone puis merge dans `state.layout`. La fonction
 * `onDone` est appelée une fois le merge terminé (typiquement `render`).
 *
 * Comportement clé : on préserve les positions dragées par l'utilisateur
 * pendant le calcul. Si un drag a eu lieu, la position du worker est
 * ignorée pour ce nœud.
 */
export async function layoutAndRender(onDone) {
  if (!state.nodes.length) return;
  // Calcule la taille du SVG (réel ou fallback).
  const rect = state.svg.getBoundingClientRect();
  const W = rect.width || 700;
  const H = rect.height || 700;

  // Warm-start : préserve les positions actuelles (drags utilisateur).
  const warmStart = {};
  for (const n of state.nodes) {
    if (state.layout[n.id]) warmStart[n.id] = { x: state.layout[n.id].x, y: state.layout[n.id].y };
  }
  const { gen, positions } = await requestLayout(state.nodes, state.edges, W, H, warmStart);
  // Course : un nouveau layout a commencé entre-temps → on jette.
  if (gen !== state.latestGen) return;
  // Merge : garde les positions dragées si elles ont changé pendant le calcul.
  for (const id in positions) {
    if (!warmStart[id] || !state.layout[id]
        || (warmStart[id].x === state.layout[id].x && warmStart[id].y === state.layout[id].y)) {
      state.layout[id] = positions[id];
    }
  }
  fitViewToGraph(60);
  if (onDone) onDone();
}

// ── ViewBox (zoom + fit) ──────────────────────────────────────────────────

/**
 * Ajuste le viewBox pour englober tous les nœuds, avec padding. Le
 * viewBox est en coordonnées du modèle, pas en pixels écran.
 */
export function fitViewToGraph(padding = 60) {
  if (!state.svg) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id in state.layout) {
    const p = state.layout[id];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return;
  // Rayon max des nœuds pour le padding (les labels sont en dessous).
  let maxR = 30;
  for (const id in state.layout) {
    const deg = (state.edges.filter(e => e.from === id || e.to === id).length);
    maxR = Math.max(maxR, Math.min(34, 16 + deg * 2));
  }
  // Padding symétrique : on centre le viewBox sur le centre du bbox
  // (avec un offset vertical pour les labels sous les nœuds).
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2 + maxR / 2;
  const halfW = (maxX - minX) / 2 + maxR + padding;
  const halfH = (maxY - minY) / 2 + maxR + padding + 20; // +20 pour le label
  state.viewBox = { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
  state.svg.setAttribute('viewBox', `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.w} ${state.viewBox.h}`);
}

export function fitToView() { fitViewToGraph(60); }

/**
 * Zoom programmatique (depuis les boutons toolbar). Le zoom centré
 * reste sur le centre du viewBox courant.
 */
export function zoomBy(factor) {
  const newW = state.viewBox.w / factor;
  const newH = state.viewBox.h / factor;
  state.viewBox.x += (state.viewBox.w - newW) / 2;
  state.viewBox.y += (state.viewBox.h - newH) / 2;
  state.viewBox.w = newW;
  state.viewBox.h = newH;
  state.svg.setAttribute('viewBox', `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.w} ${state.viewBox.h}`);
}

/**
 * Zoom centré sur un point donné (utilisé par le wheel handler).
 * `mx`, `my` sont des ratios 0..1 dans le rect SVG.
 */
export function zoomAtPoint(factor, mx, my) {
  const newW = state.viewBox.w / factor;
  const newH = state.viewBox.h / factor;
  state.viewBox.x += (state.viewBox.w - newW) * mx;
  state.viewBox.y += (state.viewBox.h - newH) * my;
  state.viewBox.w = newW;
  state.viewBox.h = newH;
  state.svg.setAttribute('viewBox', `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.w} ${state.viewBox.h}`);
}

// ── Drag ──────────────────────────────────────────────────────────────────

/**
 * Convertit un événement souris en coordonnées SVG (model space),
 * en utilisant la matrice de transformation du SVG.
 */
export function svgPointFromEvent(ev) {
  if (!state.svg) return null;
  const pt = state.svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(state.svg.getScreenCTM().inverse());
}

/**
 * Démarre un drag sur un nœud. L'offset entre la position de la souris
 * et le centre du nœud est préservé pour que le nœud ne "saute" pas.
 */
export function startNodeDrag(ev, node) {
  if (ev.button !== 0) return;
  const p = state.layout[node.id];
  if (!p) return;
  const pt = svgPointFromEvent(ev);
  if (!pt) return;
  state.dragNode = { id: node.id, offsetX: pt.x - p.x, offsetY: pt.y - p.y, moved: false };
  state.svg.style.cursor = 'grabbing';
}