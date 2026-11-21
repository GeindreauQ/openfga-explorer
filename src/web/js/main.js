// Point d'entrée du frontend : initialise l'état, câble les événements
// globaux et lance l'init.
//
// L'orchestration est éclatée en controllers spécialisés :
//   - controllers/router.js    : transitions entre vues (home, cards, graph, DSL)
//   - controllers/store.js     : changement de store + chargement tuples
//   - controllers/dsl-page.js  : page Admin DSL (éditeur + graphe)
//   - controllers/focus.js     : focus voisinage
//   - controllers/home-stats.js: stats du tableau de bord
//
// Ce fichier ne fait que câbler ces modules entre eux et avec le DOM.

import { $ } from './lib/dom.js';
import { state, toggleType } from './lib/state.js';
import { toast } from './lib/toast.js';
import { loadTheme } from './lib/theme.js';
import { getMe, setCsrfToken, selectStore } from './lib/api.js';
import { connection, refreshConnection, toggleConfig } from './config.js';
import {
  parseUrl, setUrlParam, muteUrlWrites, unmuteUrlWrites,
  copyUrlToClipboard, URL_DEFAULTS as DEFAULTS,
} from './lib/url-state.js';
import {
  initEvents, addEventListener as addSSEListener,
} from './lib/events.js';
import { render, setNodeOpenHandler, getFilteredNodes, refreshRelFilter } from './views/cards.js';
import {
  setGraphFocusProvider, refreshGraphFocus, renderGraph,
} from './views/graph.js';
import { openModal, closeModal, setOpenAddTuple, onBackdropClick } from './views/modal.js';
import { openAddTuple, initAddTupleForm } from './views/add-tuple.js';
import { initPendingPanel } from './views/pending-panel.js';
import { initCodegenPanel } from './views/codegen-panel.js';
import { initStoreDiffPanel } from './views/store-diff-panel.js';
import { openModel, closeModel, onModelBackdropClick } from './views/model-panel.js';
import { setTreeRoot, setTreeDepth, closeTree, fitToView, refreshLayout } from './views/tree.js';
import { setFocusRoot, setFocusDepth, clearFocus, getFocusState } from './lib/state.js';
import { wireFocusEvents, syncFocusUI } from './controllers/focus.js';
import {
  wireRouter, showHome, setView, enterFromHome,
  graphZoomIn, graphZoomOut, graphResetView,
} from './controllers/router.js';
import { wireStore, changeStore, loadFromAPI } from './controllers/store.js';
import { refreshHomeStats } from './controllers/home-stats.js';
import { loadDSL } from './controllers/dsl-page.js';
import { wireShell } from './controllers/shell.js';
import { apply as applyColorScheme } from './lib/color-scheme.js';

// ── Résolution des dépendances inter-modules ─────────────────────────────────
setNodeOpenHandler(openModal);
setGraphFocusProvider(getFocusState);
setOpenAddTuple(openAddTuple);

// ── Wire des controllers ────────────────────────────────────────────────────
wireFocusEvents({
  $, state, setView, render,
  setFocusRoot, setFocusDepth, clearFocus, getFocusState,
  setTreeRoot, setTreeDepth, closeTree, fitToView,
  refreshRelFilter, refreshGraphFocus,
  openModal, openAddTuple,
});

wireRouter({
  render, openModel, toggleConfig,
});

wireStore({
  loadFromAPI,
  loadDSL,
});

// Quand la connexion change (refresh initial, ou après un
// changeStore), on remet à jour les stats du hero si on est sur la
// home. Le refresh initial est géré dans refreshConnection lui-même
// (config.js) ; ici on couvre les changements émis par les controllers.
document.addEventListener('connection-refreshed', () => {
  if (document.body.classList.contains('home-shown')) {
    refreshHomeStats();
  }
});

// Hook pour permettre à render() de redessiner le graphe après un
// changement de filtres ou de tuples, sans import circulaire.
if (typeof window !== 'undefined') {
  window.__renderGraph = (nodes) => {
    if (state.currentView !== 'graph') return;
    renderGraph(nodes).catch(err => {
      if ($('cy-error')?.hidden !== false) toast('Graphe : ' + err.message, true);
      console.error(err);
    });
  };
}

// ── Events wiring ──────────────────────────────────────────────────────────

function initTreeResizer() {
  const resizer = $('tree-resizer');
  const panel = $('tree-panel');
  if (!resizer || !panel) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = ev => {
    if (!dragging) return;
    const dx = startX - ev.clientX;
    const newWidth = Math.max(240, Math.min(window.innerWidth * 0.8, startWidth + dx));
    panel.style.width = newWidth + 'px';
    document.documentElement.style.setProperty('--tree-width', newWidth + 'px');
    refreshLayout();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  resizer.addEventListener('mousedown', ev => {
    dragging = true;
    startX = ev.clientX;
    startWidth = panel.getBoundingClientRect().width;
    panel.classList.add('resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    ev.preventDefault();
  });
  window.addEventListener('resize', () => {
    if (panel.classList.contains('open')) refreshLayout();
  });
}

function wireEvents() {
  $('btn-open-model')?.addEventListener('click', openModel);
  $('btn-toggle-config')?.addEventListener('click', toggleConfig);
  $('btn-share')?.addEventListener('click', async () => {
    try {
      await copyUrlToClipboard();
      toast('Lien copié dans le presse-papier');
    } catch (e) {
      toast('Copie impossible : ' + (e?.message || 'API Clipboard indisponible'), true);
    }
  });

  document.querySelectorAll('.home-tile').forEach(tile => {
    tile.addEventListener('click', async () => {
      await enterFromHome(tile.getAttribute('data-tile'));
      // Raccourci vers un onglet précis de la page Accès.
      if (tile.dataset.accessTab) (await import('./controllers/access-page/index.js')).selectAccessTab(tile.dataset.accessTab);
    });
  });

  $('home-quick-add')?.addEventListener('click', () => openAddTuple());
  $('home-quick-refresh')?.addEventListener('click', () => loadFromAPI());
  $('home-quick-switch')?.addEventListener('click', () => {
    const sel = $('store-select');
    if (sel) sel.focus();
  });

  $('store-select')?.addEventListener('change', e => changeStore(e.target.value));

  $('search')?.addEventListener('input', () => {
    setUrlParam('search', $('search').value);
    render();
  });
  $('rel-filter')?.addEventListener('change', render);

  // Type filter : les onglets `.tab-pill` sont reconstruits à chaque
  // render, donc on écoute au niveau du conteneur parent (event
  // delegation). On sérialise le type actif dans l'URL.
  const typeTabs = $('type-tabs');
  if (typeTabs) {
    typeTabs.addEventListener('click', () => {
      setUrlParam('type', state.activeTypes.size === 1 ? [...state.activeTypes][0] : '');
    });
  }
  $('btn-add-tuple')?.addEventListener('click', () => openAddTuple());
  $('btn-connect')?.addEventListener('click', toggleConfig);

  document.querySelectorAll('#view-switch button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.getAttribute('data-view')));
  });

  // Graphe non chargé : nouvel essai, ou retour à la vue cartes.
  $('cy-error-retry')?.addEventListener('click', () => window.__renderGraph(getFilteredNodes()));
  $('cy-error-cards')?.addEventListener('click', () => setView('cards'));

  $('btn-graph-zoom-in')?.addEventListener('click', () => graphZoomIn());
  $('btn-graph-zoom-out')?.addEventListener('click', () => graphZoomOut());
  $('btn-graph-reset')?.addEventListener('click', () => graphResetView());

  $('btn-tree-fit')?.addEventListener('click', () => fitToView());
  $('btn-tree-close')?.addEventListener('click', () => {
    closeTree();
    $('focus-root').value = '';
  });

  initTreeResizer();

  window.addEventListener('open-node-detail', ev => {
    if (ev.detail.node) openModal(ev.detail.node);
  });
  window.addEventListener('tree-add-tuple', ev => {
    const { role, raw } = ev.detail;
    if (role === 'object') openAddTuple({ object: raw });
    else openAddTuple({ user: raw });
  });

  $('btn-close-modal')?.addEventListener('click', closeModal);
  $('modal-backdrop')?.addEventListener('click', e => onBackdropClick(e));
  $('btn-close-model')?.addEventListener('click', closeModel);
  $('model-backdrop')?.addEventListener('click', e => onModelBackdropClick(e));
  initKeyboardShortcuts();
}

/** Synchronise le panneau focus avec l'état du module graph. */
// (syncFocusUI importé depuis controllers/focus.js)

/**
 * Applique l'état parsé depuis l'URL au boot. Doit être appelée après
 * `refreshConnection` + chargement initial des tuples (pour que la
 * liste des stores / focus-root select soit peuplée).
 *
 * Les setters écrivent aussi dans l'URL — on les mute donc pendant
 * toute la durée de la restauration (sinon ils ré-écraseraient les
 * clés qu'on vient de lire).
 */
async function applyUrlState() {
  const url = parseUrl();
  const isClean = Object.entries(url).every(([k, v]) => v === '' || v === DEFAULTS[k]);
  if (isClean) return; // URL clean → rien à restaurer, on finit sur le home

  muteUrlWrites();
  try {
    // 1. Store (si différent du store actif + existe dans la liste)
    if (url.store && connection.stores.some(s => s.id === url.store)) {
      if (url.store !== connection.storeId) {
        try { await changeStore(url.store); } catch (e) { console.warn('applyUrlState: store switch failed', e); }
      }
    }
    // 2. Tile + view. On combine les deux pour router correctement :
    //    - tile=admin_dsl / audit / import_export / manage_tuple
    //      → enterFromHome(...) ouvre la bonne page
    //    - view=graph en complément → setView() après.
    //    - tile=home (rare, possiblement leftover) → on l'ignore.
    let targetTile = null;
    if (url.tile && url.tile !== 'home') {
      targetTile = url.view === 'graph' ? 'graph_svg' : url.tile;
    } else if (url.view && url.view !== 'cards') {
      // Pas de tile mais une vue précise → on va en manage_tuple + view
      targetTile = 'manage_tuple';
    }
    if (targetTile) {
      await enterFromHome(targetTile);
      // Si le tile ne porte pas déjà la vue, on l'applique séparément
      if (targetTile === 'manage_tuple' && url.view && url.view !== 'cards') {
        await setView(url.view);
      }
    }
    // 3. Focus + depth (sur la vue active)
    const sel = document.getElementById('focus-root');
    if (sel && url.focus) {
      if ([...sel.options].some(o => o.value === url.focus)) {
        sel.value = url.focus;
        sel.dispatchEvent(new Event('change'));
      }
    }
    const depthEl = document.getElementById('tree-depth');
    if (depthEl && url.depth) {
      depthEl.value = url.depth;
      const valEl = document.getElementById('tree-depth-val');
      if (valEl) valEl.textContent = url.depth;
      depthEl.dispatchEvent(new Event('input'));
    }
    // 4. Search + type filter (lecture seule, on synchronise les inputs)
    const searchEl = document.getElementById('search');
    if (searchEl && url.search) searchEl.value = url.search;
    if (url.type) {
      toggleType(url.type);
      render();
    } else if (url.search) {
      render();
    }
  } finally {
    unmuteUrlWrites();
  }
}

async function init() {
  applyColorScheme();
  wireShell();
  wireEvents();
  initAddTupleForm();
  initPendingPanel();
  initCodegenPanel();
  initStoreDiffPanel();
  loadTheme();
  // Charge le thème (icônes/couleurs par type) depuis le backend.
  // Silencieux en cas d'échec : `cfg()` reste sur le built-in, donc
  // l'utilisateur ne voit aucune différence si le YAML est absent.
  await refreshConnection();
  let me = null;
  try {
    me = await getMe();
    if (me && me.csrf_token) setCsrfToken(me.csrf_token);
    renderUser(me);
  } catch {
    // Pas authentifié ou pas de cookie : on reste sans CSRF. Toutes les
    // routes mutatrices renverront 401 (auth.Middleware) avant 403.
  }

  // Une session sans store choisi utilise le store par défaut du serveur
  // (cf. effectiveStoreID) : rien à sélectionner ici, ce qui évitait une
  // course avec un choix fait entre-temps.

  // Lien partagé (?store=…) : on sélectionne ce store avant le premier
  // chargement, sinon la page affiche d'abord le store précédent.
  const urlStore = new URLSearchParams(window.location.search).get('store');
  if (urlStore && urlStore !== connection.storeId && connection.stores.some(s => s.id === urlStore)) {
    try {
      await selectStore(urlStore);
      await refreshConnection();
    } catch (e) {
      console.warn('init: store from URL failed', e);
    }
  }

  if (connection.configured && connection.storeId) {
    try { await loadDSL(); } catch (e) { console.warn('init: loadDSL failed', e); }
    await loadFromAPI();
  } else if (connection.configured) {
    state.tuples = [];
    render();
    syncFocusUI();
    showHome();
    toast('Sélectionnez un store OpenFGA dans la toolbar', true);
    return;
  } else {
    state.tuples = [];
    render();
    syncFocusUI();
    showHome();
    toast('OpenFGA non configuré côté serveur (OPENFGA_URL manquant)', true);
    return;
  }
  // Restaure l'état depuis l'URL (tile, view, focus, ...). Doit venir
  // après `loadFromAPI` pour que le focus-root select soit peuplé.
  await applyUrlState();
  // Si l'URL ne dit rien de spécifique, on finit sur le tableau de bord.
  const sp = new URLSearchParams(window.location.search);
  if (!sp.get('tile') && !sp.get('view')) showHome();

  // SSE : on s'abonne au flux temps-réel. Désactivable
  // via `window.__sseDisabled = true` avant init() (utilisé par les
  // tests Playwright qui font `waitUntil: 'networkidle'` — le flux
  // SSE maintient la connexion active et empêche le networkidle de
  // se déclencher). En prod, SSE est toujours actif.
  if (typeof window !== 'undefined' && !window.__sseDisabled) {
    initEvents();
    const { connection } = await import('./config.js');
    addSSEListener('tuples.write', async (evt) => {
      // Filtre par store actif : on ignore les events des autres stores.
      if (evt.store_id && connection.storeId && evt.store_id !== connection.storeId) {
        return;
      }
      // Si on vient de faire l'écriture nous-mêmes (dans les 500ms),
      // on ne refetch pas — notre POST a déjà ramené l'état.
      if (Date.now() - state.lastLocalWriteAt < 500) {
        return;
      }
      const src = evt.source === 'import' ? 'un import' : 'un autre client';
      toast(`Tuples mis à jour (${evt.count || '?'}) par ${src}`);
      try { await loadFromAPI(); } catch (e) { console.warn('SSE refetch:', e); }
    });
    addSSEListener('dsl.apply', async (evt) => {
      if (evt.store_id && connection.storeId && evt.store_id !== connection.storeId) {
        return;
      }
      toast(`Nouveau modèle appliqué (${evt.types || '?'} types)`);
      try {
        await loadDSL();
      } catch (e) { console.warn('SSE loadDSL:', e); }
    });
  }
}

// ── Keyboard shortcuts ───────────────────────────────────────────
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore in input fields
    if (e.target.matches('input, textarea, select, [contenteditable]')) return;
    // Ignore modifier combos
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'g':
        if (state.currentView !== 'graph') setView('graph');
        break;
      case 'c':
        if (state.currentView !== 'cards') setView('cards');
        break;
      case 'h':
      case '?':
        showHome();
        break;
      case 'n':
        openAddTuple();
        break;
      case '1':
        enterFromHome('admin_dsl');
        break;
      case '2':
        enterFromHome('audit');
        break;
      case '3':
        enterFromHome('manage_tuple');
        break;
      case '4':
        enterFromHome('import_export');
        break;
      case '5':
        enterFromHome('assertions');
        break;
    }
  });
}

init();

// Utilisateur connecté dans l'en-tête ; en lecture seule (rôle viewer),
// body.read-only masque tout ce qui porte data-requires-write. Le serveur
// refuse de toute façon les écritures (403).
function renderUser(me) {
  const user = me && me.authenticated ? me.user : null;
  const chip = document.getElementById('user-chip');
  if (!user || !chip) return;
  const name = user.name || user.preferred_username || user.email || user.sub;
  document.getElementById('user-name').textContent = name;
  chip.title = [user.email, user.groups?.length ? `Groupes : ${user.groups.join(', ')}` : ''].filter(Boolean).join('\n');
  const readOnly = user.role === 'viewer';
  document.getElementById('user-role').hidden = !readOnly;
  document.body.classList.toggle('read-only', readOnly);
  chip.hidden = false;
}
