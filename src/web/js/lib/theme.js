// lib/theme.js — Thème visuel des types OpenFGA (icônes + couleurs).
//
// Le thème principal vit côté backend (config YAML, section `theme:`)
// et est servi via `GET /api/config/theme`. Ce module :
//
//   - garde une copie built-in (même contenu que `config/defaults.go`
//     et l'ancien `models/types.js`) pour fonctionner même si la route
//     backend est inaccessible (mode dev, perte de réseau, etc.) ;
//   - expose `loadTheme()` qui fetch le YAML-sérialisé au boot et
//     remplace les valeurs built-in par celles du serveur ;
//   - expose `getTheme()` pour les vues qui veulent relire l'état
//     courant (rare — la plupart utilisent directement `cfg()`).
//
// Synchronisation : `loadTheme()` retourne une Promise. `main.js`
// l'await avant le tout premier render. Tant que la Promise n'est
// pas résolue, `cfg()` lit les built-in (visiblement identique à
// l'avant, donc transparent pour l'utilisateur).

const BUILTIN_TYPES = {
  user:         { icon: 'ti-user',               bg: '#E6F1FB', text: '#0C447C', border: '#85B7EB' },
  organization: { icon: 'ti-building-community', bg: '#EFE8F4', text: '#3F2A6B', border: '#9F88C2' },
  team:         { icon: 'ti-users',              bg: '#F0E8E1', text: '#5A2E0E', border: '#C99B7A' },
  document:     { icon: 'ti-file-text',          bg: '#F4F0E5', text: '#3D3514', border: '#C2B170' },
  folder:       { icon: 'ti-folder',             bg: '#E5F4F0', text: '#0D4A2E', border: '#6FC79E' },
  network:      { icon: 'ti-network',            bg: '#E8EEF7', text: '#1B365C', border: '#7AA0CD' },
  plan:         { icon: 'ti-license',            bg: '#FAEEF0', text: '#6B1F2E', border: '#D48594' },
  feature:      { icon: 'ti-star',               bg: '#FFF6E0', text: '#6B4D00', border: '#D7B75A' },
  repo:         { icon: 'ti-brand-git',          bg: '#EAEEF8', text: '#1B2A52', border: '#7F94C7' },
};

const BUILTIN_PALETTE = [
  { icon: 'ti-circle',   bg: '#E6F1FB', text: '#0C447C', border: '#85B7EB' },
  { icon: 'ti-square',   bg: '#FBEAF0', text: '#72243E', border: '#ED93B1' },
  { icon: 'ti-triangle', bg: '#EEEDFE', text: '#3C3489', border: '#AFA9EC' },
  { icon: 'ti-diamond',  bg: '#FAEEDA', text: '#633806', border: '#EF9F27' },
  { icon: 'ti-hexagon',  bg: '#EAF3DE', text: '#27500A', border: '#97C459' },
  { icon: 'ti-octagon',  bg: '#E1F5EE', text: '#085041', border: '#5DCAA5' },
  { icon: 'ti-pentagon', bg: '#FAECE7', text: '#712B13', border: '#F0997B' },
  { icon: 'ti-star',     bg: '#E6F1FB', text: '#155366', border: '#7FC2D6' },
];

const BUILTIN_DEFAULT = {
  icon: 'ti-circle-dot', bg: '#F1EFE8', text: '#444441', border: '#B4B2A9',
};

let _theme = null;     // null = pas encore chargé → utilise le built-in
let _loaded = false;   // true après un loadTheme() réussi ou échoué

/**
 * Fetch le thème côté backend. Appelé une fois au boot depuis
 * `main.js`. En cas de succès, le cache interne est mis à jour ; en
 * cas d'échec (réseau, 404, JSON invalide), on reste sur le built-in
 * (l'app continue à fonctionner — comportement préservé).
 *
 * Idempotent : appeler plusieurs fois est sans danger (un seul fetch
 * à la fois grâce au flag `_loaded`).
 */
export async function loadTheme() {
  if (_loaded) return;
  try {
    const r = await fetch('/api/config/theme', { cache: 'no-store' });
    if (r.ok) {
      const data = await r.json();
      if (data && typeof data === 'object') {
        _theme = {
          types: data.types ?? {},
          palette: Array.isArray(data.palette) ? data.palette : [],
          default: data.default ?? BUILTIN_DEFAULT,
        };
        _loaded = true;
        if (typeof document !== 'undefined') document.dispatchEvent(new Event('type-theme-loaded'));
        return;
      }
    }
  } catch (_) {
    // réseau down, CORS, etc. — on reste sur le built-in
  }
  // Fallback explicite : on marque "chargé" pour éviter les retries à
  // chaque import. Le thème built-in reste utilisé.
  _theme = {
    types: BUILTIN_TYPES,
    palette: BUILTIN_PALETTE,
    default: BUILTIN_DEFAULT,
  };
  _loaded = true;
}

/** Renvoie le thème courant (built-in tant que `loadTheme` n'a pas réussi). */
export function getTheme() {
  if (_theme) return _theme;
  return {
    types: BUILTIN_TYPES,
    palette: BUILTIN_PALETTE,
    default: BUILTIN_DEFAULT,
  };
}

/** Pour debug / tests : true une fois le load tenté (succès ou fallback). */
export function isThemeLoaded() {
  return _loaded;
}

/** Hash stable pour distribuer la palette cycliquement. */
export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
