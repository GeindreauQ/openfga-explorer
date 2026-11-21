// controllers/focus.js — câblage des interactions focus voisinage.
//
// Regroupe tous les handlers qui pilotent la racine de focus, la
// profondeur (HOP), la sélection de nœud (SVG + Cytoscape), le reset
// via le bouton ou via le clic sur le fond, et la synchro entre les
// panneaux (focus-root select, tree sidebar, graph).
//
// Pattern d'injection : `wireFocusEvents(deps)` reçoit tous les setters
// et helpers dont il a besoin. Aucun import depuis main.js — le sens
// de la dépendance reste main.js → controllers/focus.js.

import { $ } from '../lib/dom.js';
import { buildAllNodes, getFocusableNodes, getFocusState } from '../lib/state.js';
import { setUrlParam } from '../lib/url-state.js';

/** Synchronise le panneau focus avec l'état du module graph. */
export function syncFocusUI() {
  const sel = document.getElementById('focus-root');
  if (!sel) return;
  populateFocusRootSelect(sel);
  sel.value = getFocusState().root || '';
}

/** Remplit le <select id=focus-root> avec tous les nœuds, groupés par type. */
function populateFocusRootSelect(sel) {
  const current = sel.value;
  const nodes = getFocusableNodes();
  sel.innerHTML = '<option value="">— aucun —</option>';
  const byType = {};
  for (const n of nodes) (byType[n.type] = byType[n.type] || []).push(n);
  Object.keys(byType).sort().forEach(t => {
    const og = document.createElement('optgroup');
    og.label = t;
    byType[t].forEach(n => {
      const o = document.createElement('option');
      o.value = n.raw; o.textContent = n.id;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  sel.value = current;
}

export function wireFocusEvents(deps) {
  const {
    $, setView, render,
    setFocusRoot, setFocusDepth, clearFocus, getFocusState,
    setTreeRoot, setTreeDepth, closeTree, fitToView,
    refreshRelFilter, refreshGraphFocus,
    openModal, openAddTuple,
  } = deps;

  // Mémorise le dernier nœud cliqué pour distinguer 1er clic (focus) vs
  // 2e clic (modale de détail).
  let lastClickedNodeRaw = '';

  // Expose un hook pour que le changement de store (dans main.js) puisse
  // réinitialiser l'historique de clics. Sans ça, après un switch de
  // store, le 1er clic sur le même nœud raw serait interprété comme
  // un 2e clic et ouvrirait directement la modale au lieu de focus.
  if (typeof window !== 'undefined') {
    window.__focusResetClickHistory = () => { lastClickedNodeRaw = ''; };
  }

  // Reset les filtres UI (search + rel-filter). Renvoie true si quelque
  // chose a changé (ce qui implique de re-rendre après).
  function resetUIFilters() {
    let changed = false;
    const search = $('search');
    if (search && search.value !== '') {
      search.value = '';
      const wrap = $('search-suggest');
      if (wrap) wrap.classList.remove('open');
      changed = true;
    }
    const rel = $('rel-filter');
    if (rel && rel.value !== '') {
      rel.value = '';
      changed = true;
    }
    return changed;
  }

  // ── 1. Clic sur un nœud du graphe (via cy-node-tap) ──────────────────
  if (typeof window !== 'undefined') {
    window.addEventListener('cy-node-tap', ev => {
      const raw = ev.detail.raw;
      const allNodes = buildAllNodes();
      const node = allNodes.find(n => n.raw === raw);
      if (!node) return;
      if (raw === lastClickedNodeRaw) {
        lastClickedNodeRaw = '';
        const changed = resetUIFilters();
        openModal(node);
        if (changed) render();
      } else {
        lastClickedNodeRaw = raw;
        setView('graph');
        setFocusRoot(raw);
        setTreeRoot(raw);
        setFocusDepth(parseInt($('tree-depth').value, 10) || 1);
        refreshRelFilter();
        refreshGraphFocus();
        const sel = document.getElementById('focus-root');
        if (sel) sel.value = raw;
      }
    });
  }

  // ── 2. Reset du focus (bouton ou clic fond) ──────────────────────────
  function resetFocusUI() {
    if (!getFocusState().root) return; // no-op si pas de racine active
    clearFocus();
    closeTree();
    $('focus-root').value = '';
    lastClickedNodeRaw = '';
    if (typeof refreshRelFilter === 'function') refreshRelFilter();
    refreshGraphFocus();
  }
  $('btn-focus-clear').addEventListener('click', resetFocusUI);
  // Clic sur le fond du graphe → reset.
  if (typeof window !== 'undefined') {
    window.addEventListener('cy-background-tap', resetFocusUI);
  }

  // ── 3. Sélecteur de racine (toolbar) ─────────────────────────────────
  $('focus-root').addEventListener('change', e => {
    const raw = e.target.value;
    setFocusRoot(raw);
    setTreeRoot(raw);
    setFocusDepth(parseInt($('tree-depth').value, 10) || 1);
    refreshRelFilter();
    refreshGraphFocus();
    setUrlParam('focus', raw);
  });

  // ── 4. Slider de profondeur (HOP) ────────────────────────────────────
  $('tree-depth').addEventListener('input', e => {
    const n = parseInt(e.target.value, 10) || 1;
    $('tree-depth-val').textContent = n;
    setTreeDepth(n);
    setFocusDepth(n);
    setUrlParam('depth', String(n));
    refreshGraphFocus();
  });

  // ── 5. Clic sur un nœud dans le tree (panneau droit) ─────────────────
  if (typeof window !== 'undefined') {
    window.addEventListener('tree-node-focus', ev => {
      const raw = ev.detail.raw;
      lastClickedNodeRaw = raw;
      setFocusRoot(raw);
      setTreeRoot(raw);
      setFocusDepth(parseInt($('tree-depth').value, 10) || 1);
      refreshRelFilter();
      refreshGraphFocus();
      $('focus-root').value = raw;
    });
  }
}
