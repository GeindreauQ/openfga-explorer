// views/dsl-graph/index.js — Orchestrateur du graphe DSL.
//
// Re-exporte l'API publique attendue par les consumers
// (controllers/dsl-page.js : `import * as dslGraph from '../views/dsl-graph.js'`).
// Le path d'import `../views/dsl-graph.js` est résolu en
// `../views/dsl-graph/index.js` par le module resolver natif ESM.
//
// Toute la logique est dans les modules siblings : state, layout, panels,
// render. Ce fichier ne fait que :
//   1. Monter le DOM (toolbar + svg + panels) ;
//   2. Câbler les events (pan/zoom/drag/click delegation) ;
//   3. Exposer init/setData/getSelectedNode/getPinnedEdge/destroy.

import { dslToGraph } from '../../models/dsl.js';
import { state, noop } from './state.js';
import {
  layoutAndRender, fitToView, zoomBy, zoomAtPoint, svgPointFromEvent, startNodeDrag,
} from './layout.js';
import { renderSidePanel, renderEdgePanel, renderLegend } from './panels.js';
import { render, onNodeClick } from './render.js';

// ── Montage du DOM ──────────────────────────────────────────────────────

/**
 * Génère le HTML complet de la vue (toolbar + SVG + side panel +
 * edge panel). Centralisé ici pour qu'init() reste lisible.
 */
function buildShellHTML() {
  return `
    <div class="dsl-graph-wrap">
      <div class="dsl-graph-toolbar">
        <span class="dsl-graph-title"><i class="ti ti-eye" aria-hidden="true"></i> Previewer</span>
        <div class="dsl-graph-stats" aria-label="Statistiques du graphe">
          <span class="dsl-graph-stat" title="Nombre de types/nœuds">
            <i class="ti ti-shape" aria-hidden="true"></i>
            <span id="dsl-graph-stat-nodes">0</span>
            <span class="dsl-graph-stat-suffix">types</span>
          </span>
          <span class="dsl-graph-stat" title="Nombre d'arêtes dédupliquées">
            <i class="ti ti-arrow-big-right-line" aria-hidden="true"></i>
            <span id="dsl-graph-stat-edges">0</span>
            <span class="dsl-graph-stat-suffix">liens</span>
          </span>
        </div>
        <div class="dsl-graph-toolbar-actions">
          <button class="icon-btn" id="dsl-graph-zoom-out" title="Zoom −" type="button" aria-label="Zoom arrière">
            <i class="ti ti-zoom-out" aria-hidden="true"></i>
          </button>
          <button class="icon-btn" id="dsl-graph-zoom-in" title="Zoom +" type="button" aria-label="Zoom avant">
            <i class="ti ti-zoom-in" aria-hidden="true"></i>
          </button>
          <button class="icon-btn" id="dsl-graph-fit" title="Adapter à la vue" type="button" aria-label="Adapter à la vue">
            <i class="ti ti-arrows-fit" aria-hidden="true"></i>
          </button>
          <button class="icon-btn" id="dsl-graph-relayout" title="Ré-équilibrer la disposition" type="button" aria-label="Relancer le layout">
            <i class="ti ti-refresh" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="dsl-graph-body" id="dsl-graph-body">
        <div class="dsl-graph-hint" id="dsl-graph-hint">
          <i class="ti ti-pointer" aria-hidden="true"></i>
          Survolez une arête pour voir les relations, cliquez pour l'épingler
        </div>
        <div class="dsl-graph-empty" id="dsl-graph-empty" hidden>
          <div class="dsl-graph-empty-icon">
            <i class="ti ti-graph-off" aria-hidden="true"></i>
          </div>
          <h3>Aucun type à visualiser</h3>
          <p>Ajoutez des <code>type</code> dans l'éditeur de gauche pour voir le graphe se construire.</p>
        </div>
        <svg class="dsl-graph-svg" id="dsl-graph-svg" aria-label="Aperçu du modèle">
          <g id="dsl-graph-root"></g>
        </svg>
        <aside class="dsl-edge-panel" id="dsl-edge-panel" hidden aria-label="Détails de la relation">
          <div class="dsl-edge-panel-header">
            <h3 id="dsl-edge-panel-title">—</h3>
            <button class="icon-btn" id="dsl-edge-panel-close" title="Fermer" aria-label="Fermer">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          </div>
          <div class="dsl-edge-panel-body" id="dsl-edge-panel-body"></div>
        </aside>
        <aside class="dsl-side-panel" id="dsl-side-panel" hidden aria-label="Détails du nœud">
          <div class="dsl-side-header">
            <h3 id="dsl-side-title">—</h3>
            <span class="dsl-side-badge" id="dsl-side-badge">—</span>
          </div>
          <div class="dsl-side-body" id="dsl-side-body"></div>
        </aside>
      </div>
    </div>
  `;
}

// ── Câblage des events (pan / zoom / drag / click delegation) ────────────

function wireEvents() {
  // Hover/click sur arête (délégation sur le SVG).
  state.svg.addEventListener('mousemove', (ev) => {
    const t = ev.target;
    if (!t || !t.getAttribute) return;
    const id = t.getAttribute('data-edge');
    if (id) {
      if (state.hoveredEdge !== id) { state.hoveredEdge = id; render(); }
    } else if (state.hoveredEdge) {
      state.hoveredEdge = null; render();
    }
  });
  state.svg.addEventListener('mouseleave', () => {
    if (state.hoveredEdge) { state.hoveredEdge = null; render(); }
  });
  state.svg.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.getAttribute) return;
    const id = t.getAttribute('data-edge');
    if (id) {
      ev.stopPropagation();
      state.pinnedEdge = (state.pinnedEdge === id) ? null : id;
      state.selectedNode = null;
      renderEdgePanel();
      renderSidePanel();
      render();
    }
  });

  // Zoom molette — centré sur la position de la souris.
  state.container.querySelector('#dsl-graph-body').addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = state.svg.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) / rect.width;
    const my = (ev.clientY - rect.top) / rect.height;
    zoomAtPoint(factor, mx, my);
  }, { passive: false });

  // Pan au drag du fond + drag de nœud : écouteurs globaux car ils
  // survivent à la sortie du curseur de la zone SVG.
  const body = state.container.querySelector('#dsl-graph-body');
  body.addEventListener('mousedown', (ev) => {
    if (ev.target.tagName !== 'rect' || ev.target.getAttribute('fill') !== 'transparent') return;
    state.pan = { startX: ev.clientX, startY: ev.clientY, origX: state.viewBox.x, origY: state.viewBox.y };
    state.svg.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (ev) => {
    if (state.pan) {
      const rect = state.svg.getBoundingClientRect();
      const dx = (ev.clientX - state.pan.startX) * (state.viewBox.w / rect.width);
      const dy = (ev.clientY - state.pan.startY) * (state.viewBox.h / rect.height);
      state.viewBox.x = state.pan.origX - dx;
      state.viewBox.y = state.pan.origY - dy;
      state.svg.setAttribute('viewBox', `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.w} ${state.viewBox.h}`);
    } else if (state.dragNode) {
      const pt = svgPointFromEvent(ev);
      if (!pt) return;
      const dx = pt.x - state.layout[state.dragNode.id].x;
      const dy = pt.y - state.layout[state.dragNode.id].y;
      if (Math.abs(dx - state.dragNode.offsetX) > 1 || Math.abs(dy - state.dragNode.offsetY) > 1) {
        state.dragNode.moved = true;
      }
      state.layout[state.dragNode.id] = { x: pt.x - state.dragNode.offsetX, y: pt.y - state.dragNode.offsetY };
      render();
    }
  });
  document.addEventListener('mouseup', () => {
    if (state.pan) { state.pan = null; state.svg.style.cursor = 'grab'; }
    if (state.dragNode) {
      if (state.dragNode.moved) state.suppressNextClick = true;
      state.dragNode = null;
      state.svg.style.cursor = 'grab';
    }
  });

  // Clic sur une ligne du tableau de relations (side panel) :
  // ouvre la modale d'édition de la relation dans l'éditeur.
  state.container.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-rel]');
    if (!tr) return;
    const relName = tr.getAttribute('data-rel').split(':')[0].trim();
    if (relName && state.onRelationClick) state.onRelationClick(relName);
  });

  // Clic sur le fond (rect transparent du SVG) : ferme tous les panneaux.
  state.svg.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'rect' && ev.target.getAttribute('fill') === 'transparent') {
      let changed = false;
      if (state.selectedNode) { state.selectedNode = null; renderSidePanel(); changed = true; }
      if (state.pinnedEdge)   { state.pinnedEdge = null;   renderEdgePanel();   changed = true; }
      if (changed) {
        render();
        if (state.onNodeClick) state.onNodeClick(null, false);
      }
    }
  });

  // Boutons toolbar.
  state.container.querySelector('#dsl-graph-fit').addEventListener('click', fitToView);
  state.container.querySelector('#dsl-graph-zoom-in').addEventListener('click', () => zoomBy(1.25));
  state.container.querySelector('#dsl-graph-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  state.container.querySelector('#dsl-graph-relayout').addEventListener('click', () => {
    if (!state.nodes.length) return;
    state.lastSig = ''; // force le recalcul
    layoutAndRender(render);
  });
  state.container.querySelector('#dsl-edge-panel-close')?.addEventListener('click', () => {
    state.pinnedEdge = null;
    renderEdgePanel();
    render();
  });
}

// ── API publique ────────────────────────────────────────────────────────

export function init(container, { onNodeClick, onAddRelation, onRelationClick } = {}) {
  state.container = container;
  state.onNodeClick = onNodeClick || noop;
  state.onAddRelation = onAddRelation || noop;
  state.onRelationClick = onRelationClick || noop;

  container.innerHTML = buildShellHTML();

  state.svg = container.querySelector('#dsl-graph-svg');
  state.root = container.querySelector('#dsl-graph-root');

  wireEvents();
}

export async function setData(parsed) {
  const raw = dslToGraph(parsed);
  state.nodes = raw.nodes;
  // Adapte la sortie de dslToGraph (source/target/label) au format
  // dédupliqué interne (from/to/relations).
  state.edges = dedupeDslEdges(raw.edges);
  state.nodeById = new Map(state.nodes.map(n => [n.id, n]));
  state.selectedNode = null;
  state.hoveredNode = null;
  state.hoveredEdge = null;
  state.pinnedEdge = null;
  state.lastSig = `${state.nodes.length}|${state.edges.length}|${state.edges.map(e => e.from + '>' + e.to).sort().join('|')}`;
  // Active l'animation d'entrée pour ce set de données uniquement
  // (évite qu'elle rejoue à chaque render, ce qui causait un flicker
  // sur hover/click).
  state.animateEntry = true;
  renderLegend();
  renderSidePanel();
  renderEdgePanel();
  render();
  state.animateEntry = false;
  const hint = state.container?.querySelector('#dsl-graph-hint');
  if (hint) hint.hidden = true;
  await layoutAndRender(render);
}

/**
 * Déduplique les arêtes DSL par couple (from, to). Délègue à
 * `dedupeEdges` de state.js en convertissant d'abord le format
 * `dslToGraph` (source/target/label) en (from/to/label).
 */
function dedupeDslEdges(rawEdges) {
  const adapted = rawEdges.map(e => ({
    from: e.source,
    to: e.target,
    label: e.label,
    type: e.type,
    style: e.style,
  }));
  // Import dynamique évité : state.js n'exporte pas dedupeEdges par
  // défaut pour éviter un cycle — on importe via state.js à la racine.
  // Note : on importe ici plutôt qu'en haut pour conserver la localité.
  // En pratique, c'est appelé 1× par setData (pas dans la hot path).
  return runDedupe(adapted);
}

// Import tardif de dedupeEdges (depuis state.js) pour éviter un cycle
// init → render → layout → state → init. Le coût est nul à l'exécution
// (ESM hoist les imports de fonctions).
import { dedupeEdges as runDedupe } from './state.js';

export function getSelectedNode() {
  if (!state.selectedNode || !state.nodeById.has(state.selectedNode)) return null;
  return state.nodeById.get(state.selectedNode);
}

export function getPinnedEdge() {
  if (!state.pinnedEdge) return null;
  const [from, to] = state.pinnedEdge.split('|');
  const e = state.edges.find(x => x.from === from && x.to === to);
  return e ? { from: e.from, to: e.to, relations: e.relations } : null;
}

export function destroy() {
  if (state.layoutWorker) {
    state.layoutWorker.terminate();
    state.layoutWorker = null;
  }
  state.pendingResolvers.clear();
  state.container = state.svg = state.root = null;
  state.nodes = []; state.edges = []; state.layout = {};
  state.selectedNode = state.hoveredNode = state.hoveredEdge = state.pinnedEdge = null;
  state.pan = state.dragNode = null;
  state.onNodeClick = state.onAddRelation = null;
}