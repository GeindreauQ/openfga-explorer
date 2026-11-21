// views/dsl-graph/state.js — État partagé + helpers purs pour le graphe DSL.
//
// Toutes les autres briques du graphe DSL (layout, panels, render,
// interactions) importent ce module pour accéder à l'état mutable et
// aux helpers sans dépendance circulaire.
//
// Les helpers *purs* (svgEl, escapeHtml, dedupeEdges, classifyRelation)
// sont stateless et peuvent être réutilisés par d'autres views si besoin.

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── État mutable du graphe ────────────────────────────────────────────────
//
// Conservé dans un objet unique pour permettre le split en plusieurs
// fichiers sans casser le couplage temporel : tous les modules voient
// les mêmes références et peuvent muter librement. `init()` reset
// l'état à chaque mount.
export const state = {
  // DOM
  container: null,
  svg: null,
  root: null,

  // Données
  nodes: [],
  edges: [],
  nodeById: new Map(),
  layout: {},

  // Viewport
  transform: { tx: 0, ty: 0, scale: 1 },
  viewBox: { x: 0, y: 0, w: 800, h: 600 },

  // Sélection / interaction
  selectedNode: null,
  hoveredNode: null,
  hoveredEdge: null,
  pinnedEdge: null,
  pan: null,
  dragNode: null,
  suppressNextClick: false,

  // Animation
  animateEntry: false,

  // Layout worker
  layoutWorker: null,
  latestGen: 0,
  pendingResolvers: new Map(),

  // Signatures / caches
  lastSig: '',

  // Callbacks utilisateur (branchés dans init)
  onNodeClick: null,
  onAddRelation: null,
  onRelationClick: null,
};

// ── Helpers DOM / SVG ────────────────────────────────────────────────────

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function noop() {}

// ── Helpers purs (logique de graphe) ─────────────────────────────────────

/**
 * Transforme la liste d'arêtes produite par `dslToGraph` en arêtes
 * dédupliquées par couple (from, to). Chaque arête consolidée contient
 * la liste de toutes les relations qui la justifient.
 *
 * Chaque arête a pour `label` l'expression complète (`X: a or b`,
 * `Y: viewer from parent`, etc.) au lieu du seul nom de relation.
 * On dédup par (from, to) et on concatène les labels pour afficher
 * tous les usages dans l'infobulle d'arête.
 */
export function dedupeEdges(rawEdges) {
  const map = new Map();
  for (const e of rawEdges) {
    const key = `${e.from}__${e.to}`;
    if (!map.has(key)) {
      map.set(key, {
        from: e.from,
        to: e.to,
        relations: [],
        allLabels: new Set(),
        type: e.type,
        style: e.style,
      });
    }
    const agg = map.get(key);
    if (!agg.allLabels.has(e.label)) {
      agg.allLabels.add(e.label);
      agg.relations.push(e.label);
    }
  }
  // Tri alphabétique pour la stabilité du tooltip.
  for (const agg of map.values()) agg.relations.sort();
  return [...map.values()];
}

/**
 * Classifie une relation (extraite de son label composé) pour le tableau
 * du side panel. Le label a la forme "nom: expression" ; on regarde
 * l'expression pour classifier.
 */
export function classifyRelation(rel) {
  const colonIdx = rel.indexOf(':');
  const expr = colonIdx >= 0 ? rel.slice(colonIdx + 1).trim() : rel;

  let cls = 'direct', label = 'Direct', style = 'solid';
  if (expr.startsWith('#')) {
    cls = 'computed'; label = 'Computed userset'; style = 'dashed';
  } else if (expr.includes(' or ')) {
    cls = 'union'; label = 'Union (or)'; style = 'solid';
  } else if (expr.includes(' and ')) {
    cls = 'intersection'; label = 'Intersection (and)'; style = 'solid';
  } else if (expr.includes(' from ')) {
    cls = 'tupleToUserset'; label = 'Tuple-to-userset'; style = 'dashed';
  } else if (expr.includes(' but not ')) {
    cls = 'difference'; label = 'Difference'; style = 'solid';
  } else if (expr.includes('*') || expr.includes('∅')) {
    cls = 'wildcard'; label = 'Wildcard'; style = 'dashed';
  } else if (expr === 'this' || expr === '' || /^\w+$/.test(expr)) {
    cls = 'direct'; label = 'Direct this'; style = 'solid';
  }
  return { cls, label, style };
}