// lib/type-style.js — Couleurs des types sans attribut `style`.
//
// La CSP n'autorise pas les styles inline (`style-src 'self'`). Chaque type
// reçoit donc une classe (`tc-0`, `tc-1`…) définie dans une feuille de
// styles construite en JS, qui pose --type-bg, --type-text et
// --type-border. Les éléments combinent cette classe avec une classe
// d'usage (.type-fill, .type-dot, .type-text, voir components.css).
//
// La feuille est réécrite quand les couleurs configurées arrivent
// (événement `type-theme-loaded`), sans re-rendu du DOM.

import { cfg } from '../models/types.js';

const classes = new Map(); // type → nom de classe
let sheet = null;

// Valeurs acceptées : couleurs CSS et light-dark(), rien qui puisse fermer
// la règle ou en ouvrir une autre (le thème vient de la configuration).
const SAFE_VALUE = /^[#\w\s(),.%-]+$/;

function rule(type, cls) {
  const c = cfg(type);
  const decls = [['--type-bg', c.bg], ['--type-text', c.text], ['--type-border', c.border]]
    .filter(([, v]) => typeof v === 'string' && SAFE_VALUE.test(v))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return `.${cls} { ${decls} }`;
}

function ensureSheet() {
  if (sheet || typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined') return sheet;
  sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return sheet;
}

/** Classe CSS portant les couleurs du type (créée au premier usage). */
export function typeClass(type) {
  const key = String(type || '');
  let cls = classes.get(key);
  if (!cls) {
    cls = `tc-${classes.size}`;
    classes.set(key, cls);
    ensureSheet()?.insertRule(rule(key, cls), sheet.cssRules.length);
  }
  return cls;
}

/** Recalcule toutes les règles (couleurs de la configuration chargées). */
export function refreshTypeClasses() {
  if (!ensureSheet()) return;
  sheet.replaceSync([...classes].map(([type, cls]) => rule(type, cls)).join('\n'));
}

if (typeof document !== 'undefined') {
  document.addEventListener('type-theme-loaded', refreshTypeClasses);
}
