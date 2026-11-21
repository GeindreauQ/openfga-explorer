// controllers/router.js — Orchestre les transitions entre vues
// (home, cards, graph, page DSL).
//
// Responsabilités :
//   - tenir l'état `currentView`
//   - afficher / masquer les sections du DOM
//   - invoquer le renderer de la vue active (cartesian ou graphe Cytoscape)
//
// Le câblage des événements est fait dans main.js ; ce module expose
// `setView(view)` et `showHome()` qui sont les deux points d'entrée.

import { $ } from '../lib/dom.js';
import { state, getFocusState } from '../lib/state.js';
import { toast } from '../lib/toast.js';
import { setUrlParam, clearUrl } from '../lib/url-state.js';
import {
  renderGraph, destroyGraph, isGraphActive,
  graphZoom, graphReset, centerGraphOn,
} from '../views/graph.js';
import { render, cleanupCardsView } from '../views/cards.js';
import { openAddTuple } from '../views/add-tuple.js';
import { openModel } from '../views/model-panel.js';
import { toggleConfig } from '../config.js';
import { refreshHomeStats } from './home-stats.js';

let _render = render;
let _openModel = openModel;
let _toggleConfig = toggleConfig;

/** Permet à main.js d'injecter les références (casse les cycles). */
export function wireRouter(deps) {
  if (deps.render) _render = deps.render;
  if (deps.openModel) _openModel = deps.openModel;
  if (deps.toggleConfig) _toggleConfig = deps.toggleConfig;
}

/**
 * Liste des sections plein écran du type "page" (audit, io, dsl).
 * Centralisée pour s'assurer que `showHome()` masque bien tout, sinon
 * le panneau de la dernière page reste visible en bas de l'accueil
 * (scroll-down). Chaque entrée ajoute sa page dans cette liste, et
 * `hideAllPages()` la remet à hidden.
 */
const _pages = ['dsl-page', 'audit-page', 'io-page', 'assertions-page', 'access-page'];

/** Masque toutes les pages plein écran (helper interne). */
function hideAllPages() {
  for (const id of _pages) {
    $(id)?.setAttribute('hidden', '');
  }
}

/**
 * Affiche le tableau de bord (grille de tuiles). Le main (toolbar +
 * vues) est masqué via la classe `home-shown` sur <body>. On s'assure
 * également que toutes les pages plein écran (audit, io, dsl) sont
 * bien masquées — sinon la dernière page visitée reste visible en
 * bas de l'accueil, accessible via scroll-down.
 */
export function showHome() {
  if (isGraphActive()) destroyGraph();
  state.currentView = 'home';
  document.body.classList.remove('dsl-shown', 'audit-shown', 'io-shown', 'assertions-shown', 'access-shown');
  hideAllPages();
  document.body.classList.add('home-shown');
  $('home-dashboard')?.removeAttribute('hidden');
  for (const btn of document.querySelectorAll('#view-switch button[data-view]')) {
    btn.classList.remove('active');
  }
  refreshHomeStats();
  // L'Accueil est l'état "neutre" : on purge l'URL pour repartir d'une
  // base clean. Tous les query params (view, tile, focus, ...) sautent.
  clearUrl();
}

/**
 * Entre une vue depuis le tableau de bord. Cache le dashboard, montre
 * le main, et route vers la sous-vue demandée.
 */
export async function enterFromHome(tile) {
  document.body.classList.remove('home-shown');
  $('home-dashboard')?.setAttribute('hidden', '');

  // Sérialise la tuile dans l'URL pour partage / refresh. On omet
  // les synonymes internes (graph / tree / model / connection) au
  // profit de leur représentation canonique.
  const urlTile = normalizeTileForUrl(tile);
  setUrlParam('tile', urlTile);

  switch (tile) {
    case 'manage_tuple':
      await setView('cards');
      break;
    case 'admin_dsl':
      // Délégué au controller DSL — chargé en async pour éviter un
      // import circulaire.
      const { showDSLPage } = await import('./dsl-page.js');
      await showDSLPage();
      break;
    case 'access':
      const { showAccessPage } = await import('./access-page/index.js');
      await showAccessPage();
      break;
    case 'audit':
      const { showAuditPage } = await import('./audit-page/index.js');
      await showAuditPage();
      break;
    case 'import_export':
      const { showIoPage } = await import('./tuples-io.js');
      await showIoPage();
      break;
    case 'assertions':
      const { showAssertionsPage } = await import('./assertions-page/index.js');
      await showAssertionsPage();
      break;
    case 'graph_svg':
    case 'graph_cyto':
      await setView('graph');
      break;
    case 'tree':
      if (!getFocusState().root) {
        toast("Sélectionnez d'abord un nœud racine (focus voisinage).", true);
        showHome();
        return;
      }
      await setView('cards');
      const tree = $('tree-panel');
      if (tree) tree.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;
    case 'model':
      await setView('cards');
      _openModel();
      break;
    case 'connection':
      await setView('cards');
      _toggleConfig();
      break;
    default:
      console.warn('enterFromHome: unknown tile', tile);
      await setView('cards');
  }
}

/**
 * Mappe les noms internes de tuiles vers leur représentation URL.
 * `manage_tuple` correspond à la vue cartes par défaut (pas de `tile`
 * dans l'URL → on utilise `tile=manage_tuple` pour distinguer du home).
 * `graph_svg` / `graph_cyto` se réduisent à `tile=manage_tuple&view=…`.
 */
function normalizeTileForUrl(tile) {
  if (tile === 'graph_svg' || tile === 'graph_cyto') return 'manage_tuple';
  if (tile === 'tree' || tile === 'model' || tile === 'connection') return 'manage_tuple';
  return tile;
}

/**
 * Bascule entre les vues disponibles :
 *   - 'cards'    : vue cartes
 *   - 'graph'    : vue graphe (Cytoscape)
 *   - 'graph-cy' : alias pour 'graph' (backward compat)
 */
export async function setView(view) {
  // Normalise graph-cy → graph pour backward compat
  const normalizedView = view === 'graph-cy' ? 'graph' : view;

  // No-op si la vue ne change pas : évite de re-rendre inutilement
  // (notamment le re-layout du graphe avec `fit: true` qui vole la
  // caméra à l'utilisateur). Les callers qui ont besoin d'un re-render
  // forcé peuvent détruire l'instance (destroyGraph) avant.
  if (state.currentView === normalizedView && !document.body.classList.contains('home-shown')) {
    return;
  }
  if (document.body.classList.contains('home-shown')) {
    document.body.classList.remove('home-shown');
    $('home-dashboard')?.setAttribute('hidden', '');
  }
  // Sérialise la vue dans l'URL (setUrlParam omet les valeurs par défaut,
  // donc `?view=cards` n'apparaît pas quand on est sur la vue cartes).
  setUrlParam('view', normalizedView);
  // Si on quitte une page plein écran (audit, io, dsl) vers la vue
  // principale, on remet toutes les pages à hidden et on nettoie les
  // classes d'état correspondantes.
  const fullPageClasses = ['dsl-shown', 'audit-shown', 'io-shown', 'assertions-shown', 'access-shown'];
  for (const cls of fullPageClasses) {
    if (document.body.classList.contains(cls)) {
      document.body.classList.remove(cls);
    }
  }
  hideAllPages();
  const wasGraphActive = isGraphActive();
  if (wasGraphActive && normalizedView !== 'graph') destroyGraph();

  // Si on quitte la vue cartes, on libère les listeners de scroll
  // du mode virtualisé. Sans ça, ils restent actifs et
  // fire même quand on est sur la home.
  if (state.currentView === 'cards' && normalizedView !== 'cards') {
    cleanupCardsView();
  }

  state.currentView = normalizedView;
  const btnCards = $('view-cards');
  const btnGraph = $('view-graph');
  if (btnCards) btnCards.classList.toggle('active', normalizedView === 'cards');
  if (btnGraph) btnGraph.classList.toggle('active', normalizedView === 'graph');

  const grid = $('grid');
  const wrap = $('graph-wrap');
  if (grid) grid.style.display = normalizedView === 'cards' ? '' : 'none';
  if (wrap) wrap.classList.toggle('show', normalizedView !== 'cards');

  if (normalizedView === 'graph') {
    const { getFilteredNodes } = await import('../views/cards.js');
    try {
      await renderGraph(getFilteredNodes());
      const fs = getFocusState();
      if (fs.root) centerGraphOn(fs.root);
    } catch (err) {
      // Moteur non chargé : le panneau #cy-error l'explique déjà.
      if ($('cy-error')?.hidden !== false) toast('Graphe indisponible : ' + err.message, true);
      console.error(err);
    }
    return;
  }
  _render();
}

/** Helpers exposés pour les boutons zoom/reset de la toolbar graphe. */
export function graphZoomIn() {
  if (isGraphActive()) graphZoom(1.25);
}
export function graphZoomOut() {
  if (isGraphActive()) graphZoom(0.8);
}
export function graphResetView() {
  if (isGraphActive()) graphReset();
}