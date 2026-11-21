// lib/k8s.js — Traduction d'une requête Kubernetes en Check OpenFGA, à
// l'identique du webhook openfga-k8s-authz (internal/authz/translate.go) :
// même correspondance verbe/ressource → permission, mêmes tuples
// contextuels (rattachement namespace → cluster, appartenance aux groupes).

export const CAN_READ = 'can_read';
export const CAN_READ_SECRETS = 'can_read_secrets';
export const CAN_WRITE = 'can_write';
export const CAN_EXEC = 'can_exec';
export const CAN_ADMIN = 'can_admin';

const READ = new Set(['get', 'list', 'watch']);
const WRITE = new Set(['create', 'update', 'patch', 'delete', 'deletecollection']);
const RBAC_KINDS = new Set(['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings']);
const EXEC_SUBRESOURCES = new Set(['exec', 'attach', 'portforward', 'proxy', 'ephemeralcontainers']);
const VALID_ID = /^[^\s:#]{1,200}$/;
// OpenFGA accepte 100 tuples contextuels ; un est réservé au rattachement.
const MAX_GROUPS = 99;

export const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'bind', 'escalate', 'impersonate'];

/** Le modèle du store a-t-il la forme attendue par le webhook ? */
export function isKubernetesModel(model) {
  const types = new Map((model?.types || []).map(t => [t.name, new Set((t.relations || []).map(r => r.name))]));
  const perms = [CAN_READ, CAN_READ_SECRETS, CAN_WRITE, CAN_EXEC, CAN_ADMIN];
  return ['namespace', 'cluster'].every(t => types.has(t) && perms.every(p => types.get(t).has(p))) &&
    types.get('namespace').has('cluster') && types.has('user');
}

/**
 * Permission et portée d'une requête : [relation, 'request'|'cluster'],
 * relation vide si le webhook n'a jamais d'avis (impersonate, approve…).
 */
export function relationFor(a) {
  const verb = a.verb;
  const read = READ.has(verb);
  const write = WRITE.has(verb);
  const core = !a.group;
  const rbac = a.group === 'rbac.authorization.k8s.io' && RBAC_KINDS.has(a.resource);
  const sub = a.subresource || '';

  if (core && a.resource === 'namespaces' && !sub) {
    if (read && a.name) return [CAN_READ, 'request'];
    if (read) return [CAN_READ, 'cluster'];
    if (write) return [CAN_ADMIN, 'cluster'];
    return ['', 'request'];
  }
  if (core && a.resource === 'nodes' && sub === 'proxy') return [CAN_ADMIN, 'cluster'];
  // Comme le switch Go : un cas reconnu dont la condition interne échoue
  // passe directement aux règles générales, sans tester les cas suivants.
  if (core && a.resource === 'pods' && EXEC_SUBRESOURCES.has(sub)) {
    if (read || write) return [CAN_EXEC, 'request'];
  } else if (core && a.resource === 'services' && sub === 'proxy') {
    if (read || write) return [CAN_EXEC, 'request'];
  } else if (core && a.resource === 'serviceaccounts' && sub === 'token') {
    if (write) return [CAN_ADMIN, 'request'];
  } else if (rbac && (verb === 'bind' || verb === 'escalate')) {
    return [CAN_ADMIN, 'request'];
  } else if (rbac && write) {
    return [CAN_ADMIN, 'request'];
  } else if (core && a.resource === 'secrets' && read) {
    return [CAN_READ_SECRETS, 'request'];
  }

  if (read) return [CAN_READ, 'request'];
  if (write && !a.namespace) return [CAN_ADMIN, 'request'];
  if (write) return [CAN_WRITE, 'request'];
  return ['', 'request'];
}

/**
 * Traduit une requête en Check. Entrée : { user, groups[], verb, resource,
 * subresource, group (API), namespace, name, cluster }, utilisateur et
 * groupes sans préfixe. Sortie : { check: { user, relation, object,
 * contextual[] } } ou { reason } quand le webhook ne donne pas d'avis.
 */
export function translate(req) {
  const name = (req.user || '').trim();
  if (!VALID_ID.test(name)) return { reason: 'nom d\'utilisateur inutilisable comme identifiant OpenFGA' };
  if (!req.resource) return { reason: 'requête hors ressource (ex. /healthz) : le webhook ne donne pas d\'avis' };
  const [relation, scope] = relationFor(req);
  if (!relation) return { reason: `verbe « ${req.verb} » sur ${resourceName(req)} : jamais accordé par OpenFGA` };

  const user = `user:${name}`;
  const cluster = (req.cluster || '').trim() || 'default';
  const namespace = scope === 'cluster' ? '' : (req.namespace || '').trim();
  const check = { user, relation, object: '', contextual: [] };
  if (!namespace) {
    check.object = `cluster:${cluster}`;
  } else {
    if (!VALID_ID.test(namespace)) return { reason: 'namespace inutilisable comme identifiant OpenFGA' };
    check.object = `namespace:${namespace}`;
    check.contextual.push({ user: `cluster:${cluster}`, relation: 'cluster', object: check.object });
  }
  for (const g of req.groups || []) {
    if (check.contextual.length > MAX_GROUPS) break;
    const id = groupID(g);
    if (id) check.contextual.push({ user, relation: 'member', object: `group:${id}` });
  }
  return { check };
}

/** "authentik Admins" → "authentik_Admins" (comme le webhook), ou '' si inutilisable. */
export function groupID(group) {
  const id = String(group).trim().split(/\s+/).filter(Boolean).join('_');
  return VALID_ID.test(id) ? id : '';
}

export function resourceName(a) {
  const base = a.group ? `${a.resource}.${a.group}` : a.resource;
  return a.subresource ? `${base}/${a.subresource}` : base;
}

/** Commande kubectl équivalente, avec les préfixes OIDC de l'apiserver. */
export function kubectlCommand(req, prefix = 'oidc:') {
  const resource = req.group ? `${req.resource}.${req.group}` : req.resource;
  const target = req.name ? `${resource}/${req.name}` : resource;
  const parts = ['kubectl auth can-i', req.verb, target];
  if (req.subresource) parts.push(`--subresource=${req.subresource}`);
  if (req.namespace) parts.push(`-n ${req.namespace}`);
  parts.push(`--as=${prefix}${req.user}`);
  for (const g of req.groups || []) {
    const v = `${prefix}${String(g).trim()}`;
    parts.push(/\s/.test(v) ? `--as-group='${v}'` : `--as-group=${v}`);
  }
  return parts.join(' ');
}
