// lib/codegen/normalize.js — Normalisation du modèle pour les générateurs.

// ── Normalisation du modèle ─────────────────────────────────────────────
//
// `normalizeTypes()` accepte 2 formats en entrée (format brut OpenFGA
// `type_definitions[]` ou format interne `types[]`) et enrichit chaque
// relation avec :
//   - `relation.kind` : 'direct' | 'computed' | 'union' | 'intersection'
//                      | 'difference' | 'tupleToUserset' | 'mixed'
//   - `relation.canDirectlyAssign` : true si `write` peut créer un
//                                    tuple sur cette relation
//   - `relation.canCompute` : true si la relation est dérivée
//                             (computed, tupleToUserset, etc.)
export function normalizeTypes(model) {
  let raw = [];
  if (Array.isArray(model.type_definitions)) {
    raw = model.type_definitions;
  } else if (Array.isArray(model.types)) {
    raw = model.types;
  }
  return raw.map(t => {
    const typeName = t.type || t.name;
    const relations = (t.relations && typeof t.relations === 'object' && !Array.isArray(t.relations))
      ? Object.entries(t.relations).map(([name, body]) =>
        enrichRelation(name, legacyExpressionFromBody(body, directlyRelated(t, name))))
      : (t.relations || []).map(r => enrichRelation(r.name, r.expression || r));
    return { type: typeName, relations };
  }).filter(t => t.type);
}

// Dans le format brut d'OpenFGA, `this` est vide : les types de sujets
// directs sont dans metadata.relations[rel].directly_related_user_types.
function directlyRelated(typeDef, relation) {
  const list = typeDef.metadata?.relations?.[relation]?.directly_related_user_types || [];
  return list.map(u => ({
    type: u.type,
    relation: u.relation || undefined,
    wildcard: u.wildcard !== undefined && u.wildcard !== null,
    condition: u.condition || undefined,
  }));
}

// `body` peut être un rewrite OpenFGA brut (`{ this: {...} }`,
// `{ union: {...} }`) ou déjà un AST interne
// (`{ kind, types, children, ... }`). On détecte et on normalise.
// `direct` : types directs de la relation (metadata), portés par `this`.
function legacyExpressionFromBody(body, direct = []) {
  if (!body) return { kind: 'this', types: [] };
  if (body.kind) return body; // déjà interne
  if (typeof body !== 'object') return { kind: 'this', types: [] };
  const child = b => legacyExpressionFromBody(b, direct);
  if (body.this !== undefined) {
    const inline = (body.this && body.this.types || []).map(u => ({
      type: u.type,
      relation: u.relation,
      wildcard: !!u.wildcard,
      condition: u.condition,
    }));
    return { kind: 'this', types: inline.length ? inline : direct };
  }
  if (body.computedUserset) {
    return { kind: 'computed', relation: body.computedUserset.relation };
  }
  if (body.tupleToUserset) {
    return {
      kind: 'tupleToUserset',
      tupleset: body.tupleToUserset.tupleset?.relation,
      computed: body.tupleToUserset.computedUserset?.relation,
    };
  }
  if (body.union) {
    return { kind: 'union', children: (body.union.child || []).map(child) };
  }
  if (body.intersection) {
    return { kind: 'intersection', children: (body.intersection.child || []).map(child) };
  }
  if (body.difference) {
    return {
      kind: 'difference',
      base: child(body.difference.base),
      subtract: child(body.difference.subtract),
    };
  }
  return { kind: 'this', types: [] };
}

function enrichRelation(name, expression) {
  const directTypes = collectAllDirectTypes(expression);
  const kind = classifyRelation(expression, directTypes);
  return {
    name,
    expression,
    directTypes,
    canDirectlyAssign: directTypes.length > 0,
    canCompute: kind !== 'direct' || directTypes.length === 0,
    kind,
  };
}

function classifyRelation(expr, directTypes) {
  if (!expr) return directTypes.length ? 'direct' : 'mixed';
  if (expr.kind === 'this') {
    return directTypes.length ? 'direct' : 'mixed';
  }
  return expr.kind;
}

// Récupère tous les types directs possibles (récursivement) pour une
// expression. Sert aux générateurs pour produire un type union.
function collectAllDirectTypes(expr) {
  const out = [];
  (function walk(e) {
    if (!e) return;
    if (e.kind === 'this') {
      for (const dt of e.types || []) out.push({ ...dt });
    } else if (e.kind === 'union' || e.kind === 'intersection') {
      for (const c of e.children || []) walk(c);
    } else if (e.kind === 'difference') walk(e.base);
  })(expr);
  const seen = new Set();
  return out.filter(dt => {
    const k = `${dt.type}|${dt.relation || ''}|${dt.wildcard ? '*' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function subjectLabel(dt) {
  if (dt.wildcard) return `${dt.type}:*`;
  if (dt.relation) return `${dt.type}#${dt.relation}`;
  return dt.type;
}

// Définition d'une relation dans la syntaxe du DSL :
// "[user, group#member] or admin from project".
export function exprToText(expr, nested = false) {
  if (!expr) return '?';
  const join = (children, op) => {
    const text = (children || []).map(c => exprToText(c, true)).join(` ${op} `);
    return nested ? `(${text})` : text;
  };
  switch (expr.kind) {
    case 'this': {
      const types = (expr.types || []).map(dt => {
        const label = subjectLabel(dt);
        return dt.condition ? `${label} with ${dt.condition}` : label;
      });
      return `[${types.join(', ')}]`;
    }
    case 'computed':
      return expr.relation;
    case 'union':
      return join(expr.children, 'or');
    case 'intersection':
      return join(expr.children, 'and');
    case 'difference':
      return `${exprToText(expr.base, true)} but not ${exprToText(expr.subtract, true)}`;
    case 'tupleToUserset':
      return `${expr.computed} from ${expr.tupleset}`;
    default:
      return '?';
  }
}

export function relationSummaryFor(r) {
  return exprToText(r.expression);
}
