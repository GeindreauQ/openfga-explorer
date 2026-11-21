// lib/url-state.js — Sérialise l'état UI dans l'URL (query params).
//
// Chaque interaction UI (focus, vue, slider HOP, recherche, filtre par
// type, store, tile) pousse son état dans `window.location` via
// `history.replaceState`. Au boot, l'URL est parsée et l'état est
// restauré en appelant les setters des controllers existants
// (setView, enterFromHome, changeStore, setFocusRoot, ...).
//
// Conventions :
//   - Les clés avec une valeur par défaut sont OMISES de l'URL
//     (pas de `?view=cards` quand l'utilisateur est sur la vue cartes).
//   - `history.replaceState` (pas `pushState`) pour ne pas polluer
//     l'historique du navigateur à chaque interaction.
//   - Les caractères spéciaux sont encodés par URLSearchParams.
//
// Mapping clé → handler (cf. wireUrlState() dans main.js) :
//   view   → setView (cards/graph)
//   tile   → enterFromHome (admin_dsl/audit/manage_tuple/import_export/...)
//   store  → changeStore
//   focus  → setFocusRoot (toolbar)
//   depth  → setFocusDepth
//   type   → type filter
//   search → search input

const DEFAULTS = Object.freeze({
  view: 'cards',
  tile: 'home',
  store: '',
  focus: '',
  depth: '1',
  type: '',
  search: '',
});

const VALID_VIEWS = new Set(['cards', 'graph']);
// Tuiles du tableau de bord (cf. data-tile="…" dans index.html).
// On accepte aussi les synonymes historiques pour la rétro-compat.
const VALID_TILES = new Set([
  'home',
  'admin_dsl',
  'audit',
  'access',
  'assertions',
  'manage_tuple',
  'import_export',
  'graph_svg',
  'graph_cyto',
  'tree',
  'model',
  'connection',
]);

// Compteur de "mute" : tant qu'il est > 0, setUrlParam/removeUrlParam/
// clearUrl sont des no-ops. Utilisé au boot pour restaurer l'état depuis
// l'URL sans la ré-écrire en boucle (sinon le 1er setView() remplacerait
// `tile=admin_dsl` par `view=cards`).
let _muteCount = 0;

export function muteUrlWrites() { _muteCount++; }
export function unmuteUrlWrites() { _muteCount = Math.max(0, _muteCount - 1); }

/**
 * Lit l'URL courante et renvoie un objet {view, tile, store, focus,
 * depth, type, search}. Les valeurs invalides retombent sur le défaut.
 */
export function parseUrl() {
  const sp = new URLSearchParams(window.location.search);
  const out = { ...DEFAULTS };
  const v = sp.get('view');
  if (v && VALID_VIEWS.has(v)) out.view = v;
  const t = sp.get('tile');
  if (t && VALID_TILES.has(t)) out.tile = t;
  const s = sp.get('store');
  if (s) out.store = s;
  const f = sp.get('focus');
  if (f) out.focus = f;
  const d = sp.get('depth');
  if (d && /^[1-5]$/.test(d)) out.depth = d;
  const ty = sp.get('type');
  if (ty) out.type = ty;
  const sq = sp.get('search');
  if (sq) out.search = sq;
  return out;
}

/**
 * Met à jour (ou supprime) une clé de l'URL. La clé est retirée si la
 * valeur est vide / nulle / égale au défaut. Évite les entrées
 * redondantes dans l'URL.
 */
export function setUrlParam(key, value) {
  if (!(key in DEFAULTS)) return;
  if (_muteCount > 0) return;
  const sp = new URLSearchParams(window.location.search);
  if (value === '' || value == null || value === DEFAULTS[key]) {
    sp.delete(key);
  } else {
    sp.set(key, String(value));
  }
  applySearchParams(sp);
}

/**
 * Vide entièrement l'URL (retour à l'URL "clean" sans query params).
 * Utilisé par le bouton Accueil.
 */
export function clearUrl() {
  if (_muteCount > 0) return;
  applySearchParams(new URLSearchParams());
}

/** Renvoie l'URL absolue courante (utile pour le bouton Share). */
function currentUrl() {
  return window.location.href;
}

/**
 * Copie l'URL courante dans le presse-papier. Renvoie `true` si OK.
 * Lève une erreur explicite si l'API Clipboard n'est pas dispo
 * (ex: HTTP non sécurisé, ancien navigateur).
 */
export async function copyUrlToClipboard() {
  if (!navigator?.clipboard?.writeText) {
    throw new Error('Clipboard API indisponible');
  }
  await navigator.clipboard.writeText(currentUrl());
  return true;
}

/**
 * Applique les query params au navigateur via replaceState. No-op si
 * l'URL ne change pas (évite les replaceState inutiles).
 */
function applySearchParams(sp) {
  const qs = sp.toString();
  const target = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname;
  const current = window.location.pathname + window.location.search;
  if (target === current) return;
  try {
    window.history.replaceState(null, '', target);
  } catch {
    // Certains navigateurs rejettent les replaceState cross-origin ;
    // on ignore (l'URL reste fonctionnelle pour les prochains reads).
  }
}

/** Exposé pour les tests + debug. */
export { DEFAULTS as URL_DEFAULTS };