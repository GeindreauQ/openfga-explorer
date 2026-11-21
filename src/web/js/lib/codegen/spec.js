// lib/codegen/spec.js — Description du modèle commune aux générateurs.
//
// buildSpec() normalise le modèle (normalizeTypes), attribue à chaque type
// et relation des identifiants sûrs dans chaque langage, et choisit des
// exemples cohérents avec le modèle : un tuple qu'on peut réellement écrire
// (relation directement assignable, type de sujet autorisé) et un Check sur
// une permission du même type d'objet.

import { normalizeTypes, subjectLabel, relationSummaryFor } from './normalize.js';

/**
 * @param {object} model   modèle OpenFGA (type_definitions) ou AST interne
 * @param {object} [ctx]   { storeId, storeName, modelId, apiUrl }
 */
export function buildSpec(model, ctx = {}) {
  const types = normalizeTypes(model).map(t => ({
    name: t.type,
    relations: t.relations.map(r => ({
      name: r.name,
      assignable: r.canDirectlyAssign,
      subjects: (r.directTypes || []).map(subjectLabel),
      directTypes: r.directTypes || [],
      summary: relationSummaryFor(r),
    })),
  }));
  return {
    types,
    storeId: ctx.storeId || '',
    storeName: ctx.storeName || '',
    modelId: ctx.modelId || '',
    apiUrl: ctx.apiUrl || 'http://localhost:8080',
    example: pickExample(types),
  };
}

// Exemple : on écrit (user, assignable, objet) puis on vérifie une
// permission du même type d'objet — de préférence une relation calculée
// (can_*, viewer…), sinon la relation écrite elle-même. Les types qui
// portent des permissions can_* passent en premier.
function pickExample(types) {
  const permissions = t => t.relations.some(r => !r.assignable && r.name.startsWith('can_'));
  const ordered = [...types.filter(permissions), ...types.filter(t => !permissions(t))];
  for (const t of ordered) {
    for (const r of t.relations) {
      if (!r.assignable) continue;
      const subject = r.directTypes.find(dt => !dt.wildcard && !dt.relation);
      if (!subject) continue;
      const computed = t.relations.filter(x => !x.assignable);
      const check = computed.find(x => x.name.startsWith('can_')) || computed[0] || r;
      return {
        user: `${subject.type}:alice`,
        userType: subject.type,
        writeRelation: r.name,
        checkRelation: check.name,
        type: t.name,
        object: `${t.name}:demo`,
      };
    }
  }
  return null;
}

// ── Identifiants ────────────────────────────────────────────────────────

/** Découpe un nom OpenFGA ("can_read", "org-unit", "doc.v2") en mots. */
export function words(name) {
  return String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
}

export function pascal(name) {
  const ident = words(name).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[0-9]/.test(ident) ? `T${ident}` : (ident || 'T');
}

export function upperSnake(name) {
  const ident = words(name).join('_').toUpperCase();
  return /^[0-9]/.test(ident) ? `_${ident}` : (ident || '_');
}

/**
 * Rend uniques des identifiants dérivés de noms distincts (can-read et
 * can_read donnent le même identifiant) en suffixant les doublons.
 */
export function uniqueIdents(names, toIdent, reserved = new Set()) {
  const used = new Set();
  const out = new Map();
  for (const name of names) {
    let ident = toIdent(name);
    if (reserved.has(ident)) ident += '_';
    let candidate = ident;
    for (let i = 2; used.has(candidate); i++) candidate = `${ident}${i}`;
    used.add(candidate);
    out.set(name, candidate);
  }
  return out;
}

/** Littéral de chaîne JSON (valide en TS, Go et Python). */
export function str(value) {
  return JSON.stringify(String(value));
}

/** En-tête commun : source, store et modèle. */
export function headerLines(spec, comment, sdk) {
  const store = spec.storeName
    ? `${spec.storeName}${spec.storeId ? ` (${spec.storeId})` : ''}`
    : (spec.storeId || 'non sélectionné');
  return [
    `${comment} Généré par OpenFGA Explorer à partir du modèle du store ${store}.`,
    `${comment} Modèle : ${spec.modelId || 'dernier en date'}. SDK : ${sdk}.`,
    `${comment} Configuration : FGA_API_URL, FGA_STORE_ID, FGA_MODEL_ID, FGA_API_TOKEN (optionnel).`,
  ];
}
