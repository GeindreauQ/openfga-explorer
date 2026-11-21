// controllers/access-page/kubectl.js — Onglet « Simuler kubectl » : traduit
// une requête Kubernetes exactement comme le webhook openfga-k8s-authz
// (lib/k8s.js), pose la même question à OpenFGA, et explique la réponse.

import { escapeHtml } from '../../lib/dom.js';
import { auditCheck } from '../../lib/api.js';
import { toast } from '../../lib/toast.js';
import { translate, kubectlCommand, resourceName, VERBS } from '../../lib/k8s.js';
import { grantingRelations, assignableRelations, knownObjects, splitObject } from '../../lib/access.js';
import { context, options, field, ref, relationChip, renderPaths, explain, loading, emptyState } from './common.js';

// Ressources courantes, au format kubectl (ressource.groupe).
const RESOURCES = [
  'pods', 'deployments.apps', 'statefulsets.apps', 'daemonsets.apps', 'replicasets.apps', 'jobs.batch', 'cronjobs.batch',
  'services', 'configmaps', 'secrets', 'persistentvolumeclaims', 'serviceaccounts', 'events', 'namespaces', 'nodes',
  'ingresses.networking.k8s.io', 'httproutes.gateway.networking.k8s.io', 'ciliumnetworkpolicies.cilium.io',
  'roles.rbac.authorization.k8s.io', 'rolebindings.rbac.authorization.k8s.io',
  'clusterroles.rbac.authorization.k8s.io', 'clusterrolebindings.rbac.authorization.k8s.io',
  'customresourcedefinitions.apiextensions.k8s.io',
];
const SUBRESOURCES = ['', 'log', 'exec', 'attach', 'portforward', 'proxy', 'ephemeralcontainers', 'scale', 'status', 'token'];

/** Rôle à attribuer proposé par le simulateur : passé à l'onglet Attribuer. */
let onGrant = () => {};
export function setGrantHandler(fn) { onGrant = fn; }

export function renderKubectlForm(form, prefill = {}) {
  const ctx = context();
  const namespaces = knownObjects(ctx.tuples, 'namespace').map(o => splitObject(o)[1]);
  form.innerHTML = `
    ${field('Utilisateur', `<input name="user" placeholder="alice" value="${escapeHtml(prefill.user || '')}" required spellcheck="false" />`, 'Sans le préfixe oidc:')}
    ${field('Groupes', `<input name="groups" placeholder="team-a, viewers" value="${escapeHtml(prefill.groups || '')}" spellcheck="false" />`)}
    ${field('Verbe', `<select name="verb">${options(VERBS, prefill.verb || 'get')}</select>`)}
    ${field('Ressource', `<input name="resource" list="access-k8s-resources" value="${escapeHtml(prefill.resource || 'pods')}" required spellcheck="false" /><datalist id="access-k8s-resources">${options(RESOURCES)}</datalist>`)}
    ${field('Sous-ressource', `<input name="subresource" list="access-k8s-sub" value="${escapeHtml(prefill.subresource || '')}" spellcheck="false" /><datalist id="access-k8s-sub">${options(SUBRESOURCES)}</datalist>`)}
    ${field('Namespace', `<input name="namespace" list="access-k8s-ns" placeholder="(tout le cluster)" value="${escapeHtml(prefill.namespace || '')}" spellcheck="false" /><datalist id="access-k8s-ns">${options(namespaces)}</datalist>`)}
    ${field('Nom', `<input name="name" placeholder="(optionnel)" value="${escapeHtml(prefill.name || '')}" spellcheck="false" />`)}
    <button type="submit" class="btn primary"><i class="ti ti-player-play" aria-hidden="true"></i> Simuler</button>`;
  form.onsubmit = e => { e.preventDefault(); simulate(readRequest(form)); };
  if (prefill.user) form.requestSubmit();
  else document.getElementById('access-results').innerHTML = emptyState('ti-terminal-2', 'Rejouer une requête kubectl',
    'Le simulateur applique la correspondance verbe → permission du webhook et interroge OpenFGA avec les mêmes tuples contextuels. RBAC n\'est pas simulé : OpenFGA ne fait qu\'ajouter des droits.');
}

function readRequest(form) {
  const f = form.elements;
  // "deployments.apps" → ressource deployments, groupe apps.
  const [resource, ...group] = f.resource.value.trim().split('.');
  return {
    user: f.user.value.trim(),
    groups: f.groups.value.split(',').map(g => g.trim()).filter(Boolean),
    verb: f.verb.value,
    resource,
    group: group.join('.'),
    subresource: f.subresource.value.trim(),
    namespace: f.namespace.value.trim(),
    name: f.name.value.trim(),
    cluster: context().cluster,
  };
}

async function simulate(req) {
  const out = document.getElementById('access-results');
  const ctx = context();
  const command = kubectlCommand(req);
  const { check, reason } = translate(req);
  if (!check) {
    out.innerHTML = `${commandBlock(command)}
      <div class="access-verdict neutral"><i class="ti ti-circle-dashed" aria-hidden="true"></i>
        <div><strong>Sans avis</strong><span>${escapeHtml(reason)}. Seul RBAC décide.</span></div></div>`;
    wireCopy(out, command);
    return;
  }
  out.innerHTML = loading('Question posée à OpenFGA…');
  let allowed;
  try {
    ({ allowed } = await auditCheck({ user: check.user, relation: check.relation, object: check.object, contextual_tuples: check.contextual }));
  } catch (e) {
    out.innerHTML = `<p class="access-error">${escapeHtml(e.message)}</p>`;
    return;
  }

  const [type] = splitObject(check.object);
  const roles = assignableRelations(ctx.model, type).filter(r => grantingRelations(ctx.model, type, check.relation).has(r));
  const verdict = allowed
    ? `<div class="access-verdict allowed"><i class="ti ti-circle-check" aria-hidden="true"></i>
        <div><strong>Autorisé par OpenFGA</strong><span>Le webhook répond « allowed » : la requête passe même si RBAC ne l'autorise pas.</span></div></div>`
    : `<div class="access-verdict denied"><i class="ti ti-circle-x" aria-hidden="true"></i>
        <div><strong>Pas de droit OpenFGA</strong><span>Le webhook répond « sans avis » : la requête passe seulement si RBAC l'autorise.</span></div></div>`;
  const question = `<dl class="access-question">
      <dt>Ressource</dt><dd><code>${escapeHtml(resourceName(req))}</code>, verbe <code>${escapeHtml(req.verb)}</code></dd>
      <dt>Question</dt><dd>${ref(check.user)} ${relationChip(check.relation)} ${ref(check.object)}</dd>
      <dt>Rôles qui l'accordent</dt><dd>${roles.map(r => `${relationChip(r, 'role')} sur ${escapeHtml(type)}`).join(', ') || '—'}${type === 'namespace' ? ', ou sur son projet ou le cluster' : ''}</dd>
      ${check.contextual.length ? `<dt>Tuples contextuels</dt><dd class="access-contextual">${check.contextual.map(t => `<span>${ref(t.user)} ${relationChip(t.relation, 'link')} ${ref(t.object)}</span>`).join('')}</dd>` : ''}
    </dl>`;
  const why = allowed
    ? `<section class="access-detail"><h4>Pourquoi</h4>${renderPaths(explain(ctx, check.contextual, check.user, check.object, check.relation), { contextual: check.contextual })}</section>`
    : roles.length ? `<div class="access-suggest" data-requires-write>
        <span>Donner l'accès :</span>
        ${roles.map(r => `<button type="button" class="btn" data-grant="${escapeHtml(r)}"><i class="ti ti-user-plus" aria-hidden="true"></i> ${escapeHtml(r)} sur ${escapeHtml(check.object)}</button>`).join('')}
      </div>` : '';
  out.innerHTML = `${commandBlock(command)}${verdict}${question}${why}`;
  wireCopy(out, command);
  out.querySelectorAll('[data-grant]').forEach(btn => btn.addEventListener('click', () => {
    onGrant({ relation: btn.dataset.grant, object: check.object, subject: check.user });
  }));
}

function commandBlock(command) {
  return `<div class="access-command"><code>${escapeHtml(command)}</code>
    <button type="button" class="btn" data-copy title="Copier"><i class="ti ti-copy" aria-hidden="true"></i></button></div>`;
}

function wireCopy(root, command) {
  root.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(command); toast('Commande copiée'); } catch { toast('Copie impossible', true); }
  });
}
