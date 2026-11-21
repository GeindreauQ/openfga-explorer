// lib/access.js — Lecture du modèle et des tuples pour répondre à « qui a
// accès à quoi, et pourquoi ». Fonctions pures, sur le modèle interne
// (`state.storeModel` : { types: [{ name, relations: [{ name, expression,
// directTypes }] }] }) et la liste des tuples ({ user, relation, object }).

/** Définition d'un type, ou null. */
export function typeDef(model, type) {
  return (model?.types || []).find(t => t.name === type) || null;
}

function relationDef(model, type, relation) {
  return (typeDef(model, type)?.relations || []).find(r => r.name === relation) || null;
}

/** Parcourt une expression en visitant les nœuds atteignables par union. */
function walkUnion(expr, visit) {
  if (!expr) return;
  visit(expr);
  if (expr.kind === 'union') for (const c of expr.children || []) walkUnion(c, visit);
  // Une différence accorde au plus ce qu'accorde sa base.
  if (expr.kind === 'difference') walkUnion(expr.base, visit);
}

/**
 * Relations « de rattachement » d'un type : celles qui servent de tupleset
 * (`admin from project` → `project`). Elles relient deux objets et ne sont
 * pas des droits.
 */
export function linkRelations(model, type) {
  const out = new Set();
  for (const r of typeDef(model, type)?.relations || []) {
    (function walk(e) {
      if (!e) return;
      if (e.kind === 'tupleToUserset') out.add(e.tupleset);
      for (const c of e.children || []) walk(c);
      if (e.base) walk(e.base);
      if (e.subtract) walk(e.subtract);
    })(r.expression);
  }
  return out;
}

/** Relations d'un type qui sont des droits (hors rattachements), dans l'ordre du modèle. */
export function accessRelations(model, type) {
  const links = linkRelations(model, type);
  return (typeDef(model, type)?.relations || []).map(r => r.name).filter(n => !links.has(n));
}

/** Relations attribuables directement par un tuple (rôles), hors rattachements. */
export function assignableRelations(model, type) {
  const links = linkRelations(model, type);
  return (typeDef(model, type)?.relations || [])
    .filter(r => (r.directTypes || []).length && !links.has(r.name))
    .map(r => r.name);
}

/** Types d'objets qui portent au moins un droit. */
export function objectTypes(model) {
  return (model?.types || []).filter(t => accessRelations(model, t.name).length).map(t => t.name);
}

/**
 * Sujets possibles d'un type d'objet : [{ type, relation? , wildcard? }],
 * dédupliqués, tirés des types directs de ses rôles.
 */
export function subjectFilters(model, type) {
  const seen = new Map();
  const links = linkRelations(model, type);
  for (const r of typeDef(model, type)?.relations || []) {
    if (links.has(r.name)) continue;
    for (const d of r.directTypes || []) {
      if (d.wildcard) continue;
      const key = d.relation ? `${d.type}#${d.relation}` : d.type;
      if (!seen.has(key)) seen.set(key, d.relation ? { type: d.type, relation: d.relation } : { type: d.type });
    }
  }
  return [...seen.values()];
}

/**
 * Relations du même objet accordées par `relation` (elle comprise) :
 * `editor` accorde `viewer`, `can_read`, `can_write`… dans le modèle
 * Kubernetes. Suit les `computed` atteignables par union.
 */
export function impliedRelations(model, type, relation) {
  const rels = typeDef(model, type)?.relations || [];
  const granted = new Set([relation]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rels) {
      if (granted.has(r.name)) continue;
      let hit = false;
      walkUnion(r.expression, e => { if (e.kind === 'computed' && granted.has(e.relation)) hit = true; });
      if (hit) { granted.add(r.name); changed = true; }
    }
  }
  return granted;
}

/** Relations du même objet qui accordent `relation` (elle comprise). */
export function grantingRelations(model, type, relation) {
  const out = new Set();
  for (const r of typeDef(model, type)?.relations || []) {
    if (impliedRelations(model, type, r.name).has(relation)) out.add(r.name);
  }
  return out;
}

/** "namespace:billing" → ["namespace", "billing"]. */
export function splitObject(object) {
  const i = object.indexOf(':');
  return i < 0 ? [object, ''] : [object.slice(0, i), object.slice(i + 1)];
}

/**
 * Sujets équivalents à `subject` : lui-même, `type:*`, et les usersets dont
 * il est membre par un tuple stocké ou contextuel (`group:x#member`).
 */
export function subjectsOf(subject, tuples) {
  return new Set(membershipsOf(subject, tuples).keys());
}

/** Sujet équivalent → tuple d'appartenance qui le justifie (null pour lui-même et le joker). */
function membershipsOf(subject, tuples) {
  const out = new Map([[subject, null]]);
  const [type] = splitObject(subject);
  if (!subject.includes('#')) out.set(`${type}:*`, null);
  for (const t of tuples) {
    if (t.user === subject && !t.object.includes('#')) out.set(`${t.object}#${t.relation}`, t);
  }
  return out;
}

/**
 * Explique pourquoi `subject` a `relation` sur `object`. Renvoie des chemins
 * (le plus court d'abord) ; chaque chemin est une liste d'étapes
 * { tuple, via, membership } : `tuple` est le tuple qui donne le droit,
 * `via` les rattachements traversés (project:billing → namespace:billing),
 * `membership` le tuple d'appartenance au groupe concerné, s'il y en a un.
 *
 * `tuples` peut inclure des tuples contextuels (groupes). Limité à quelques
 * niveaux de rattachement : suffisant pour namespace → projet → cluster.
 */
export function explainAccess({ model, tuples, subject, object, relation, maxDepth = 4 }) {
  const memberships = membershipsOf(subject, tuples);
  const subjects = new Set(memberships.keys());
  const paths = [];
  const seen = new Set();

  (function explain(obj, rel, via, depth) {
    const key = `${obj}#${rel}`;
    if (depth > maxDepth || seen.has(key)) return;
    seen.add(key);
    const [type] = splitObject(obj);
    const granting = grantingRelations(model, type, rel);
    // 1. Tuple direct sur cet objet, pour une relation qui accorde `rel`.
    for (const t of tuples) {
      if (t.object === obj && granting.has(t.relation) && subjects.has(t.user)) {
        paths.push({ tuple: t, via: [...via], membership: memberships.get(t.user) || null });
      }
    }
    // 2. Héritage par rattachement : `admin from project`.
    for (const g of granting) {
      walkUnion(relationDef(model, type, g)?.expression, e => {
        if (e.kind !== 'tupleToUserset') return;
        for (const link of tuples) {
          if (link.object === obj && link.relation === e.tupleset && !link.user.includes('#')) {
            explain(link.user, e.computed, [...via, link], depth + 1);
          }
        }
      });
    }
    seen.delete(key);
  })(object, relation, [], 0);

  // Dédoublonnage, chemins courts en premier.
  const uniq = new Map();
  for (const p of paths) {
    const k = [p.membership, p.tuple, ...p.via].filter(Boolean).map(t => `${t.user} ${t.relation} ${t.object}`).join(' | ');
    if (!uniq.has(k)) uniq.set(k, p);
  }
  return [...uniq.values()].sort((a, b) => a.via.length - b.via.length);
}

/** Tuples contextuels d'appartenance : user member group:<g> pour chaque groupe. */
export function groupTuples(model, user, groups) {
  const groupType = groupTypeFor(model);
  if (!groupType || !user) return [];
  return groups
    .map(g => g.trim())
    .filter(Boolean)
    .map(g => ({ user, relation: groupType.relation, object: `${groupType.type}:${g.replace(/\s+/g, '_')}` }));
}

/**
 * Type de groupe du modèle : un type dont une relation accepte directement
 * `user` et sert d'userset ailleurs (group#member). Null s'il n'y en a pas.
 */
export function groupTypeFor(model) {
  const usersets = new Set();
  for (const t of model?.types || []) {
    for (const r of t.relations || []) {
      for (const d of r.directTypes || []) if (d.relation) usersets.add(`${d.type}#${d.relation}`);
    }
  }
  for (const key of usersets) {
    const [type, relation] = key.split('#');
    if ((relationDef(model, type, relation)?.directTypes || []).some(d => d.type === 'user' && !d.relation)) {
      return { type, relation };
    }
  }
  return null;
}

/** Objets connus d'un type, tirés des tuples (objet ou sujet). */
export function knownObjects(tuples, type) {
  const out = new Set();
  for (const t of tuples) {
    for (const ref of [t.object, t.user.split('#')[0]]) {
      if (ref.startsWith(type + ':') && !ref.endsWith(':*')) out.add(ref);
    }
  }
  return [...out].sort();
}

/** "user:alice", { object:{type,id} } ou usersets renvoyés par ListUsers → chaîne. */
export function userToString(u) {
  if (u.object) return `${u.object.type}:${u.object.id}`;
  if (u.userset) return `${u.userset.type}:${u.userset.id}#${u.userset.relation}`;
  if (u.wildcard) return `${u.wildcard.type}:*`;
  return String(u);
}
