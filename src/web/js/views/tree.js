// Module "tree" : mini-graphe DAG hiérarchique (ancêtres + racine + descendants)
// affiché dans la sidebar droite. Le rendu utilise SVG, dans le même style visuel
// que la vue graphe principale : rectangles colorés par type, arêtes orientées,
// labels de relation.
//
// Interactions :
//  - Zoom/dézoom à la molette de la souris (centré sur le curseur), indépendant
//    de la vue graphe principale.
//  - Bouton "Fit" pour réinitialiser le zoom/pan et adapter le contenu à la zone
//    visible.
//  - Auto-fit déclenché quand on clique dans le body (hors nœud).
//  - Menu contextuel au clic sur un nœud : définir comme racine, voir le détail,
//    ajouter un tuple, centrer dans le graphe.

import { $, escapeHtml, parseType } from '../lib/dom.js';
import { cfg } from '../models/types.js';
import { state } from '../lib/state.js';
import { typeClass } from '../lib/type-style.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_W = 84;
const NODE_H = 32;
const NODE_RX = 6;
const ROOT_NODE_W = 100;
const ROOT_NODE_H = 38;

let treeRoot = '';
let treeDepth = 1;

let treeScale = 1;
let treeTx = 0;
let treeTy = 0;

let contentBBox = null;

let ancestors = [];
let descendants = [];

function buildAdj(direction) {
  const adj = {};
  const add = (from, to, t) => {
    (adj[from] = adj[from] || []).push({ to, tuple: t });
  };
  for (const t of state.tuples) {
    const u = t.user.split('#')[0];
    const o = t.object.split('#')[0];
    if (!u || !o || u === o) continue;
    if (direction === 'ancestors') add(o, u, t);
    else add(u, o, t);
  }
  return adj;
}

function buildTreeFrom(root, adj, maxDepth, seen) {
  const recurse = (nodeRaw, depth, seenHere) => {
    if (depth >= maxDepth) return { raw: nodeRaw, depth, via: [], children: [] };
    const neighbours = adj[nodeRaw] || [];
    const byTarget = new Map();
    for (const { to, tuple } of neighbours) {
      if (seenHere.has(to)) continue;
      if (!byTarget.has(to)) byTarget.set(to, []);
      byTarget.get(to).push(tuple);
    }
    const children = [];
    for (const [target, tuples] of byTarget) {
      const childSeen = new Set(seenHere);
      childSeen.add(target);
      const child = recurse(target, depth + 1, childSeen);
      child.raw = target;
      child.via = tuples;
      children.push(child);
    }
    return { raw: nodeRaw, depth, via: [], children };
  };
  return recurse(root, 0, new Set([root]));
}

function buildAncestors() {
  ancestors = buildTreeFrom(treeRoot, buildAdj('ancestors'), treeDepth, new Set([treeRoot])).children;
}
function buildDescendants() {
  descendants = buildTreeFrom(treeRoot, buildAdj('descendants'), treeDepth, new Set([treeRoot])).children;
}

function flattenByDepth(roots) {
  const layers = [];
  const queue = roots.map(n => ({ node: n, depthFromRoot: 0 }));
  while (queue.length) {
    const { node, depthFromRoot } = queue.shift();
    while (layers.length <= depthFromRoot) layers.push([]);
    layers[depthFromRoot].push(node);
    for (const c of node.children) queue.push({ node: c, depthFromRoot: depthFromRoot + 1 });
  }
  return layers;
}

function layoutNodes(W, H, ancLayers, descLayers) {
  const positions = new Map();
  const cx = W / 2;
  const cy = H / 2;
  const rowHeight = 56;
  positions.set(treeRoot, { x: cx, y: cy, w: ROOT_NODE_W, h: ROOT_NODE_H });

  const ancLayerCount = ancLayers.length;
  for (let i = 0; i < ancLayerCount; i++) {
    const reversedIdx = ancLayerCount - 1 - i;
    const y = cy - 60 - (reversedIdx + 1) * rowHeight;
    layoutRow(positions, ancLayers[i], W, y);
  }
  for (let i = 0; i < descLayers.length; i++) {
    const y = cy + 60 + i * rowHeight;
    layoutRow(positions, descLayers[i], W, y);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, pos] of positions) {
    minX = Math.min(minX, pos.x - pos.w / 2);
    minY = Math.min(minY, pos.y - pos.h / 2);
    maxX = Math.max(maxX, pos.x + pos.w / 2);
    maxY = Math.max(maxY, pos.y + pos.h / 2);
  }
  contentBBox = (minX === Infinity) ? null : { minX, minY, maxX, maxY };
  return positions;
}

function layoutRow(positions, nodes, W, y) {
  if (nodes.length === 0) return;
  const n = nodes.length;
  const maxRowWidth = W - 40;
  const desiredWidth = n * (NODE_W + 8);
  const spacing = desiredWidth > maxRowWidth ? Math.max(NODE_W + 4, maxRowWidth / n) : NODE_W + 8;
  const totalWidth = n * spacing - 8;
  const startX = Math.max(20, (W - totalWidth) / 2);
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    positions.set(node.raw, { x: startX + i * spacing + spacing / 2 - 4, y, w: NODE_W, h: NODE_H });
  }
}

function renderPanel() {
  const panel = $('tree-panel');
  const body = $('tree-body');
  if (!panel || !body) return;

  if (!treeRoot) {
    panel.classList.remove('open');
    document.body.classList.remove('tree-open');
    body.innerHTML = '<div class="tree-empty">Sélectionne un nœud racine dans le panneau Focus voisinage pour afficher son graphe DAG.</div>';
    treeScale = 1; treeTx = 0; treeTy = 0;
    closeContextMenu();
    return;
  }

  panel.classList.add('open');
  document.body.classList.add('tree-open');

  buildAncestors();
  buildDescendants();

  const W = Math.max(body.clientWidth || 320, 320);
  const H = Math.max(body.clientHeight || 500, 360);
  const ancLayers = flattenByDepth(ancestors);
  const descLayers = flattenByDepth(descendants);
  const positions = layoutNodes(W, H, ancLayers, descLayers);

  if (!contentBBox) { treeScale = 1; treeTx = 0; treeTy = 0; }
  else fitContent(W, H);

  const edges = [];
  const visit = (nodes, parentRaw) => {
    for (const n of nodes) {
      for (const t of n.via) edges.push({ from: parentRaw, to: n.raw, tuple: t });
      visit(n.children, n.raw);
    }
  };
  visit(ancestors, treeRoot);
  visit(descendants, treeRoot);

  let svg = `<svg xmlns="${SVG_NS}" class="tree-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  svg += `<defs>
    <marker id="tree-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--text-tertiary)"></path>
    </marker>
  </defs>`;

  svg += `<g class="tree-zoom-root" transform="translate(${treeTx},${treeTy}) scale(${treeScale})">`;

  for (const e of edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    const path = `M${a.x},${a.y} L${b.x},${b.y}`;
    svg += `<g class="tree-edge">`;
    svg += `<path d="${path}" stroke="var(--text-tertiary)" stroke-width="${1.2 / Math.max(0.6, treeScale)}" fill="none" marker-end="url(#tree-arrow)" opacity="0.7" />`;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const lblFontSize = 9 / Math.max(0.6, treeScale);
    svg += `<text x="${mx}" y="${my - 3}" text-anchor="middle" class="tree-edge-label" font-size="${lblFontSize}" fill="var(--text-tertiary)">${escapeHtml(e.tuple.relation)}</text>`;
    svg += `</g>`;
  }

  const allNodes = [];
  for (let i = ancLayers.length - 1; i >= 0; i--) allNodes.push(...ancLayers[i]);
  allNodes.push({ raw: treeRoot, depth: 0, via: [], children: [] });
  for (let i = 0; i < descLayers.length; i++) allNodes.push(...descLayers[i]);

  for (const n of allNodes) {
    const pos = positions.get(n.raw);
    if (!pos) continue;
    const isRoot = n.raw === treeRoot;
    const c = cfg(parseType(n.raw));
    const w = isRoot ? ROOT_NODE_W : NODE_W;
    const h = isRoot ? ROOT_NODE_H : NODE_H;
    const x = pos.x - w / 2;
    const y = pos.y - h / 2;
    let cls = 'tree-node';
    if (isRoot) cls += ' is-root';
    svg += `<g class="${cls}" data-raw="${escapeHtml(n.raw)}">`;
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${NODE_RX}" ry="${NODE_RX}" fill="${c.bg}" stroke="${c.border}" stroke-width="${isRoot ? 3 : 2}"/>`;
    const id = n.raw.split(':').slice(1).join(':');
    const maxChars = isRoot ? 14 : 10;
    const label = id.length > maxChars ? id.slice(0, maxChars - 1) + '…' : id;
    const labelFontSize = isRoot ? 11 : 10;
    svg += `<text x="${pos.x}" y="${pos.y + labelFontSize / 3}" text-anchor="middle" font-size="${labelFontSize}" font-weight="${isRoot ? 700 : 600}" fill="${c.text}">${escapeHtml(label)}</text>`;
    svg += `<title>${escapeHtml(n.raw)}</title>`;
    svg += `</g>`;
  }

  svg += `</g></svg>`;
  body.innerHTML = svg;

  const svgEl = body.querySelector('svg.tree-svg');
  if (svgEl) wireInteractions(svgEl, body, W, H, positions);
}

function fitContent(W, H) {
  if (!contentBBox) return;
  const padding = 30;
  const cw = contentBBox.maxX - contentBBox.minX;
  const ch = contentBBox.maxY - contentBBox.minY;
  if (cw <= 0 || ch <= 0) return;
  const sx = (W - padding * 2) / cw;
  const sy = (H - padding * 2) / ch;
  treeScale = Math.min(sx, sy, 1.5);
  const cx = (contentBBox.minX + contentBBox.maxX) / 2;
  const cy = (contentBBox.minY + contentBBox.maxY) / 2;
  treeTx = W / 2 - cx * treeScale;
  treeTy = H / 2 - cy * treeScale;
  applyTransform();
}

function applyTransform() {
  const root = document.querySelector('#tree-body .tree-zoom-root');
  if (root) root.setAttribute('transform', `translate(${treeTx},${treeTy}) scale(${treeScale})`);
}

function zoomAt(svgEl, cx, cy, newScale) {
  newScale = Math.max(0.2, Math.min(4, newScale));
  const k = newScale / treeScale;
  treeTx = cx - (cx - treeTx) * k;
  treeTy = cy - (cy - treeTy) * k;
  treeScale = newScale;
  applyTransform();
}

function svgPoint(svgEl, ev) {
  const rect = svgEl.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

// ============== Menu contextuel ==============

let contextMenuEl = null;

function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

function openContextMenu(nodeRaw, clientX, clientY) {
  closeContextMenu();
  const isRoot = nodeRaw === treeRoot;
  const menu = document.createElement('div');
  menu.className = 'tree-context-menu';
  menu.setAttribute('role', 'menu');
  // Position : on calcule après l'attachement pour clamp dans la viewport
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';

  const items = [
    {
      label: 'Définir comme racine',
      icon: 'ti-focus-2',
      action: () => {
        window.dispatchEvent(new CustomEvent('tree-node-focus', { detail: { raw: nodeRaw } }));
      },
      disabled: isRoot,
    },
    {
      label: 'Voir le détail',
      icon: 'ti-info-circle',
      action: () => {
        // Trouve le nœud complet dans le graphe principal (si présent)
        const fullNode = findNodeInGraph(nodeRaw);
        if (fullNode) {
          window.dispatchEvent(new CustomEvent('open-node-detail', { detail: { node: fullNode } }));
        } else {
          // Sinon on notifie juste par raw
          window.dispatchEvent(new CustomEvent('tree-node-focus', { detail: { raw: nodeRaw } }));
        }
      },
    },
    {
      label: 'Ajouter comme objet',
      icon: 'ti-arrow-down',
      action: () => {
        window.dispatchEvent(new CustomEvent('tree-add-tuple', { detail: { role: 'object', raw: nodeRaw } }));
      },
    },
    {
      label: 'Ajouter comme sujet',
      icon: 'ti-arrow-up',
      action: () => {
        window.dispatchEvent(new CustomEvent('tree-add-tuple', { detail: { role: 'subject', raw: nodeRaw } }));
      },
    },
    {
      label: 'Centrer dans le graphe',
      icon: 'ti-crosshair',
      action: () => {
        if (window.__graphCenterOn) window.__graphCenterOn(nodeRaw);
      },
    },
    {
      label: 'Copier le raw',
      icon: 'ti-clipboard',
      action: () => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(nodeRaw).catch(() => {});
        }
      },
    },
  ];

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'tree-context-item';
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!item.disabled;
    btn.innerHTML = `<i class="ti ${item.icon}" aria-hidden="true"></i><span>${escapeHtml(item.label)}</span>`;
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (item.disabled) return;
      closeContextMenu();
      try { item.action(); } catch (e) { console.error(e); }
    });
    menu.appendChild(btn);
  }

  // Header : raw + couleur du type
  const header = document.createElement('div');
  header.className = 'tree-context-header';
  header.innerHTML = `
    <span class="dot type-dot ${typeClass(parseType(nodeRaw))}"></span>
    <span class="tree-context-raw">${escapeHtml(nodeRaw)}</span>
  `;
  menu.insertBefore(header, menu.firstChild);

  document.body.appendChild(contextMenuEl = menu);

  // Clamp dans la viewport après le layout
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX, top = clientY;
  if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
  if (top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

// Reconstruit un nœud (raw, type, id, incoming, outgoing) à partir des tuples.
// Utilisé pour ouvrir la modale de détail depuis le tree.
function findNodeInGraph(raw) {
  const type = parseType(raw);
  const id = raw.split(':').slice(1).join(':');
  const incoming = [];
  const outgoing = [];
  for (const t of state.tuples) {
    const u = t.user.split('#')[0];
    const o = t.object.split('#')[0];
    if (u === raw) outgoing.push(t);
    if (o === raw) incoming.push(t);
  }
  if (incoming.length === 0 && outgoing.length === 0) {
    // Noeud orphelin : on l'affiche quand meme pour info
    return { raw, type, id, incoming, outgoing };
  }
  return { raw, type, id, incoming, outgoing };
}

function wireInteractions(svgEl, body, W, H, positions) {
  svgEl.addEventListener('wheel', ev => {
    ev.preventDefault();
    const pt = svgPoint(svgEl, ev);
    const factor = ev.deltaY < 0 ? 1.12 : 0.89;
    zoomAt(svgEl, pt.x, pt.y, treeScale * factor);
  }, { passive: false });

  svgEl.querySelectorAll('.tree-node[data-raw]').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const raw = el.getAttribute('data-raw');
      openContextMenu(raw, ev.clientX, ev.clientY);
    });
  });

  // Clic sur le fond (hors nœud) -> ferme menu + auto-fit
  svgEl.addEventListener('click', ev => {
    if (ev.target.closest('.tree-node')) return;
    closeContextMenu();
    fitContent(W, H);
  });
}

// Fermer le menu contextuel sur clic extérieur ou Escape
document.addEventListener('click', ev => {
  if (!contextMenuEl) return;
  if (ev.target.closest('.tree-context-menu')) return;
  closeContextMenu();
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') closeContextMenu();
});

// API publique
export function setTreeRoot(raw) {
  treeRoot = raw || '';
  if (treeRoot && treeDepth === 0) treeDepth = 1;
  if (!treeRoot) treeDepth = 1;
  treeScale = 1; treeTx = 0; treeTy = 0;
  closeContextMenu();
  renderPanel();
}

export function setTreeDepth(n) {
  const v = Math.max(1, Math.min(5, n | 0));
  treeDepth = v;
  const slider = $('tree-depth');
  const lbl = $('tree-depth-val');
  if (slider) slider.value = String(v);
  if (lbl) lbl.textContent = String(v);
  if (treeRoot) renderPanel();
}

export function getTreeState() {
  return { root: treeRoot, depth: treeDepth, scale: treeScale };
}

export function closeTree() {
  treeRoot = '';
  treeScale = 1; treeTx = 0; treeTy = 0;
  closeContextMenu();
  renderPanel();
}

export function expandAll() {}
export function collapseAll() {}

export function fitToView() {
  if (!treeRoot) return;
  const body = $('tree-body');
  if (!body) return;
  const W = Math.max(body.clientWidth || 320, 320);
  const H = Math.max(body.clientHeight || 500, 360);
  fitContent(W, H);
}

export function refreshLayout() {
  if (treeRoot) renderPanel();
}
