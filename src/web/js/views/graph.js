// Renderer graphe basé sur Cytoscape.js — renderer par défaut depuis
// la suppression de l'ancienne vue SVG force-directed.
//
// Comportement :
//   - clic nœud = focus voisinage (1er clic) puis modale (2e clic)
//   - slider HOP = atténuation opacity 0.18 sur les nœuds hors voisinage
//   - clic fond = reset du focus
//   - fit + recentrage sur la racine
//   - légende des types présents (sous le graphe)
//   - drag des nœuds + pan/zoom à la molette
//
// Choix techniques (alignés sur les built-in Cytoscape) :
//   - Layout `breadthfirst` (built-in, hiérarchique) — donne un rendu
//     naturellement lisible pour les graphes OpenFGA orientés hiérarchie
//     (server → project → warehouse → namespace → table/view).
//   - `cy.batch()` pour grouper les changements de classes (DOM
//     notification unique → perf x5 sur les graphes denses).
//   - `cy.collection().bfs()` pour le calcul du voisinage (au lieu d'un
//     BFS écrit à la main).
//   - `cy.style().fromJson()` / `cy.style()` selectors pour appliquer
//     les styles de focus de manière déclarative.
//   - `cy.animate({...})` pour les transitions de caméra.
//
// Initialisation paresseuse (import dynamique du bundle ESM Cytoscape
// depuis le CDN `jsdelivr`).

import { $ } from '../lib/dom.js';
import { canvasCfg } from '../models/types.js';
import { token } from '../lib/color-scheme.js';
import { state } from '../lib/state.js';
import { typeClass } from '../lib/type-style.js';

// ── État module-level ────────────────────────────────────────────────────────
let cy = null;
let cyContainer = null;
let cyLoaded = false;
let cyLoading = null;

// État focus fourni par main.js (cf. `graph.js getFocusState`).
// On ne duplique pas l'état : on demande à chaque recalcul.
let focusProvider = null;

const CY_CDN = '/vendor/cytoscape.esm.mjs';
let cyAttempts = 0;

/** Permet à main.js d'injecter le provider d'état de focus. */
export function setGraphFocusProvider(fn) { focusProvider = fn; }

// ── Chargement paresseux ─────────────────────────────────────────────────────
function loadCytoscape() {
  if (cyLoaded && cy) return Promise.resolve(cy);
  if (cyLoading) return cyLoading;
  // Le navigateur garde en mémoire l'échec d'un import() : un nouvel
  // essai passe par une URL distincte pour refaire vraiment la requête.
  const url = cyAttempts++ ? `${CY_CDN}?retry=${cyAttempts}` : CY_CDN;
  cyLoading = import(/* @vite-ignore */ url)
    .then(mod => {
      const cyLib = mod.default || mod.cytoscape || mod;
      if (typeof cyLib !== 'function') {
        throw new Error('Cytoscape ESM: export par défaut introuvable');
      }
      cyLoaded = true;
      return cyLib;
    })
    .catch(err => { cyLoading = null; throw err; });
  return cyLoading;
}

// ── Conteneur DOM ────────────────────────────────────────────────────────────
function ensureContainer() {
  if (cyContainer && document.body.contains(cyContainer)) return cyContainer;
  const wrap = $('graph-wrap');
  if (!wrap) return null;
  const div = document.createElement('div');
  div.id = 'cy-mount';
  div.setAttribute('role', 'img');
  div.setAttribute('aria-label', 'Graphe des relations');
  // Fond explicite + coins arrondis pour délimiter clairement la zone
  // Cyto (le canvas Cytoscape est transparent, on doit donc définir
  // un fond distinctif pour que la vue ne se "fonde" pas dans le reste).
  div.style.cssText = [
    'width:100%',
    'height:100%',
    'display:none',
    'background:var(--graph-bg)',
    'border-radius:10px',
    'box-shadow:inset 0 0 0 1px var(--border-weak)',
  ].join(';');
  wrap.appendChild(div);
  cyContainer = div;
  return div;
}

// ── Construction des éléments (nodes + edges) ───────────────────────────────
function tuplesToElements(nodes) {
  const elements = [];
  const visible = new Set(nodes.map(n => n.raw));

  for (const n of nodes) {
    const c = canvasCfg(n.type);
    elements.push({
      data: { id: n.raw, label: n.id, type: n.type, color: c.border, bg: c.bg, textColor: c.text },
      classes: 'cy-node',
    });
  }

  // Déduplication des arêtes (user, relation, object). Cytoscape détecte
  // automatiquement les doublons d'ID, mais on construit l'ID nous-mêmes
  // pour rester déterministe (cf. rerenders).
  // On tronque les labels longs (max 18 chars) pour éviter les chevauchements
  // sur les graphes denses.
  const seen = new Set();
  for (const t of state.tuples) {
    const u = t.user.split('#')[0];
    const o = t.object.split('#')[0];
    if (!visible.has(u) || !visible.has(o) || u === o) continue;
    const key = u + '|' + t.relation + '|' + o;
    if (seen.has(key)) continue;
    seen.add(key);
    const shortLabel = t.relation.length > 18 ? t.relation.slice(0, 16) + '…' : t.relation;
    elements.push({
      data: { id: key, source: u, target: o, relation: shortLabel, fullRelation: t.relation },
      classes: 'cy-edge',
    });
  }

  return elements;
}

// ── Layout (built-in Cytoscape) ──────────────────────────────────────────────
/**
 * Construit les options de layout force-directed `cose` de Cytoscape
 * (Compound Spring Embedder). C'est un layout built-in (pas d'extension
 * à charger via CDN) qui produit un rendu organique et équilibré pour
 * les graphes de toute taille. Il gère naturellement les graphes
 * denses (multi-arêtes, clusters) sans alignement hiérarchique rigide,
 * ce qui convient bien aux graphes OpenFGA où la structure n'est pas
 * strictement arborescente (un même type peut être référencé par
 * plusieurs relations).
 *
 * Paramètres clés :
 *   - `nodeRepulsion` : force de répulsion entre nœuds (↑ = plus d'espace)
 *   - `idealEdgeLength` : longueur idéale d'arête au repos
 *   - `edgeElasticity` : rigidité du ressort d'arête
 *   - `nestingFactor`  : poids de l'imbrication (ignoré sans compound)
 *   - `gravity`        : attraction vers le centre (stabilise)
 *   - `numIter`        : itérations de la simulation physique
 *   - `randomize`      : réinitialise les positions au début
 *
 * `fit: true` + `padding: 50` ajustent la caméra automatiquement.
 */
function layoutOptions(focusRoot) {
  return {
    name: 'cose',
    animate: false,
    fit: true,
    padding: 50,
    // ── Forces physiques ──
    // Répulsion augmentée (12 000 → 16 000) : avec ~12 nœuds et un
    // focus voisinage, le rendu était trop tassé. La nouvelle valeur
    // aère le graphe tout en gardant les clusters lisibles.
    nodeRepulsion: () => 16000,        // répulsion nœud-nœud (↑ → plus d'espace)
    idealEdgeLength: () => 130,        // longueur d'arête au repos (↑ → arêtes plus longues)
    edgeElasticity: () => 100,         // rigidité du ressort d'arête
    nestingFactor: 1.2,                // poids de l'imbrication (compound)
    gravity: 0.22,                     // attraction vers le centre (anti-derive, ↓ léger)
    numIter: 1500,                     // itérations de la simulation
    randomize: true,                   // réinit positions au début
    // ── Anti-collision ──
    componentSpacing: 70,
    nodeOverlap: 24,                   // marge entre nœuds (px)
    // ── Convergence ──
    coolingFactor: 0.97,               // vitesse de refroidissement
    minTemp: 1,                        // arrêt quand T < 1
  };
}

// ── Style déclaratif (au lieu de classes CSS manuelles) ──────────────────────
/**
 * Style déclaratif passé à `cy.style().fromJson(...)`. Les classes
 * `cy-focus-in`, `cy-focus-out`, `cy-focus-root` (ajoutées par
 * applyFocus) sont stylées ici, ce qui évite de polluer le DOM
 * (Cytoscape gère le style via Canvas/SVG en interne).
 *
 * Design : nœuds en cercles "puces" avec gradient, label externe en
 * dessous avec un fond blanc semi-transparent (très lisible). Arêtes
 * courbes bicolores avec étiquette sur fond blanc. État focus = bordure
 * indigo vive + ombre portée.
 */
function styleConfig() {
  // Cytoscape ne lit pas les variables CSS : on résout les tokens du thème courant.
  const k = {
    text: token('--text-primary'), labelBg: token('--graph-label-bg'), labelBorder: token('--accent-light'),
    edge: token('--graph-edge'), strong: token('--accent-1'), mid: token('--accent-2'), soft: token('--accent-fg'),
  };
  return [
    // ── Nœud : cercle plein + label externe avec fond blanc ──
    {
      selector: 'node',
      style: {
        'background-color': 'data(bg)',
        'border-color':     'data(color)',
        'border-width':     2.5,
        label:              'data(label)',
        color:              k.text,
        'font-size':        12,
        'font-weight':      700,
        'font-family':      'ui-monospace, "SF Mono", Menlo, monospace',
        'text-valign':      'bottom',
        'text-halign':      'center',
        'text-margin-y':    10,
        'text-background-color':   k.labelBg,
        'text-background-opacity': 1,
        'text-background-padding': '3px 6px',
        'text-background-shape':   'roundrectangle',
        'text-border-color':       k.labelBorder,
        'text-border-width':       1,
        'text-border-opacity':     0.6,
        // Halo pour la lisibilité du label contre le canvas
        'text-outline-color': k.labelBg,
        'text-outline-width': 0,
        // Taille dynamique selon le degré (built-in mapData()).
        width:              'mapData(degree, 0, 8, 38, 68)',
        height:             'mapData(degree, 0, 8, 38, 68)',
        'background-opacity': 1,
        // Transitions built-in pour le focus.
        'transition-property': 'background-color, border-width, border-color, opacity, width, height',
        'transition-duration': '180ms',
      },
    },
    // Focus root : bordure épaisse indigo
    {
      selector: 'node.cy-focus-root',
      style: {
        'border-width': 5,
        'border-color': k.strong,
        'background-opacity': 1, opacity: 1,
      },
    },
    // Focus in : opacité pleine (fallback si pas de classe HOP)
    { selector: 'node.cy-focus-in',  style: { opacity: 1, 'background-opacity': 1 } },
    // Variantes par HOP pour le gradient d'opacité. Chaque classe
    // applique une opacité différente (hop 1 = 0.75, hop 2 = 0.50, etc.).
    // On utilise des classes (pas des inline styles) parce que le class
    // style `cy-focus-in { opacity: 1 }` override les inline styles
    // dans cytoscape 3.30.x.
    { selector: 'node.cy-focus-h1',  style: { opacity: 0.75, 'background-opacity': 0.75 } },
    { selector: 'node.cy-focus-h2',  style: { opacity: 0.50, 'background-opacity': 0.50 } },
    { selector: 'node.cy-focus-h3',  style: { opacity: 0.25, 'background-opacity': 0.25 } },
    { selector: 'node.cy-focus-h4',  style: { opacity: 0.10, 'background-opacity': 0.10 } },
    // Focus out : fortement atténué
    { selector: 'node.cy-focus-out', style: { opacity: 0.08, 'background-opacity': 0.08 } },

    // ── Arête : courbe colorée + étiquette fond blanc ──
    {
      selector: 'edge',
      style: {
        'curve-style':              'bezier',
        'control-point-step-size':  40,
        'target-arrow-shape':       'triangle',
        'line-color':               k.edge,
        'target-arrow-color':       k.edge,
        'arrow-scale':              1.1,
        width:                      1.8,
        label:                      'data(relation)',
        'font-size':                10,
        'font-weight':              700,
        'font-family':              'ui-monospace, "SF Mono", Menlo, monospace',
        color:                      k.text,
        'text-rotation':            'autorotate',
        'text-background-color':    k.labelBg,
        'text-background-opacity':  0.96,
        'text-background-padding':  '2px',
        'text-background-shape':    'roundrectangle',
        'text-border-color':        k.labelBorder,
        'text-border-width':        0.8,
        'text-border-opacity':      0.9,
        'transition-property':      'opacity, width, line-color',
        'transition-duration':      '180ms',
      },
    },
    // Opacity par état de focus (identique au graphe SVG)
    { selector: 'edge.cy-focus-in',     style: { opacity: 1,    'line-color': k.strong, width: 2.2 } },
    // Arêtes à gradient HOP (1, 2, 3, 4+)
    { selector: 'edge.cy-focus-h1',     style: { opacity: 0.75, 'line-color': k.strong, width: 2.0 } },
    { selector: 'edge.cy-focus-h2',     style: { opacity: 0.50, 'line-color': k.mid, width: 1.8 } },
    { selector: 'edge.cy-focus-h3',     style: { opacity: 0.25, 'line-color': k.soft, width: 1.6 } },
    { selector: 'edge.cy-focus-h4',     style: { opacity: 0.10, 'line-color': k.soft, width: 1.4 } },
    { selector: 'edge.cy-focus-border', style: { opacity: 0.40, 'line-color': k.soft } },
    { selector: 'edge.cy-focus-out',    style: { opacity: 0.06 } },
  ];
}

// ── Focus voisinage (built-in BFS) ───────────────────────────────────────────
/**
 * Calcule l'ensemble focus avec `cy.collection().bfs()` (built-in
 * Cytoscape) et applique les classes via `cy.batch()` pour minimiser
 * les notifications DOM. C'est l'équivalent le plus direct du
 * `recomputeFocus` maison du graphe SVG.
 *
 * Notes sur l'API BFS Cytoscape :
 *   - `directed: false` → suit les arêtes dans les deux sens
 *   - `visit(n, e, v, i, depth)` est appelé pour chaque nœud
 *   - on s'arrête après `depth` hops avec un cutoff manuel
 */
function applyFocus() {
  if (!cy) return;
  focusSize = 0;
  const fs = focusProvider ? focusProvider() : { root: '', depth: 0 };
  const focusRoot = fs.root;
  const focusDepth = Math.max(0, fs.depth | 0);

  // Reset batch : un seul re-render pour tous les ajouts de classes
  // (au lieu d'un re-render par classe).
  cy.batch(() => {
    // Retire les classes focus-* (incluant les variantes par HOP).
    cy.nodes().removeClass('cy-focus-in cy-focus-out cy-focus-root cy-focus-h1 cy-focus-h2 cy-focus-h3 cy-focus-h4');
    cy.edges().removeClass('cy-focus-in cy-focus-out cy-focus-border cy-focus-h1 cy-focus-h2 cy-focus-h3 cy-focus-h4');

    if (!focusRoot || focusDepth <= 0) return;

    // Vérifie que la racine existe dans le graphe.
    const rootNode = cy.$id(focusRoot);
    if (rootNode.empty()) return;

    // BFS borné à `focusDepth` hops, avec tracking de la distance par
    // nœud. On itère sur `connectedEdges()` (built-in) plutôt que
    // `connectedNodes()` : dans certaines versions de cytoscape,
    // `connectedNodes()` peut retourner 0 alors que `neighborhood()`
    // retourne bien les voisins (bug observé avec cytoscape 3.30.x).
    const dist = new Map();
    dist.set(focusRoot, 0);
    const limited = new Set([focusRoot]);
    let frontier = [rootNode];
    for (let d = 0; d < focusDepth; d++) {
      const next = cy.collection();
      for (const n of frontier) {
        // Itère sur les arêtes connectées et collecte l'autre extrémité
        // (non-directionnel : on suit les arêtes dans les deux sens).
        for (const e of n.connectedEdges()) {
          const other = e.source().id() === n.id() ? e.target() : e.source();
          next.merge(other);
        }
      }
      const newOnes = next.filter(n => !limited.has(n.id()));
      newOnes.forEach(n => {
        limited.add(n.id());
        dist.set(n.id(), d + 1);
      });
      frontier = newOnes;
      if (newOnes.empty()) break;
    }
    focusSize = limited.size;

    // Opacité en fonction du HOP. Le gradient donne une hiérarchie
    // visuelle claire : la racine est pleine opacité, hop 1 légèrement
    // atténué, hop 2 plus, etc. `max(0.08, …)` empêche les nœuds trop
    // loin de devenir totalement invisibles (sinon on perd le contexte).
    //   hop 0 → 1.00
    //   hop 1 → 0.75
    //   hop 2 → 0.50
    //   hop 3 → 0.25
    //   hop 4+ → 0.08 (plancher)
    const opacityFor = (hop) => Math.max(0.08, 1 - 0.25 * hop);

    // Applique les classes HOP par nœud (dans le même batch). On utilise
    // des classes plutôt que des inline styles parce que cytoscape 3.30.x
    // fait primer le style de classe sur l'inline. NB : addClass
    // n'accepte qu'un seul argument string (classes séparées par
    // espace) ou un array — pas variadique.
    const rootEl = cy.$id(focusRoot);
    rootEl.addClass('cy-focus-root');
    limited.forEach(id => {
      const el = cy.$id(id);
      if (!el || !el.length) return;
      const d = dist.get(id) || 0;
      if (d === 0) return; // root : classe cy-focus-root appliquée plus haut
      // Cap à h4 (opacité plancher 0.10) pour les graphes très profonds
      const hopClass = `cy-focus-h${Math.min(d, 4)}`;
      el.addClass(`cy-focus-in ${hopClass}`);
    });
    // Nœuds hors voisinage : très faible opacité.
    cy.nodes().difference(cy.collection(Array.from(limited).map(id => cy.$id(id))))
      .addClass('cy-focus-out');

    // Arêtes : opacity dérivée du HOP max des deux extrémités (une
    // arête entre hop 0 et hop 2 est considérée "de niveau 2" et
    // atténuée en conséquence). Les arêtes touchant un nœud "out" sont
    // à peine visibles. On utilise des classes par HOP pour la même
    // raison que les nœuds.
    cy.edges().forEach(e => {
      const sId = e.source().id();
      const tId = e.target().id();
      const sIn = limited.has(sId);
      const tIn = limited.has(tId);
      if (sIn && tIn) {
        const sd = dist.get(sId) || 0;
        const td = dist.get(tId) || 0;
        const hopClass = `cy-focus-h${Math.min(Math.max(sd, td), 4)}`;
        e.addClass(`cy-focus-in ${hopClass}`);
      } else if (sIn || tIn) {
        e.addClass('cy-focus-border');
      } else {
        e.addClass('cy-focus-out');
      }
    });
  });
  renderGraphLegend();
}

// ── Rendu principal ──────────────────────────────────────────────────────────
export async function renderGraph(nodes) {
  const container = ensureContainer();
  if (!container) throw new Error('#graph-wrap introuvable');

  // Affiche le header dédié à la vue Cyto (avec compteurs + boutons).
  const header = $('cy-header');
  if (header) header.hidden = false;

  // Affiche le loader pendant le téléchargement du bundle CDN.
  const loader = $('cy-loader');
  if (loader) loader.hidden = false;
  const failed = $('cy-error');
  if (failed) failed.hidden = true;

  // Met à jour les compteurs (même avant le rendu, pour feedback immédiat).
  const statNodes = $('cy-stat-nodes');
  const statEdges = $('cy-stat-edges');
  if (statNodes) statNodes.textContent = nodes.length;
  // Compteur d'arêtes : déduit de la projection des tuples.
  if (statEdges) {
    const visible = new Set(nodes.map(n => n.raw));
    let edgeCount = 0;
    const seen = new Set();
    for (const t of state.tuples) {
      const u = t.user.split('#')[0];
      const o = t.object.split('#')[0];
      if (!visible.has(u) || !visible.has(o) || u === o) continue;
      const key = u + '|' + t.relation + '|' + o;
      if (seen.has(key)) continue;
      seen.add(key);
      edgeCount++;
    }
    statEdges.textContent = edgeCount;
  }

  // Empty state (visible uniquement quand il n'y a vraiment rien à dessiner).
  const empty = $('cy-empty');
  if (empty) empty.hidden = nodes.length > 0;

  // Si vide, on ne charge pas le bundle ni on ne crée l'instance.
  if (nodes.length === 0) {
    if (loader) loader.hidden = true;
    // Détruit l'instance existante pour libérer la mémoire.
    if (cy) {
      try { cy.destroy(); } catch (_) {}
      cy = null;
    }
    return;
  }

  let cyLib;
  try {
    cyLib = await loadCytoscape();
  } catch (err) {
    // Pas de spinner infini : message, nouvel essai ou retour aux cartes.
    if (loader) loader.hidden = true;
    if (failed) failed.hidden = false;
    throw err;
  }

  // Cache le loader (le bundle est prêt).
  if (loader) loader.hidden = true;

  container.style.display = 'block';

  const elements = tuplesToElements(nodes);
  const fs = focusProvider ? focusProvider() : { root: '', depth: 0 };
  const layoutOpts = layoutOptions(fs.root);

  if (!cy) {
    // ── Première initialisation : création de l'instance ───────────────
    cy = cyLib({
      container,
      elements,
      // Interactions built-in (équivalent de l'ancien drag/pan/zoom
      // fait à la main dans `graph.js`).
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.25,
      autoungrabify: false,   // drag activé par défaut
      userPanningEnabled: true,
      userZoomingEnabled: true,
      boxSelectionEnabled: false,
      styleEnabled: true,
      // Style déclaratif (remplace les classes CSS maison).
      style: styleConfig(),
    });

    // Layout initial
    cy.layout(layoutOpts).run();

    // ── Listeners built-in ────────────────────────────────────────────
    // Tap sur un nœud : événement global relayé à main.js
    // (main.js applique la même logique que le graphe SVG :
    // 1er clic = focus, 2e clic = modale).
    cy.on('tap', 'node', evt => {
      window.dispatchEvent(new CustomEvent('cy-node-tap', { detail: { raw: evt.target.id() } }));
    });
    // Tap sur le fond (event.target === cy) = reset focus
    cy.on('tap', evt => {
      if (evt.target === cy) {
        window.dispatchEvent(new CustomEvent('cy-background-tap'));
      }
    });
    // Re-layout auto sur redimensionnement de la fenêtre
    cy.on('resize', () => { if (cy) cy.fit(undefined, 40); });

    // ── Câblage des boutons du header dédié à la vue Cyto ──
    const $btn = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };
    $btn('cy-zoom-in',  () => graphZoom(1.25));
    $btn('cy-zoom-out', () => graphZoom(0.8));
    $btn('cy-fit',      () => graphReset());
    $btn('cy-relayout', () => {
      if (!cy) return;
      cy.layout({
        name: 'cose',
        animate: true,
        fit: true,
        padding: 50,
        nodeRepulsion: () => 16000,
        idealEdgeLength: () => 130,
        edgeElasticity: () => 100,
        gravity: 0.22,
        numIter: 1500,
        randomize: true,
        componentSpacing: 70,
        nodeOverlap: 24,
        coolingFactor: 0.97,
      }).run();
    });
  } else {
    // ── Mise à jour incrémentale (filtre changé) ──────────────────────
    // `cy.json({ elements })` met à jour le graphe en un seul batch
    // interne (plus efficace que cy.elements().remove() + cy.add()).
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    cy.layout(layoutOpts).run();
  }

  // Applique l'état de focus courant (no-op si pas de focus).
  applyFocus();
  // Légende alignée sur la vue SVG.
  renderGraphLegend(nodes);
}

// ── API publique alignée sur graph.js ────────────────────────────────────────
/** Centre le viewport sur le nœud `raw` (animation built-in). */
export function centerGraphOn(raw) {
  if (!cy || !raw) return;
  const node = cy.$id(raw);
  if (node && node.length) {
    // `cy.animate()` avec `eles: node` centre sur ce nœud.
    cy.animate({ center: { eles: node }, zoom: 1.1, duration: 220 });
  }
}

/** Zoom programmatique centré sur le milieu du viewport. */
export function graphZoom(factor) {
  if (!cy) return;
  cy.zoom({
    level: cy.zoom() * factor,
    renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
  });
}

/** Fit + zoom 1 (utilise les options intégrées de cy.fit). */
export function graphReset() {
  if (!cy) return;
  cy.fit({ padding: 40 });
  cy.zoom(1);
}

/** Ré-applique l'opacity (no-op si l'instance n'existe pas). */
export function refreshGraphFocus() {
  applyFocus();
}

/** Détruit l'instance (libère mémoire + DOM). */
export function destroyGraph() {
  if (cy) {
    try { cy.destroy(); } catch (_) { /* idempotent */ }
    cy = null;
  }
  if (cyContainer) cyContainer.style.display = 'none';
  // Cache les éléments d'UI dédiés à la vue graphe.
  const header = $('cy-header');
  if (header) header.hidden = true;
  const loader = $('cy-loader');
  if (loader) loader.hidden = true;
  const empty = $('cy-empty');
  if (empty) empty.hidden = true;
  const failed = $('cy-error');
  if (failed) failed.hidden = true;
}

export function isGraphActive() { return !!cy; }

// ── Légende (alignée sur graph.js) ──────────────────────────────────────────
// Nœuds de la dernière légende et taille du voisinage focalisé (calculée
// par applyFocus, qui redessine la légende quand le focus change).
let legendNodes = [];
let focusSize = 0;

function renderGraphLegend(nodes = legendNodes) {
  legendNodes = nodes;
  const legend = $('graph-legend');
  if (!legend) return;
  const typesPresent = [...new Set(nodes.map(n => n.type))].sort();
  const fs = focusProvider ? focusProvider() : { root: '', depth: 0 };
  let focusLegend = '';
  if (fs.root && fs.depth > 0 && focusSize > 0) {
    const rootLabel = fs.root.split(':').slice(1).join(':') || fs.root;
    focusLegend = `<div class="legend-item legend-focus">
      <span class="dot legend-focus-dot"></span>
      Focus : <span class="mono">${escapeHtmlLite(rootLabel)}</span> · d=${fs.depth} · ${focusSize} nœud(s)
    </div>`;
  }
  legend.innerHTML = typesPresent.map(ty =>
    `<div class="legend-item"><span class="dot type-dot ${typeClass(ty)}"></span>${escapeHtmlLite(ty)}</div>`,
  ).join('') + focusLegend;
}

function escapeHtmlLite(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Hooks Playwright / debug ─────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.__cyReady = () => !!cy;
  window.__cyInfo  = () => cy ? {
    nodes: cy.nodes().length,
    edges: cy.edges().length,
    focusRoot: focusProvider ? focusProvider().root : '',
    focusDepth: focusProvider ? focusProvider().depth : 0,
  } : null;
}

// Changement de thème : Cytoscape garde ses couleurs résolues, on les recalcule.
document.addEventListener('theme-changed', () => {
  if (!cy) return;
  cy.batch(() => {
    cy.nodes().forEach(n => {
      const c = canvasCfg(n.data('type'));
      n.data({ color: c.border, bg: c.bg, textColor: c.text });
    });
  });
  cy.style(styleConfig());
});
