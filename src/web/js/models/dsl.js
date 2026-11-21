// models/dsl.js — Ré-export du package officiel OpenFGA.
//
// Tout le parsing DSL est désormais délégué à `@openfga/syntax-transformer`
// (https://github.com/openfga/language), qui implémente la grammaire
// ANTLR officielle. On bénéficie ainsi de :
//
//   - la couverture complète du DSL (conditions CEL, or/and/but not,
//     tuple-to-userset, userset rewrite, wildcards) ;
//   - la compatibilité ascendante avec les évolutions futures ;
//   - une seule implémentation à maintenir — au lieu de deux
//     parsers dupliqués (frontend ↔ backend).
//
// Ce module expose une couche de compatibilité pour les vues qui
// consommaient l'ancien format (AST avec `kind: 'this' / 'union' /
// 'intersection' / 'difference' / 'computed' / 'tupleToUserset'`).
// Le mapping est minimal car les vues ont été conçues pour consommer
// directement le JSON OpenFGA depuis le backend.

import syntaxTransformer from '@openfga/syntax-transformer';
const { transformer } = syntaxTransformer;

/**
 * Parse un texte DSL OpenFGA. Retourne un AST normalisé :
 *   { types, conditions, errors, schemaVersion, modelFound }
 *
 * Format supporté : texte DSL classique OU JSON OpenFGA
 * (`{schema_version, type_definitions, conditions}`). On détecte le
 * format par le premier caractère non-blanc : `{` = JSON, sinon DSL.
 */
export function parseDSL(text) {
  if (!text || !text.trim()) {
    return normalizeModel({
      schema_version: '1.1',
      type_definitions: [],
      errors: [],
    });
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    return parseJSONModel(text);
  }
  try {
    const { errorListener } = transformer.parseDSL(text);
    const model = transformer.transformDSLToJSONObject(text);
    const errors = (errorListener.errors || []).map(e => ({
      line: e.line,
      message: e.message,
    }));
    return normalizeModel({ ...model, errors });
  } catch (e) {
    return normalizeModel({
      schema_version: '1.1',
      type_definitions: [],
      errors: [{ message: e?.message || String(e) }],
    });
  }
}

/**
 * Parse un JSON OpenFGA standard en AST interne (compat layer).
 *
 * Pourquoi cette indirection : le frontend a été conçu avec un AST
 * historique (`{ type, relations: [{ name, expression, directTypes,
 * allowed }] }`). Le backend renvoie désormais le format OpenFGA
 * brut. Ce wrapper convertit à la volée pour ne pas avoir à refactorer
 * toutes les vues (cards, modal, dsl-editor…).
 */
export function parseJSONModel(text) {
  if (!text) return { schemaVersion: '1.1', types: [], conditions: [], errors: [], modelFound: false };
  try {
    const data = JSON.parse(text);
    return jsonModelToLegacy(data);
  } catch (e) {
    return {
      schemaVersion: '1.1',
      types: [],
      conditions: [],
      errors: [{ line: 0, message: 'JSON invalide : ' + e.message }],
      modelFound: false,
    };
  }
}

/**
 * Convertit un JSON OpenFGA standard (AuthorizationModel) en AST
 * interne avec `expression`, `directTypes`, `allowed`, etc.
 *
 * C'est la couche d'adaptation entre le format renvoyé par OpenFGA
 * (`type_definitions[].relations[].this|union|...`, `metadata.relations`)
 * et la forme attendue par les vues du frontend. Pour qu'une vue
 * migre vers le format brut, il faut remplacer son accès à
 * `r.expression`/`r.directTypes` par un accès direct aux rewrites
 * de `r.relations`.
 */
function jsonModelToLegacy(data) {
  const errors = [];
  const types = [];
  for (const t of data.type_definitions || []) {
    const relations = [];
    const metaRels = (t.metadata && t.metadata.relations) || {};
    for (const [relName, relBody] of Object.entries(t.relations || {})) {
      // OpenFGA renvoie `this: {}` : les types directs sont dans
      // metadata.relations[rel], y compris quand `this` est imbriqué dans
      // une union (`define editor: [user] or owner`).
      const meta = metaRels[relName];
      const direct = meta && Array.isArray(meta.directly_related_user_types)
        ? meta.directly_related_user_types.map(jsonToDirectType)
        : [];
      let expr;
      try {
        expr = rewriteToExpression(relBody, direct);
      } catch (e) {
        errors.push({ line: 0, message: `${t.type}.${relName}: ${e.message}` });
        continue;
      }
      const directTypes = collectDirectTypes(expr);
      relations.push({
        name: relName,
        expression: expr,
        directTypes,
        allowed: expressionToAllowedList(expr),
      });
    }
    types.push({ name: t.type, relations });
  }
  const conditions = [];
  if (data.conditions && typeof data.conditions === 'object') {
    for (const [name, body] of Object.entries(data.conditions)) {
      const parameters = [];
      for (const [pname, pbody] of Object.entries(body.parameters || {})) {
        parameters.push({
          name: pname,
          type: typeNameToShort(pbody.type_name || pbody.type || 'string'),
        });
      }
      conditions.push({ name, parameters, expression: body.expression || '' });
    }
  }
  return {
    schemaVersion: data.schema_version || '1.1',
    types,
    conditions,
    errors,
    modelFound: true,
  };
}

/**
 * Convertit un nœud de relation JSON (`{ this: {} }`, `{ union: ... }`,
 * `{ intersection: ... }`, etc.) en AST d'expression interne
 * (`{ kind: 'this'|'union'|'intersection'|'difference'|'computed'|'tupleToUserset', ... }`).
 * Helper interne — non exporté (les vues n'en ont pas besoin).
 */
function rewriteToExpression(node, direct = []) {
  if (!node || typeof node !== 'object') {
    throw new Error('corps de relation invalide');
  }
  const child = n => rewriteToExpression(n, direct);
  const keys = Object.keys(node);
  if (keys.length === 0) return { kind: 'this', types: [] };
  if (node.this) {
    const types = [];
    if (Array.isArray(node.this.types)) {
      for (const dt of node.this.types) types.push(jsonToDirectType(dt));
    }
    return { kind: 'this', types: types.length ? types : [...direct] };
  }
  if (node.computedUserset) {
    return { kind: 'computed', relation: node.computedUserset.relation };
  }
  if (node.tupleToUserset) {
    return {
      kind: 'tupleToUserset',
      tupleset: node.tupleToUserset.tupleset.relation,
      computed: node.tupleToUserset.computedUserset.relation,
    };
  }
  if (node.union) {
    return { kind: 'union', children: (node.union.child || []).map(child) };
  }
  if (node.intersection) {
    return { kind: 'intersection', children: (node.intersection.child || []).map(child) };
  }
  if (node.difference) {
    return {
      kind: 'difference',
      base: child(node.difference.base),
      subtract: child(node.difference.subtract),
    };
  }
  throw new Error(`clé de relation inconnue: ${keys[0]}`);
}

/**
 * Sérialise un AST interne (legacy) en texte DSL canonique OpenFGA
 * via la lib officielle. Utilisé pour le round-trip parse → serialize
 * qui vérifie qu'un DSL reste équivalent après passage frontend.
 */
export function serializeDSL(parsed) {
  const json = toOpenFGAJSON(parsed);
  try {
    return transformer.transformJSONToDSL(json);
  } catch (e) {
    throw new Error('serializeDSL: ' + (e?.message || e));
  }
}

/**
 * DSL d'un modèle au format OpenFGA brut (réponse de l'API : historique,
 * rollback). Passe par l'AST interne pour hydrater les types directs depuis
 * les métadonnées.
 */
export function rawModelToDSL(model) {
  const parsed = parseJSONModel(JSON.stringify({
    schema_version: model.schema_version || '1.1',
    type_definitions: model.type_definitions || [],
    conditions: model.conditions,
  }));
  if (parsed.errors.length) throw new Error(parsed.errors[0].message);
  return serializeDSL(parsed);
}

/**
 * Round-trip rapide : parse + validation sommaire.
 */
export function checkDSL(text) {
  const parsed = parseDSL(text);
  const errors = parsed.errors || [];
  return { ok: errors.length === 0, parsed, errors };
}

/**
 * Valide un AST. Couvre les références croisées (types, relations,
 * conditions) qui ne sont pas vérifiées par le parser ANTLR seul.
 */
export function validateDSL(parsed) {
  if (!parsed) return ['AST nul'];
  const errors = [];
  if (!parsed.types || !parsed.types.length) errors.push('Aucun type défini.');
  const typeNames = new Set((parsed.types || []).map(t => t.name));
  const condNames = new Set((parsed.conditions || []).map(c => c.name));
  const seenTypes = new Set();
  for (const t of parsed.types || []) {
    if (!t.name) { errors.push('Type sans nom détecté.'); continue; }
    if (seenTypes.has(t.name)) errors.push(`Type "${t.name}" dupliqué.`);
    seenTypes.add(t.name);
    for (const r of t.relations || []) {
      if (!r.name) {
        errors.push(`Relation sans nom dans le type "${t.name}".`);
        continue;
      }
      const refErrs = validateExpressionRefs(r.expression, t, condNames);
      for (const e of refErrs) errors.push(`"${t.name}.${r.name}": ${e}`);
    }
  }
  return errors;
}

function validateExpressionRefs(expr, typeDef, condNames) {
  if (!expr) return [];
  switch (expr.kind) {
    case 'this': {
      const errs = [];
      for (const dt of expr.types || []) {
        if (dt.condition && !condNames.has(dt.condition)) {
          errs.push(`condition "${dt.condition}" non définie`);
        }
      }
      return errs;
    }
    case 'computed': {
      if (!typeDef.relations.find(r => r.name === expr.relation)) {
        return [`relation "${expr.relation}" non définie sur "${typeDef.name}"`];
      }
      return [];
    }
    case 'tupleToUserset': {
      const errs = [];
      if (!typeDef.relations.find(r => r.name === expr.tupleset)) {
        errs.push(`relation "${expr.tupleset}" (tupleset) non définie sur "${typeDef.name}"`);
      }
      return errs;
    }
    case 'union':
    case 'intersection':
      return (expr.children || []).flatMap(c => validateExpressionRefs(c, typeDef, condNames));
    case 'difference':
      return [
        ...validateExpressionRefs(expr.base, typeDef, condNames),
        ...validateExpressionRefs(expr.subtract, typeDef, condNames),
      ];
    default:
      return [`expression invalide: kind="${expr.kind}"`];
  }
}

/**
 * Convertit un AST interne en JSON OpenFGA officiel (le format
 * POSTé par le frontend vers `POST /api/dsl/apply`). Effectue aussi
 * le round-trip metadata (directTypes depuis `directTypes`/`metadata`).
 */
export function toOpenFGAJSON(parsed) {
  const out = {
    schema_version: parsed.schemaVersion || parsed.schema_version || '1.1',
    type_definitions: [],
  };
  for (const t of parsed.types || []) {
    const entry = { type: t.name };
    const rels = {};
    const meta = {};
    for (const r of t.relations || []) {
      rels[r.name] = expressionToRewrite(r.expression);
      meta[r.name] = {
        directly_related_user_types: directTypesForMetadata(r.expression),
      };
    }
    if (Object.keys(rels).length) {
      entry.relations = rels;
      entry.metadata = { relations: meta };
    }
    out.type_definitions.push(entry);
  }
  if (parsed.conditions && parsed.conditions.length) {
    out.conditions = {};
    for (const c of parsed.conditions) {
      const params = {};
      for (const p of c.parameters || []) params[p.name] = { type_name: typeToTypeName(p.type) };
      out.conditions[c.name] = {
        name: c.name,
        expression: c.expression,
        parameters: params,
      };
    }
  }
  return out;
}

/**
 * Convertit un AST en { nodes, edges } pour le graphe SVG/Cytoscape.
 *
 * Stratégie : pour les relations `this` simples (cas courant), on
 * émet directement des arêtes (source_type → target_type) ; pour les
 * relations complexes (or/and/but not/from/computed), on insère un
 * nœud endpoint par relation et on développe les sous-arêtes.
 */
// dslToGraph : transforme un modèle DSL (AST legacy) en graphe
// de nœuds + arêtes pour la prévisualisation visuelle de l'Admin DSL.
//
// Design du graphe : on évite les nœuds virtuels intermédiaires
// (op:rel, op:union, op:from, etc.) qui pollueraient le rendu.
// L'intelligence (nom de relation + expression) est portée
// directement par les edges entre les types. Un seul edge par
// relation, dont le label résume l'expression complète (`X: a or b`,
// `X: viewer from parent`, `X: #self_relation`, etc.).
//
// Cas particuliers :
//   - Direct `this` : edge type→type (label = nom de la relation)
//   - Computed userset (boucle) : edge type→type (label = "X: #target")
//   - Union/Intersection : un seul edge par relation, label =
//     "X: a or b or c" / "X: a and b"
//   - TupleToUserset : edge type→type (label = "X: A from B")
//   - Conditions : nœuds à part (entité réelle, indépendants des types)
//     + edge dashed type→condition (label = "with X")
export function dslToGraph(parsed) {
  const nodes = [];
  const edges = [];
  for (const t of parsed.types || []) {
    nodes.push({
      id: t.name,
      label: t.name,
      type: t.name,
      relations: t.relations || [],
      kind: 'type',
    });
  }
  for (const c of parsed.conditions || []) {
    nodes.push({
      id: `condition:${c.name}`,
      label: `condition: ${c.name}`,
      type: 'condition',
      kind: 'condition',
      condition: c,
    });
  }

  // Index des conditions par type pour les edges "with X".
  for (const t of parsed.types || []) {
    const seenCondEdges = new Set();
    for (const r of t.relations || []) {
      const expr = r.expression || { kind: 'this', types: [] };

      // 1) Edges vers les conditions (collecte via l'expression).
      collectConditionRefs(expr).forEach(condName => {
        const condNode = `condition:${condName}`;
        const key = `${t.name}|${condNode}|cond`;
        if (seenCondEdges.has(key)) return;
        seenCondEdges.add(key);
        edges.push({
          id: `${t.name}__cond__${condName}`,
          source: t.name,
          target: condNode,
          label: `with ${condName}`,
          type: 'condition',
          style: 'dashed',
          relations: [r.name],
        });
      });

      // 2) Calcule le label complet de l'expression.
      const exprText = expressionToText(expr);
      // 3) Calcule le(s) target(s) : type cible(s) principaux.
      //    Pour les computeds (X → Y du même type), on pointe vers
      //    le type lui-même. Pour `this: [user]`, on pointe vers
      //    `user`. Pour les unions, on prend le 1er child significatif.
      const target = pickPrimaryTarget(t.name, expr);
      if (!target) continue;

      // 4) Edge principal type→target avec label "X: <expression>".
      const edgeId = `${t.name}.${r.name}->${target}`;
      edges.push({
        id: edgeId,
        source: t.name,
        target,
        label: `${r.name}: ${exprText}`,
        type: edgeTypeOf(expr),
        style: edgeStyleOf(expr),
        relations: [r.name],
      });
    }
  }
  return { nodes, edges };
}

/** Récupère tous les noms de conditions référencés dans l'expression. */
function collectConditionRefs(expr) {
  const out = [];
  function walk(e) {
    if (!e) return;
    if (e.types) {
      for (const dt of e.types) if (dt.condition) out.push(dt.condition);
    }
    if (e.children) for (const c of e.children) walk(c);
    if (e.base) walk(e.base);
    if (e.subtract) walk(e.subtract);
  }
  walk(expr);
  return out;
}

/** Convertit une expression en texte lisible. */
function expressionToText(expr) {
  if (!expr) return '?';
  switch (expr.kind) {
    case 'this': {
      const parts = (expr.types || []).map(dt => {
        if (dt.wildcard) return `${dt.type}:*`;
        if (dt.relation) return `#${dt.relation}`;
        return dt.type;
      });
      return parts.length ? parts.join(', ') : '∅';
    }
    case 'computed':
      return `#${expr.relation}`;
    case 'union':
    case 'intersection':
      return (expr.children || [])
        .map(c => expressionToText(c))
        .join(expr.kind === 'union' ? ' or ' : ' and ');
    case 'tupleToUserset':
      return `${expr.computed} from ${expr.tupleset}`;
    case 'difference':
      return `${expressionToText(expr.base)} but not ${expressionToText(expr.subtract)}`;
    default:
      return '?';
  }
}

/**
 * Choisit la "cible primaire" de l'expression : la 1ère référence
 * de type qui sort de l'expression. Pour `this: [user]` c'est
 * `user`. Pour un computed userset (même type) c'est le type
 * courant. Pour union, on prend le 1er child non-vide.
 */
function pickPrimaryTarget(typeName, expr) {
  if (!expr) return null;
  switch (expr.kind) {
    case 'this': {
      for (const dt of expr.types || []) {
        if (dt.type) return dt.type;
      }
      return null;
    }
    case 'computed':
      // Computed userset : référence une relation du même type.
      return typeName;
    case 'union':
    case 'intersection': {
      for (const c of expr.children || []) {
        const t = pickPrimaryTarget(typeName, c);
        if (t) return t;
      }
      return null;
    }
    case 'tupleToUserset':
      return typeName; // pointe vers le même type (object=typeName)
    case 'difference': {
      const t = pickPrimaryTarget(typeName, expr.base);
      if (t) return t;
      return pickPrimaryTarget(typeName, expr.subtract);
    }
    default:
      return null;
  }
}

function edgeTypeOf(expr) {
  if (!expr) return 'direct';
  if (expr.kind === 'computed' || expr.kind === 'tupleToUserset') return 'computed';
  if (expr.kind === 'union' || expr.kind === 'intersection') return 'composite';
  if (expr.kind === 'difference') return 'composite';
  return 'direct';
}

function edgeStyleOf(expr) {
  if (!expr) return 'solid';
  // Les Computed usersets et TupleToUsersets sont des indirections —
  // on les représente en pointillé pour les distinguer des assignations
  // directes.
  if (expr.kind === 'computed' || expr.kind === 'tupleToUserset') return 'dashed';
  return 'solid';
}

// ── Helpers internes ──────────────────────────────────────────────────────

function expressionToRewrite(expr) {
  if (!expr) return { this: {} };
  switch (expr.kind) {
    case 'this': {
      const types = (expr.types || []).map(dt => {
        const u = {};
        if (dt.wildcard) { u.type = dt.type; u.wildcard = {}; }
        else if (dt.relation) { u.type = dt.type; u.relation = dt.relation; }
        else { u.type = dt.type; }
        if (dt.condition) u.condition = dt.condition;
        return u;
      });
      if (types.some(t => t.condition || t.wildcard || t.relation)) {
        return { this: { types } };
      }
      return { this: {} };
    }
    case 'computed':
      return { computedUserset: { object: '', relation: expr.relation } };
    case 'tupleToUserset':
      return {
        tupleToUserset: {
          tupleset: { object: '', relation: expr.tupleset },
          computedUserset: { object: '', relation: expr.computed },
        },
      };
    case 'union':
      return { union: { child: expr.children.map(expressionToRewrite) } };
    case 'intersection':
      return { intersection: { child: expr.children.map(expressionToRewrite) } };
    case 'difference':
      return {
        difference: {
          base: expressionToRewrite(expr.base),
          subtract: expressionToRewrite(expr.subtract),
        },
      };
    default:
      throw new Error(`kind d'expression inconnu: ${expr.kind}`);
  }
}

function directTypesForMetadata(expr) {
  const out = [];
  walk(expr);
  return out;
  function walk(e) {
    if (!e) return;
    if (e.kind === 'this') {
      for (const dt of e.types || []) {
        const u = {};
        if (dt.wildcard) { u.type = dt.type; u.wildcard = {}; }
        else if (dt.relation) { u.type = dt.type; u.relation = dt.relation; }
        else { u.type = dt.type; }
        if (dt.condition) u.condition = dt.condition;
        out.push(u);
      }
    } else if (e.kind === 'union' || e.kind === 'intersection') {
      for (const c of e.children || []) walk(c);
    } else if (e.kind === 'difference') {
      walk(e.base);
    }
  }
}

function typeToTypeName(type) {
  const m = type.match(/^(?:TYPE_NAME_)?(\w+)$/);
  if (!m) return 'TYPE_NAME_STRING';
  return `TYPE_NAME_${m[1].toUpperCase()}`;
}

function typeNameToShort(type) {
  if (!type) return 'string';
  const m = type.match(/^TYPE_NAME_(.+)$/);
  if (!m) return type;
  return m[1].toLowerCase();
}

function jsonToDirectType(u) {
  const dt = { type: u.type || '' };
  if (u.relation) dt.relation = u.relation;
  if (u.wildcard) dt.wildcard = true;
  if (u.condition) dt.condition = u.condition;
  return dt;
}

/**
 * Normalise un AuthorizationModel vers un format interne unique
 * `{ types, conditions, errors, schemaVersion }`. Toutes les vues
 * (cards, modal, dsl-editor…) consomment ce format, indépendamment
 * de la source (réponse OpenFGA brute ou JSON DSL round-trip).
 *
 * Chaque `this: {}` vide (à la racine ou imbriqué dans une union) est
 * hydraté depuis `metadata.relations[rel].directly_related_user_types`
 * — c'est le cas typique d'OpenFGA quand la relation a des types sous
 * condition ou quand le serveur omet `this.types` pour économiser du
 * payload.
 */
function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const types = (model.type_definitions || model.types || []).map(t => {
    if (!t) return null;
    const rels = t.relations || {};
    const metaRels = (t.metadata && t.metadata.relations) || {};
    const relations = Object.entries(rels).map(([name, body]) => {
      const meta = metaRels[name];
      const direct = meta && Array.isArray(meta.directly_related_user_types)
        ? meta.directly_related_user_types.map(jsonToDirectType)
        : [];
      const expr = rewriteToExpression(body || {}, direct);
      const directTypes = collectDirectTypes(expr);
      return {
        name,
        expression: expr,
        directTypes,
        allowed: expressionToAllowedList(expr),
      };
    });
    return { name: t.type || t.name, relations };
  }).filter(Boolean);
  const conditionsRaw = model.conditions;
  const conditions = [];
  if (Array.isArray(conditionsRaw)) {
    conditions.push(...conditionsRaw);
  } else if (conditionsRaw && typeof conditionsRaw === 'object') {
    for (const [name, body] of Object.entries(conditionsRaw)) {
      const b = body || {};
      const parameters = [];
      for (const [pname, pbody] of Object.entries(b.parameters || {})) {
        const pbodyObj = pbody || {};
        parameters.push({
          name: pname,
          type: typeNameToShort(pbodyObj.type_name || pbodyObj.type || 'string'),
        });
      }
      conditions.push({
        name,
        parameters,
        expression: b.expression || '',
      });
    }
  }
  return {
    schemaVersion: model.schema_version || model.schemaVersion || '1.1',
    types,
    conditions,
    errors: model.errors || [],
    modelFound: !!model.schema_version || !!model.schemaVersion,
  };
}

function collectDirectTypes(expr) {
  const out = [];
  (function walk(e) {
    if (!e) return;
    if (e.kind === 'this') for (const dt of e.types || []) out.push({ ...dt });
    else if (e.kind === 'union' || e.kind === 'intersection') for (const c of e.children || []) walk(c);
    else if (e.kind === 'difference') walk(e.base);
  })(expr);
  const seen = new Set();
  return out.filter(dt => {
    const k = `${dt.type}|${dt.relation || ''}|${dt.wildcard ? '*' : ''}|${dt.condition || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Convertit une expression en liste plate de sujets autorisés. Sert au
 * panneau latéral du graphe DSL (`dsl-side-def-allowed`). Helper
 * interne — non exporté.
 */
function expressionToAllowedList(expr) {
  if (!expr) return [];
  const out = [];
  (function walk(e) {
    if (!e) return;
    if (e.kind === 'this') {
      for (const dt of e.types || []) {
        let s;
        if (dt.wildcard) s = `${dt.type}:*`;
        else if (dt.relation) s = `${dt.type}#${dt.relation}`;
        else s = dt.type;
        if (dt.condition) s += ` with ${dt.condition}`;
        out.push(s);
      }
    } else if (e.kind === 'union' || e.kind === 'intersection') {
      for (const c of e.children || []) walk(c);
    } else if (e.kind === 'difference') {
      walk(e.base);
    }
  })(expr);
  return out;
}