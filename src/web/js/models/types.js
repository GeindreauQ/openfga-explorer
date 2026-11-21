// Configuration visuelle des types (icône, couleurs) + résolution
// dynamique du modèle d'autorisation actif.
//
// Le modèle d'autorisation **vit dans le store OpenFGA** : on ne stocke
// ici aucun DSL hardcodé. Au boot, `GET /api/dsl` (qui appelle
// `GET /stores/{id}/authorization_models` côté serveur) renvoie le JSON
// OpenFGA brut ; `parseJSONModel` le convertit en AST interne puis
// `setActiveStoreModel(parsed)` peuple `_syncModel`. Avant le 1er mount,
// on sert un fallback **vide** plutôt qu'un modèle arbitraire : on
// ne doit pas voir de types inventés.
//
// Couleurs / icônes par type : chargés depuis `GET /api/config/theme`
// au boot (voir `lib/theme.js`). Si la route est inaccessible, le
// built-in du module theme sert de repli — l'UI ne casse pas en mode
// dev offline.

import { getTheme, hashStr } from '../lib/theme.js';
import { isDark } from '../lib/color-scheme.js';

/** Couleurs du thème (claires), telles que configurées côté serveur. */
export function rawCfg(type) {
  const theme = getTheme();
  if (theme.types[type]) return theme.types[type];
  // Hash → palette pour garantir un rendu stable et distinct par type.
  return theme.palette[hashStr(type || '') % theme.palette.length] || theme.default;
}

/**
 * Configuration visuelle d'un type pour le DOM : chaque couleur est un
 * `light-dark(clair, sombre)`, qui suit le thème sans re-rendu. Les
 * variantes sombres sont dérivées de la couleur de bordure du type.
 */
export function cfg(type) {
  const c = rawCfg(type);
  const d = darkVariant(c);
  return {
    ...c,
    bg: `light-dark(${c.bg}, ${d.bg})`,
    text: `light-dark(${c.text}, ${d.text})`,
    border: `light-dark(${c.border}, ${d.border})`,
  };
}

/** Couleurs résolues pour le thème courant (Cytoscape, canvas). */
export function canvasCfg(type) {
  const c = rawCfg(type);
  return isDark() ? { ...c, ...darkVariant(c) } : c;
}

const DARK_SURFACE = '#1d1d21';
function darkVariant(c) {
  return {
    bg: mixHex(c.border, DARK_SURFACE, 0.24),
    text: mixHex(c.border, '#ffffff', 0.55),
    border: mixHex(c.border, DARK_SURFACE, 0.8),
  };
}

/** Mélange deux couleurs hexadécimales : `t` = part de `a`. */
export function mixHex(a, b, t) {
  const rgb = h => {
    let x = String(h).replace('#', '');
    if (x.length === 3) x = [...x].map(ch => ch + ch).join('');
    return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16) || 0);
  };
  const [ra, ga, ba] = rgb(a);
  const [rb, gb, bb] = rgb(b);
  const ch = (x, y) => Math.round(x * t + y * (1 - t)).toString(16).padStart(2, '0');
  return `#${ch(ra, rb)}${ch(ga, gb)}${ch(ba, bb)}`;
}

/** Libellé lisible pour un type : nom tel quel. */
export function typeLabel(type) {
  return type || '?';
}

// ── Résolution dynamique à partir de l'AST du store actif ─────────────────────
//
// Le modèle d'autorisation **vit dans le store OpenFGA**, pas dans ce
// fichier. `loadDSL()` (dans main.js) récupère le JSON du store via
// `GET /api/dsl` (qui introspecte le serveur OpenFGA), le parse, puis
// appelle `setActiveStoreModel(parsed)` qui peuple `_syncModel`. Les
// vues (modale add-tuple, cards, etc.) lisent ce cache via
// `getResolvedStoreModel()`.

let _syncModel = null; // { types:Set, relations:Map<type, Map<rel, Set<spec>>> }

/** Injecte le modèle actif. Appelé par loadDSL() après chaque switch de store. */
export function setActiveStoreModel(parsed) {
  if (!parsed || !Array.isArray(parsed.types)) {
    _syncModel = null;
    return;
  }
  const types = new Set();
  const relations = new Map();
  for (const t of parsed.types) {
    if (!t.name) continue;
    types.add(t.name);
    const rels = new Map();
    for (const r of t.relations || []) {
      if (!r.name) continue;
      const specs = new Set();
      for (const dt of r.directTypes || []) {
        let spec = dt.type || '';
        if (dt.wildcard) spec += ':*';
        else if (dt.relation) spec += `#${dt.relation}`;
        if (dt.condition) spec += `:with(${dt.condition})`;
        if (spec) specs.add(spec);
      }
      rels.set(r.name, specs);
    }
    relations.set(t.name, rels);
  }
  _syncModel = { types, relations };
}

/** Getter sync pour les vues. */
export function getResolvedStoreModel() {
  if (_syncModel) return _syncModel;
  // Pas encore chargé : on retourne un modèle vide. Les vues afficheront
  // un état "aucun modèle" plutôt que d'inventer des types.
  return { types: new Set(), relations: new Map() };
}

/** Liste des types qui ont au moins une relation directe (utilisables comme objet). */
export function objectTypes() {
  const res = getResolvedStoreModel();
  const out = [];
  for (const t of res.types) {
    const rels = res.relations.get(t);
    if (rels && rels.size > 0) out.push(t);
  }
  return out;
}

/** Relations directement assignables pour un type d'objet. */
export function directRelations(objType) {
  const res = getResolvedStoreModel();
  const rels = res.relations.get(objType);
  return rels ? [...rels.keys()] : [];
}

/**
 * Pour (objType, relation), renvoie les types de sujet autorisés et
 * leurs usersets, basé sur le store actif.
 *   { types: [string], usersets: { type: Set(relations) }, wildcard: bool }
 */
export function allowedSubjects(objType, relation) {
  const res = getResolvedStoreModel();
  const rels = res.relations.get(objType);
  if (!rels) return { types: [], usersets: {}, wildcard: false };
  const list = rels.get(relation) || new Set();
  const types = new Set();
  const usersets = {};
  let wildcard = false;
  for (const spec of list) {
    // spec ∈ "user" | "team#member" | "user:*" (la condition est
    // gérée au niveau du tuple write, pas ici).
    const [base, rel] = spec.split('#');
    const [t, star] = base.split(':');
    if (!t) continue;
    types.add(t);
    if (star === '*') wildcard = true;
    if (rel) (usersets[t] = usersets[t] || new Set()).add(rel);
  }
  return { types: [...types], usersets, wildcard };
}

/** Indique si un modèle actif a été chargé depuis le store courant. */
export function activeModelSource() {
  return _syncModel ? 'store' : 'none';
}
