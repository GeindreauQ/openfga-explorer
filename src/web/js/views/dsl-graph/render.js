// views/dsl-graph/render.js — Fonction `render()` principale (re-dessine
// tout le SVG) + helpers de dessin (`drawSelfLoop`) + handler de clic
// nœud (`onNodeClick`).

import { cfg } from '../../models/types.js';
import { state, svgEl } from './state.js';
import { renderSidePanel, renderEdgePanel } from './panels.js';

// Couleur de fallback pour les types custom (sans entrée dans le thème).
function colorFor(node) {
  if (node.custom) return { icon: 'ti-circle', bg: 'var(--bg-primary)', text: 'var(--text-primary)', border: 'var(--border-strong)' };
  return cfg(node.type) || { bg: 'var(--bg-primary)', text: 'var(--text-primary)', border: 'var(--border-strong)' };
}

/**
 * Rend une self-loop (arête from === to) comme un arc au-dessus du
 * nœud. Utilisé pour les relations qui pointent vers d'autres
 * relations du même type (ex: `define can_grant_admin: admin or
 * operator` dans `type role`).
 *
 * Si plusieurs self-loops coexistent sur le même nœud, on les
 * décale légèrement (idx-based) pour qu'ils ne se superposent pas.
 */
function drawSelfLoop(parent, edge, a, idx) {
  // Rayon du nœud : on approx par 30 (valeur de base) ou 34 pour
  // les nœuds très connectés (cf. fonction radius() dans render()).
  const deg = state.edges.filter(e => e.from === edge.from || e.to === edge.from).length;
  const r = Math.max(20, Math.min(34, 16 + deg * 2)) + 4;
  // Hauteur de la boucle : on la fait d'autant plus haute que idx est
  // grand, pour décaler visuellement.
  const lift = 14 + (idx - 1) * 6;
  const tipY = a.y - r - lift;
  const startX = a.x - r * 0.3;
  const endX = a.x + r * 0.3;
  const ctrlY = tipY - 10;
  const isPinned = state.pinnedEdge === edge.from + '|' + edge.to;
  // Path : départ légèrement à gauche du nœud, monte au tip, redescend
  // légèrement à droite. Forme une "oreille".
  const d = `M${startX},${a.y - r} Q${startX - 4},${ctrlY} ${a.x},${tipY} Q${endX + 4},${ctrlY} ${endX},${a.y - r}`;
  const isComputed = edge.style === 'dashed' || edge.type === 'computed';
  const strokeDash = isComputed ? '6,4' : 'none';
  const path = svgEl('path', {
    d,
    class: 'dsl-edge self-loop' + (isPinned ? ' pinned' : ''),
    fill: 'none',
    'stroke-width': 1.6,
    'stroke-dasharray': strokeDash,
    'data-edge': `${edge.from}|${edge.to}`,
  });
  path.addEventListener('mouseenter', () => { state.hoveredEdge = `${edge.from}|${edge.to}`; render(); });
  path.addEventListener('mouseleave', () => { if (state.hoveredEdge === `${edge.from}|${edge.to}`) { state.hoveredEdge = null; render(); } });
  parent.appendChild(path);

  // Petite flèche au retour vers le nœud (pointe vers le bas).
  const arrow = svgEl('path', {
    d: `M${endX},${a.y - r + 2} l-3,-3 l3,-3 z`,  // petit triangle
    class: 'dsl-edge-arrow',
    fill: 'var(--text-secondary)',
  });
  parent.appendChild(arrow);

  // Label court au tip de la boucle (au-dessus). On n'affiche que le
  // compte pour rester compact (le détail est dans le side panel).
  const lblText = edge.relations.length === 1 ? '1 relation' : `${edge.relations.length} relations`;
  const lblWidth = Math.max(50, lblText.length * 6.5 + 14);
  const lblX = a.x;
  const lblY = tipY - 14;
  const bg = svgEl('rect', {
    x: lblX - lblWidth / 2,
    y: lblY - 10,
    width: lblWidth,
    height: 20,
    rx: 5,
    class: 'dsl-edge-bg' + (isPinned ? ' pinned' : ''),
    'data-edge': `${edge.from}|${edge.to}`,
  });
  parent.appendChild(bg);
  const lbl = svgEl('text', {
    x: lblX, y: lblY + 4,
    'text-anchor': 'middle',
    class: 'dsl-edge-label' + (isPinned ? ' pinned' : ''),
    'data-edge': `${edge.from}|${edge.to}`,
  });
  lbl.textContent = lblText;
  parent.appendChild(lbl);
}

// ── Fonction principale ─────────────────────────────────────────────────

export function render() {
  if (!state.svg || !state.root) return;
  // Met à jour les compteurs dans la toolbar.
  const statNodes = state.container?.querySelector('#dsl-graph-stat-nodes');
  const statEdges = state.container?.querySelector('#dsl-graph-stat-edges');
  if (statNodes) statNodes.textContent = state.nodes.length;
  if (statEdges) statEdges.textContent = state.edges.length;
  // Empty state : affiché si le graphe est vide.
  const empty = state.container?.querySelector('#dsl-graph-empty');
  if (empty) empty.hidden = state.nodes.length > 0;
  if (state.nodes.length === 0) {
    state.root.innerHTML = '';
    return;
  }
  state.svg.setAttribute('viewBox', `${state.viewBox.x} ${state.viewBox.y} ${state.viewBox.w} ${state.viewBox.h}`);
  state.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  state.root.innerHTML = '';

  // Defs : flèche + glow pour le focus.
  const defs = svgEl('defs');
  defs.innerHTML = `
    <marker id="dsl-arrow" viewBox="0 0 10 10" refX="9" refY="5"
      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--text-tertiary)"></path>
    </marker>
    <marker id="dsl-arrow-active" viewBox="0 0 10 10" refX="9" refY="5"
      markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--accent-fg)"></path>
    </marker>
  `;
  state.root.appendChild(defs);

  // ── Arêtes (sous les nœuds) ──
  // Calcule le degré (in+out) de chaque nœud pour adapter la courbure.
  const degree = new Map();
  for (const n of state.nodes) degree.set(n.id, 0);
  for (const e of state.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  // Rayon de chaque nœud (cohérent avec le rendu cercle).
  const radius = id => {
    const deg = degree.get(id) || 0;
    return Math.min(34, 16 + deg * 2);
  };

  // Ensemble des nœuds "voisins" du nœud survolé/sélectionné (1-hop).
  // Utilisé pour highlight les voisins et dimmer les autres nœuds.
  const focusedSet = new Set();
  const focusId = state.hoveredNode || state.selectedNode;
  if (focusId) {
    focusedSet.add(focusId);
    for (const e of state.edges) {
      if (e.from === focusId) focusedSet.add(e.to);
      if (e.to === focusId) focusedSet.add(e.from);
    }
  }
  const hasFocus = !!focusId;

  const gEdges = svgEl('g', { class: 'dsl-graph-edges' });
  state.root.appendChild(gEdges);

  // Groupement par (from, to) pour le décalage perpendiculaire des
  // arêtes parallèles (peu probable après dédup, mais supporté).
  const pairCount = new Map();
  // Stocke les données des arêtes actives (hover/pinned) pour rendre
  // leur label APRÈS les nœuds (z-order au-dessus des cercles).
  const activeEdgeLabels = [];
  for (const e of state.edges) {
    const a = state.layout[e.from];
    const b = state.layout[e.to];
    if (!a || !b) continue;
    const key = `${e.from}|${e.to}`;
    const idx = (pairCount.get(key) || 0) + 1;
    pairCount.set(key, idx);

    // Self-loop (from === to) : on rend une boucle qui part et
    // revient au même nœud. C'est crucial pour les relations comme
    // `define can_grant_admin: admin or operator` où admin et
    // operator sont des relations du même type.
    if (e.from === e.to) {
      drawSelfLoop(gEdges, e, a, pairCount.get(key) || 1);
      continue;
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;

    // Recule les extrémités au bord des cercles (la flèche est visible).
    const ra = radius(e.from) + 2;
    const rb = radius(e.to) + 8;
    const ax = a.x + ux * ra, ay = a.y + uy * ra;
    const bx = b.x - ux * rb, by = b.y - uy * rb;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const offset = (idx - 1) * 14 * (idx % 2 === 0 ? 1 : -1);
    const ctrlX = mx + nx * (30 + offset);
    const ctrlY = my + ny * (30 + offset);

    const isEdgeHover = (state.hoveredEdge === e.from + '|' + e.to);
    const isPinned = (state.pinnedEdge === e.from + '|' + e.to);
    const isHover = (state.hoveredNode && (e.from === state.hoveredNode || e.to === state.hoveredNode));
    const isSelected = (state.selectedNode && (e.from === state.selectedNode || e.to === state.selectedNode));
    const isActive = isEdgeHover || isPinned || isHover || isSelected;
    const dimAll = !!state.hoveredNode && state.hoveredNode !== e.from && state.hoveredNode !== e.to
      && !(state.selectedNode && (e.from === state.selectedNode || e.to === state.selectedNode));
    const isDimmed = dimAll && !isActive;

    // Hit-area élargie (path transparent épais) pour faciliter le clic.
    const hit = svgEl('path', {
      d: `M${ax},${ay} Q${ctrlX},${ctrlY} ${bx},${by}`,
      fill: 'none', stroke: 'transparent', 'stroke-width': 16,
      class: 'dsl-edge-hit',
      'data-edge': `${e.from}|${e.to}`,
    });
    gEdges.appendChild(hit);

    const path = svgEl('path', {
      d: `M${ax},${ay} Q${ctrlX},${ctrlY} ${bx},${by}`,
      class: 'dsl-edge'
        + (isActive ? ' active' : '')
        + (isPinned ? ' pinned' : '')
        + (isEdgeHover ? ' hovered' : '')
        + (isDimmed ? ' dimmed' : ''),
      'marker-end': isActive ? 'url(#dsl-arrow-active)' : 'url(#dsl-arrow)',
      'data-edge': `${e.from}|${e.to}`,
      'stroke-width': isPinned ? 2.6 : (isEdgeHover ? 2.3 : 1.6),
    });
    const tip = svgEl('title');
    tip.textContent = `${e.from} → ${e.to} : ${e.relations.join(', ')}`;
    path.appendChild(tip);
    gEdges.appendChild(path);

    // Pour les arêtes actives, on stocke les infos du label pour le
    // rendre APRÈS les nœuds (z-order au-dessus des cercles). Position
    // = midpoint réel de la courbe de Bézier (pas le control point),
    // ce qui place le label pile sur le tracé, pas 2× plus loin.
    if (isEdgeHover || isPinned) {
      // B(0.5) = 0.25*P0 + 0.5*P1 + 0.25*P2 (midpoint quadratique).
      const lblX = 0.25 * ax + 0.5 * ctrlX + 0.25 * bx;
      const lblY = 0.25 * ay + 0.5 * ctrlY + 0.25 * by;
      activeEdgeLabels.push({ edge: e, x: lblX, y: lblY, pinned: isPinned });
    }
  }

  // ── Self-loops rendus ci-dessus via drawSelfLoop() ──
  // Le label des self-loops est positionné en haut du nœud (au-dessus
  // de la boucle) pour ne pas le masquer.

  // ── Nœuds (cercles) ──
  const gNodes = svgEl('g', { class: 'dsl-graph-nodes' });
  state.root.appendChild(gNodes);
  for (const n of state.nodes) {
    const p = state.layout[n.id];
    if (!p) continue;
    const c = n.custom ? { icon: 'ti-circle', bg: 'var(--bg-primary)', text: 'var(--text-primary)', border: 'var(--border-strong)' } : (cfg(n.type) || { bg: 'var(--bg-primary)', text: 'var(--text-primary)', border: 'var(--border-strong)' });
    const isHover = (state.hoveredNode === n.id);
    const isSelected = (state.selectedNode === n.id);
    const isInFocus = focusedSet.has(n.id);
    const isDimmed = hasFocus && !isInFocus;
    const r = radius(n.id);

    // Animation d'entrée : 1 fois par setData uniquement (évite le
    // re-play à chaque render, qui causait un flicker sur hover/click).
    const animClass = state.animateEntry ? ' dsl-node-enter' : '';
    const g = svgEl('g', {
      class: 'dsl-node' + (isHover ? ' hovered' : '') + (isSelected ? ' selected' : '') + (isDimmed ? ' dimmed' : '') + animClass,
      transform: `translate(${p.x}, ${p.y})`,
      'data-id': n.id,
    });
    g.style.cursor = 'pointer';

    // Halo ring (visible si hover ou selected) : cercle extérieur
    // transparent, juste un stroke. Donne un "focus" plus visible
    // que le seul épaississement du stroke.
    if (isHover || isSelected) {
      const haloR = r + 6;
      const halo = svgEl('circle', {
        r: haloR,
        class: 'dsl-node-halo' + (isSelected ? ' selected' : ''),
        fill: 'none',
        stroke: 'var(--accent-fg)',
        'stroke-width': isSelected ? 3 : 2,
        opacity: isSelected ? 0.55 : 0.35,
      });
      g.appendChild(halo);
    }

    // Cercle extérieur (coloré)
    const outer = svgEl('circle', {
      r,
      class: 'dsl-node-circle',
      fill: c.bg,
      stroke: c.border,
      'stroke-width': isSelected ? 3 : (isHover ? 2.5 : 2),
    });
    g.appendChild(outer);

    // Cercle intérieur (légèrement plus petit, plein)
    const inner = svgEl('circle', {
      r: Math.max(2, r - 4),
      class: 'dsl-node-inner',
      fill: c.bg,
    });
    g.appendChild(inner);

    // Type abrégé (1-2 lettres au centre). Générique : pas de
    // pré-traitement spécifique à un schéma.
    const abbrev = (n.id || '?').slice(0, 2).toUpperCase();
    const typeText = svgEl('text', {
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      class: 'dsl-node-abbr',
      fill: c.text,
      'font-weight': '700',
      'font-size': '12',
    });
    typeText.textContent = abbrev;
    g.appendChild(typeText);

    // Label sous le cercle (nom complet + type)
    const label = svgEl('text', {
      'text-anchor': 'middle',
      y: r + 14,
      class: 'dsl-node-label',
      fill: 'var(--text-primary)',
    });
    label.textContent = n.id.length > 18 ? n.id.slice(0, 17) + '…' : n.id;
    g.appendChild(label);

    // Type (sous le label, plus discret)
    const typeEl = svgEl('text', {
      'text-anchor': 'middle',
      y: r + 26,
      class: 'dsl-node-type',
      fill: 'var(--text-secondary)',
    });
    typeEl.textContent = `${degree.get(n.id) || 0} lien${(degree.get(n.id) || 0) !== 1 ? 's' : ''}`;
    g.appendChild(typeEl);

    // Events
    g.addEventListener('mouseenter', () => { state.hoveredNode = n.id; render(); });
    g.addEventListener('mouseleave', () => { if (state.hoveredNode === n.id) state.hoveredNode = null; render(); });
    g.addEventListener('mousedown', (ev) => { startNodeDrag(ev, n); ev.stopPropagation(); });
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.suppressNextClick) { state.suppressNextClick = false; return; }
      onNodeClick(n);
    });

    gNodes.appendChild(g);
  }

  // ── Labels d'arêtes (rendu APRÈS les nœuds pour être au-dessus) ──
  if (activeEdgeLabels.length) {
    const gLabels = svgEl('g', { class: 'dsl-graph-edge-labels' });
    for (const { edge, x, y, pinned } of activeEdgeLabels) {
      // Si le midpoint est trop proche d'un nœud, on décale
      // perpendiculairement pour ne pas chevaucher le cercle.
      let lx = x, ly = y;
      for (const nodeId of [edge.from, edge.to]) {
        const p = state.layout[nodeId];
        if (!p) continue;
        const dx = lx - p.x, dy = ly - p.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const r = radius(nodeId) + 14;
        if (d < r) {
          // Décale perpendiculairement à l'arête.
          const ax = state.layout[edge.from], bx = state.layout[edge.to];
          const len = Math.hypot(bx.x - ax.x, bx.y - ax.y) || 1;
          const nxn = -(bx.y - ax.y) / len;
          const nyn = (bx.x - ax.x) / len;
          // Tire le label vers l'extérieur, dans la direction de la
          // perpendiculaire la plus proche du midpoint.
          const sign = (dx * nxn + dy * nyn) < 0 ? -1 : 1;
          lx += nxn * sign * (r - d + 6);
          ly += nyn * sign * (r - d + 6);
        }
      }
      // Label compact : on n'affiche QUE le nombre de relations sur
      // l'arête (jamais le texte complet — c'est trop long quand une
      // même paire (from, to) cumule 10+ relations). Le détail est
      // accessible via le side panel épinglé au clic.
      const n = edge.relations.length;
      const lblText = n === 1 ? '1 relation' : `${n} relations`;
      const lblWidth = Math.max(40, lblText.length * 6.5 + 14);
      const bg = svgEl('rect', {
        x: lx - lblWidth / 2,
        y: ly - 10,
        width: lblWidth,
        height: 20,
        rx: 5,
        class: 'dsl-edge-bg' + (pinned ? ' pinned' : ' hovered'),
        'data-edge': `${edge.from}|${edge.to}`,
      });
      gLabels.appendChild(bg);
      const lbl = svgEl('text', {
        x: lx, y: ly + 4,
        'text-anchor': 'middle',
        class: 'dsl-edge-label' + (pinned ? ' pinned' : ' hovered'),
        'data-edge': `${edge.from}|${edge.to}`,
      });
      lbl.textContent = lblText;
      gLabels.appendChild(lbl);
    }
    state.root.appendChild(gLabels);
  }
}

/**
 * Handler de clic sur un nœud. Toggle la sélection et synchronise les
 * panels + render. Notifie le caller via onNodeClick.
 */
export function onNodeClick(node) {
  state.selectedNode = (state.selectedNode === node.id) ? null : node.id;
  state.pinnedEdge = null;
  renderSidePanel();
  renderEdgePanel();
  render();
  if (state.onNodeClick) state.onNodeClick(node, state.selectedNode === node.id);
}

// Import tardif pour éviter cycle (layout.js → render.js via startNodeDrag).
import { startNodeDrag } from './layout.js';