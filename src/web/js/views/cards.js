// Orchestrateur de rendu : filtres, statistiques, onglets de type et vue cartes.
// Délègue la vue graphe à graph.js.

import { $, escapeHtml } from '../lib/dom.js';
import { cfg } from '../models/types.js';
import { state, buildAllNodes, toggleType } from '../lib/state.js';
import { renderGraph } from './graph.js';
import { getFocusState, getRelevantRelations } from '../lib/state.js';
import { classifyCurrentTuple } from './store-diff-panel.js';
import { typeClass } from '../lib/type-style.js';

// Callback d'ouverture de la modale d'un nœud, injecté par main.js.
let onNodeOpen = () => {};
export function setNodeOpenHandler(fn) {
  onNodeOpen = fn;
}

/** Nœuds visibles compte tenu de la recherche, du filtre de relation et des types actifs. */
export function getFilteredNodes() {
  const search = $('search').value.toLowerCase();
  const relF = $('rel-filter').value;
  return buildAllNodes().filter(n => {
    if (state.activeTypes.size > 0 && !state.activeTypes.has(n.type)) return false;
    if (search && !n.raw.toLowerCase().includes(search)) return false;
    if (relF) {
      const hasRel = [...n.incoming, ...n.outgoing].some(t => t.relation === relF);
      if (!hasRel) return false;
    }
    return true;
  });
}

/** Rendu complet : filtres, stats, onglets puis vue active (cartes ou graphe). */
export function render() {
  const allNodes = buildAllNodes();
  const typeCounts = {};
  allNodes.forEach(n => { typeCounts[n.type] = (typeCounts[n.type] || 0) + 1; });

  renderRelationFilter();
  renderStats(allNodes, typeCounts);
  initSearchSuggestOnce();
  renderTypeTabs(allNodes, typeCounts);

  const nodes = getFilteredNodes();

  if (state.currentView === 'graph') {
    renderGraph(nodes).catch(err => console.error('graph render:', err));
    return;
  }
  renderCards(nodes);
}

// Met à jour la liste déroulante des relations en conservant la sélection.
// === Search autocomplete ===

/**
 * Score un noeud par rapport a une requete.
 * Plus le score est eleve, plus le match est pertinent.
 *  - match exact sur raw : 1000
 *  - match exact sur id (sans prefixe de type) : 500
 *  - match sur le type : 100
 *  - substring au debut du raw : 50
 *  - substring ailleurs : 10
 */
function scoreNode(n, q) {
  if (!q) return 0;
  const raw = n.raw.toLowerCase();
  if (raw === q) return 1000;
  if (raw.startsWith(q)) return 50;
  const idx = raw.indexOf(q);
  if (idx < 0) return 0;
  const id = n.id.toLowerCase();
  if (id === q) return 500;
  if (n.type.toLowerCase() === q) return 100;
  return 10;
}

let searchSuggestActiveIdx = -1;
let searchSuggestItems = [];

function renderSearchSuggest(query) {
  const wrap = $('search-suggest');
  if (!wrap) return;
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    wrap.classList.remove('open');
    wrap.innerHTML = '';
    searchSuggestActiveIdx = -1;
    searchSuggestItems = [];
    return;
  }
  // Calcule les matches
  const allNodes = buildAllNodes();
  const matches = [];
  for (const n of allNodes) {
    const score = scoreNode(n, q);
    if (score > 0) matches.push({ n, score });
  }
  // Tri : score decroissant, puis longueur de raw croissante (plus court = plus pertinent), puis alpha.
  matches.sort((a, b) =>
    b.score - a.score ||
    a.n.raw.length - b.n.raw.length ||
    a.n.raw.localeCompare(b.n.raw)
  );
  const top = matches.slice(0, 8);

  if (top.length === 0) {
    wrap.innerHTML = '<div class="search-suggest-empty">Aucun résultat</div>';
    wrap.classList.add('open');
    searchSuggestActiveIdx = -1;
    searchSuggestItems = [];
    return;
  }

  searchSuggestItems = top.map(m => m.n);
  wrap.innerHTML = top.map((m, i) => {
    return `<div class="search-suggest-item" data-raw="${escapeHtml(m.n.raw)}" data-idx="${i}" role="option">
      <span class="dot type-dot ${typeClass(m.n.type)}"></span>
      <span>${escapeHtml(m.n.raw)}</span>
      <span class="type-label">${escapeHtml(m.n.type)}</span>
    </div>`;
  }).join('');

  wrap.classList.add('open');
  searchSuggestActiveIdx = -1;

  wrap.querySelectorAll('.search-suggest-item').forEach(el => {
    el.addEventListener('mousedown', ev => {
      // mousedown pour valider avant que le blur du champ ne ferme le menu
      ev.preventDefault();
      const raw = el.getAttribute('data-raw');
      const search = $('search');
      if (search) search.value = raw;
      wrap.classList.remove('open');
      render();
    });
  });
}

function initSearchSuggest() {
  const search = $('search');
  const wrap = $('search-suggest');
  if (!search || !wrap) return;

  search.addEventListener('input', () => {
    renderSearchSuggest(search.value);
    // La recherche reste pilotée par getFilteredNodes -> le rendu se fait
    // deja via l'event listener 'input' de render.js (qui appelle render()).
  });

  search.addEventListener('keydown', ev => {
    if (!wrap.classList.contains('open')) return;
    const max = searchSuggestItems.length;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      searchSuggestActiveIdx = (searchSuggestActiveIdx + 1) % max;
      updateActiveSuggest();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      searchSuggestActiveIdx = (searchSuggestActiveIdx - 1 + max) % max;
      updateActiveSuggest();
    } else if (ev.key === 'Enter' && searchSuggestActiveIdx >= 0) {
      ev.preventDefault();
      const raw = searchSuggestItems[searchSuggestActiveIdx].raw;
      search.value = raw;
      wrap.classList.remove('open');
      render();
    } else if (ev.key === 'Escape') {
      wrap.classList.remove('open');
    }
  });

  search.addEventListener('blur', () => {
    // Petit delai pour permettre le mousedown sur un item de la liste
    setTimeout(() => wrap.classList.remove('open'), 150);
  });

  search.addEventListener('focus', () => {
    if (search.value.trim()) renderSearchSuggest(search.value);
  });
}

function updateActiveSuggest() {
  const wrap = $('search-suggest');
  if (!wrap) return;
  wrap.querySelectorAll('.search-suggest-item').forEach((el, i) => {
    el.classList.toggle('active', i === searchSuggestActiveIdx);
  });
}

function renderRelationFilter() {
  const relSel = $('rel-filter');
  const curRel = relSel.value;
  // Relations pertinentes selon la racine de focus active
  const fs = getFocusState();
  let rels;
  if (fs.root) {
    rels = getRelevantRelations(fs.root, fs.depth);
  } else {
    rels = [...new Set(state.tuples.map(t => t.relation))].sort();
  }
  // Si la relation courante n'est plus dans la liste, on la conserve quand meme
  // pour eviter un reset surprise (elle sera retirees au prochain changement)
  if (curRel && !rels.includes(curRel)) rels = [curRel, ...rels];
  rels.sort();
  relSel.innerHTML = '<option value="">Toutes les relations</option>';
  rels.forEach(rel => {
    const o = document.createElement('option');
    o.value = rel; o.textContent = rel;
    if (rel === curRel) o.selected = true;
    relSel.appendChild(o);
  });
}

// API publique : force un re-render du rel-filter (appele quand la racine change).
export function refreshRelFilter() {
  renderRelationFilter();
}

// Barre de statistiques.
function renderStats(allNodes, typeCounts) {
  const allRels = [...new Set(state.tuples.map(t => t.relation))];
  $('stats').innerHTML = `
    <div class="stat"><div class="label">Nœuds</div><div class="value">${allNodes.length}</div></div>
    <div class="stat"><div class="label">Types</div><div class="value">${Object.keys(typeCounts).length}</div></div>
    <div class="stat"><div class="label">Relations</div><div class="value">${allRels.length}</div></div>
    <div class="stat"><div class="label">Tuples</div><div class="value">${state.tuples.length}</div></div>
  `;
}

// Initialisation unique des listeners du search autocomplete.
let _searchInitDone = false;
function initSearchSuggestOnce() {
  if (_searchInitDone) return;
  _searchInitDone = true;
  initSearchSuggest();
}

// Onglets de type (multi-sélection : clic pour basculer).
function renderTypeTabs(allNodes, typeCounts) {
  const tabs = $('type-tabs');
  tabs.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.className = 'tab-pill' + (state.activeTypes.size === 0 ? ' active' : '');
  allBtn.innerHTML = 'Tous <span class="count">' + allNodes.length + '</span>';
  allBtn.onclick = () => { state.activeTypes.clear(); render(); };
  tabs.appendChild(allBtn);

  Object.entries(typeCounts).sort().forEach(([type, cnt]) => {
    const c = cfg(type);
    const btn = document.createElement('button');
    const on = state.activeTypes.has(type);
    btn.className = 'tab-pill' + (on ? ' active' : '');
    btn.setAttribute('data-type', type);
    // La couleur vient de `cfg(type)` côté JS, pas d'une classe CSS
    // hardcodée : on peut gérer n'importe quel type custom.
    btn.style.setProperty('--pill-color', c.border);
    btn.innerHTML = `<i class="ti ${on ? 'ti-check' : c.icon} chip-icon" aria-hidden="true"></i>${type} <span class="count">${cnt}</span>`;
    btn.onclick = () => { toggleType(type); render(); };
    tabs.appendChild(btn);
  });

  if (state.activeTypes.size > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'tab-pill';
    clearBtn.style.color = 'var(--text-tertiary)';
    clearBtn.innerHTML = '<i class="ti ti-x chip-icon" aria-hidden="true"></i> Effacer';
    clearBtn.onclick = () => { state.activeTypes.clear(); render(); };
    tabs.appendChild(clearBtn);
  }
}

// Vue cartes.
function renderCards(nodes) {
  const grid = $('grid');
  grid.innerHTML = '';

  if (nodes.length === 0) {
    grid.innerHTML = `<div class="empty">
      <i class="ti ti-search" aria-hidden="true"></i>
      ${state.tuples.length === 0 ? 'Aucun tuple chargé — utilise <strong>Connexion</strong> ou <strong>Démo</strong>' : 'Aucun nœud correspondant'}
    </div>`;
    return;
  }

  // Virtualisation : au-delà de VIRTUALIZE_THRESHOLD cards,
  // on bascule en mode windowed pour éviter de créer N nodes DOM.
  // < 200 cards → rendu "complet" (hauteur variable, look optimal).
  // >= 200 cards → virtualisé (hauteur fixe, fenêtre visible + buffer).
  if (nodes.length >= VIRTUALIZE_THRESHOLD) {
    renderCardsVirtualized(nodes);
  } else {
    renderCardsDirect(nodes);
  }
}

// ─── Mode "complet" : < VIRTUALIZE_THRESHOLD cards ─────────────────
// Hauteur variable (badges qui wrappent), look optimal.
function renderCardsDirect(nodes) {
  const grid = $('grid');
  grid.classList.remove('virtualized');

  nodes.forEach((node, i) => {
    const c = cfg(node.type);
    const card = document.createElement('div');
    card.className = 'card node-card';
    card.style.setProperty('--accent-bar', c.border);
    card.style.animationDelay = (i * 0.04).toFixed(2) + 's';
    card.setAttribute('tabindex', '0');
    card.onclick = () => onNodeOpen(node);
    card.onkeydown = e => { if (e.key === 'Enter') onNodeOpen(node); };
    // Coloration par diff : si le mode diff est actif, les tuples
    // "added" passent en vert (présent dans B), "removed" en rouge
    // (manque dans B). Sans diff actif, classification = "unchanged".
    const diffCls = classifyCurrentTuple({
      user: node.raw,
      relation: '',
      object: '',
    });
    // On marque la card par une classe CSS qui sera déclinée par
    // tuple en fonction de son statut de diff. Pour le MVP on
    // simplifie : si la card a des tuples sortants/incoming classés
    // "added" / "removed" / "common", on prend le 1er.
    const firstTuple = (node.incoming[0] || node.outgoing[0]);
    if (firstTuple) {
      const cls = classifyCurrentTuple(firstTuple);
      if (cls && cls !== 'unchanged') card.classList.add(`diff-${cls}`);
    }

    card.innerHTML = cardInnerHTML(node, c);
    grid.appendChild(card);
  });
}

// ─── Mode virtualisé : >= VIRTUALIZE_THRESHOLD cards ────────────────
// Hauteur fixe (110px) → calcul row-index = floor(cardIdx / numCols).
// On rend uniquement les cards dont la row est dans la fenêtre
// visible + buffer de 2 rows. DOM ≤ ~200 nodes pour 10k+ tuples.
//
// Architecture :
//   <div class="grid virtualized" style="height: totalHeight">
//     <div class="vrow" style="top: rowY; height: rowHeight">
//       <div class="card">…</div> × numCols
//     </div>
//     … (une vrow par row visible + buffer)
//   </div>
const VIRTUALIZE_THRESHOLD = 200;
const VIRTUAL_BUFFER_ROWS = 2;
const VIRTUAL_ROW_HEIGHT = 120;  // 110 card + 10 gap
const VIRTUAL_CARD_HEIGHT = 110;

function renderCardsVirtualized(nodes) {
  const grid = $('grid');
  grid.classList.add('virtualized');
  grid.innerHTML = '';
  grid.style.position = 'relative';

  const numCols = computeNumCols(grid);
  const numRows = Math.ceil(nodes.length / numCols);
  const totalHeight = numRows * VIRTUAL_ROW_HEIGHT;

  // Spacer principal : garantit que la scrollbar reflète la hauteur
  // totale de la liste virtualisée (sinon le scroll s'arrête trop tôt).
  const spacer = document.createElement('div');
  spacer.style.height = totalHeight + 'px';
  spacer.style.position = 'relative';
  grid.appendChild(spacer);

  // Le défilement se fait dans la zone de contenu (#content) depuis le
  // shell à barre latérale ; la fenêtre reste le repli hors shell.
  const scroller = document.getElementById('content') || null;
  const renderWindow = () => {
    // Positions relatives au haut de la zone visible du conteneur.
    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const gridTop = grid.getBoundingClientRect().top - viewTop; // < 0 une fois défilé
    const viewportTop = 0;
    const viewportBottom = viewHeight;

    // Convertit en row indices : on ajoute un buffer autour.
    const firstVisibleRow = Math.max(0,
      Math.floor((viewportTop - gridTop) / VIRTUAL_ROW_HEIGHT) - VIRTUAL_BUFFER_ROWS);
    const lastVisibleRow = Math.min(numRows - 1,
      Math.ceil((viewportBottom - gridTop) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_BUFFER_ROWS);

    // Nettoie les anciennes vrows, on rerend.
    spacer.innerHTML = '';
    for (let row = firstVisibleRow; row <= lastVisibleRow; row++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'vrow';
      rowEl.style.position = 'absolute';
      rowEl.style.top = (row * VIRTUAL_ROW_HEIGHT) + 'px';
      rowEl.style.left = '0';
      rowEl.style.right = '0';
      rowEl.style.height = VIRTUAL_CARD_HEIGHT + 'px';
      rowEl.style.display = 'grid';
      rowEl.style.gridTemplateColumns = `repeat(${numCols}, 1fr)`;
      rowEl.style.gap = '10px';
      rowEl.style.padding = '0';
      for (let col = 0; col < numCols; col++) {
        const idx = row * numCols + col;
        if (idx >= nodes.length) break;
        const node = nodes[idx];
        const c = cfg(node.type);
        const card = document.createElement('div');
        card.className = 'card node-card virtualized-card';
        card.style.setProperty('--accent-bar', c.border);
        card.setAttribute('tabindex', '0');
        card.onclick = () => onNodeOpen(node);
        card.onkeydown = e => { if (e.key === 'Enter') onNodeOpen(node); };
        card.innerHTML = cardInnerHTML(node, c);
        rowEl.appendChild(card);
      }
      spacer.appendChild(rowEl);
    }
  };

  renderWindow();
  // Throttle scroll : on re-render sur scroll. requestAnimationFrame
  // limite à 60fps max (équivalent au framerate de l'écran).
  let rafId = 0;
  const onScroll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      renderWindow();
    });
  };
  const scrollTarget = scroller || window;
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  // Cleanup si on quitte la vue cartes : on évite les listeners orphelins.
  _cleanupVirtualScroll = () => {
    scrollTarget.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

let _cleanupVirtualScroll = null;

function computeNumCols(grid) {
  // Lit la largeur du grid et applique la même règle CSS
  // (auto-fill, minmax(280px, 1fr)). On approx avec floor + clamp.
  const w = grid.getBoundingClientRect().width || 1400;
  return Math.max(1, Math.floor((w + 10) / (280 + 10)));
}

// Template commun d'une carte (utilisé par les 2 modes de rendu).
// Extrait pour éviter la duplication entre renderCardsDirect et
// renderCardsVirtualized.
// Les cartes ont une hauteur fixe (virtualisation) : les badges tiennent
// sur une ligne. On en affiche tant qu'ils entrent dans la largeur d'une
// carte de 280px (police mono 11px ≈ 6.7px/caractère, + padding, bordure
// et espacement), le reste est résumé par "+N".
const BADGE_BUDGET_PX = 236;
const MORE_BADGE_PX = 40;
const badgeWidth = name => name.length * 6.7 + 24;

function visibleBadges(relations) {
  let used = 0;
  for (let i = 0; i < relations.length; i++) {
    const rest = i < relations.length - 1 ? MORE_BADGE_PX : 0;
    if (used + badgeWidth(relations[i]) + rest > BADGE_BUDGET_PX) return Math.max(i, 1);
    used += badgeWidth(relations[i]);
  }
  return relations.length;
}

function cardInnerHTML(node, c) {
  const allRelsNode = [...new Set([...node.incoming, ...node.outgoing].map(t => t.relation))];
  const shown = visibleBadges(allRelsNode);
  const hidden = allRelsNode.slice(shown);
  const badges = allRelsNode.slice(0, shown).map(r =>
    `<span class="rel-tag type-fill ${typeClass(node.type)}">${escapeHtml(r)}</span>`
  ).join('') + (hidden.length
    ? `<span class="rel-tag rel-tag-more" title="${escapeHtml(hidden.join(', '))}">+${hidden.length}</span>`
    : '');
  return `
      <div class="card-body">
        <div class="icon-box type-bg ${typeClass(node.type)}">
          <i class="ti ${c.icon}" aria-hidden="true"></i>
        </div>
        <div>
          <div class="node-id">${escapeHtml(node.id)}</div>
          <div class="node-type-label">${escapeHtml(node.type)}</div>
        </div>
      </div>
      <div class="card-relations">${badges || '<span class="card-empty">Aucune relation</span>'}</div>`;
}

// Cleanup exporté : à appeler quand on quitte la vue cartes (via
// showHome / setView vers une autre vue).
export function cleanupCardsView() {
  if (_cleanupVirtualScroll) {
    _cleanupVirtualScroll();
    _cleanupVirtualScroll = null;
  }
}
