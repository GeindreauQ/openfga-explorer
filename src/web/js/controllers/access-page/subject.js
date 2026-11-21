// controllers/access-page/subject.js — Onglet « Droits d'un sujet » : pour
// un utilisateur (avec ses groupes, envoyés comme le ferait le webhook) ou
// un groupe, tous les objets sur lesquels il a un droit (ListObjects), par
// type, avec le rôle le plus fort et le chemin de chaque accès.

import { escapeHtml } from '../../lib/dom.js';
import { auditListObjects } from '../../lib/api.js';
import {
  objectTypes, accessRelations, assignableRelations, impliedRelations, groupTypeFor, groupTuples,
  knownObjects, splitObject,
} from '../../lib/access.js';
import {
  context, clusterLinks, options, field, ref, relationChip, renderPaths, explain,
  loading, emptyState, pool,
} from './common.js';

// OpenFGA accepte 100 tuples contextuels par requête.
const MAX_CONTEXTUAL = 100;

export function renderSubjectForm(form, prefill = {}) {
  const ctx = context();
  const group = groupTypeFor(ctx.model);
  const kinds = ['user', ...(group ? [`${group.type}#${group.relation}`] : [])];
  form.innerHTML = `
    ${field('Sujet', `<select name="kind">${options(kinds, prefill.kind || 'user')}</select>`)}
    ${field('Identifiant', `<input name="id" list="access-subject-ids" placeholder="alice" value="${escapeHtml(prefill.id || '')}" required spellcheck="false" /><datalist id="access-subject-ids"></datalist>`)}
    ${group ? field('Groupes', `<input name="groups" placeholder="billing-team, authentik Admins" value="${escapeHtml(prefill.groups || '')}" spellcheck="false" />`,
      'Appartenances envoyées à la requête, comme le claim groups du jeton.') : ''}
    <button type="submit" class="btn primary"><i class="ti ti-search" aria-hidden="true"></i> Afficher</button>`;
  const groupsField = form.elements.groups?.closest('.access-field');
  const fillIds = () => {
    const kind = form.elements.kind.value;
    const type = kind.split('#')[0];
    document.getElementById('access-subject-ids').innerHTML = options(knownObjects(ctx.tuples, type).map(o => splitObject(o)[1]));
    if (groupsField) groupsField.hidden = kind !== 'user';
  };
  form.elements.kind.addEventListener('change', fillIds);
  fillIds();
  form.onsubmit = e => {
    e.preventDefault();
    const kind = form.elements.kind.value;
    const [type, rel] = kind.split('#');
    const subject = `${type}:${form.elements.id.value.trim()}${rel ? `#${rel}` : ''}`;
    const groups = kind === 'user' && form.elements.groups ? form.elements.groups.value.split(',') : [];
    showSubject(subject, groups);
  };
  if (prefill.id) form.requestSubmit();
  else document.getElementById('access-results').innerHTML = emptyState('ti-user', 'Choisissez un sujet',
    'Pour un utilisateur, indiquez ses groupes : l\'explorer les envoie à OpenFGA comme le fait le webhook Kubernetes.');
}

async function showSubject(subject, groups) {
  const out = document.getElementById('access-results');
  const ctx = context();
  out.innerHTML = loading(`Droits de ${subject}…`);

  const contextual = [...groupTuples(ctx.model, subject, groups)];
  const namespaces = knownObjects(ctx.tuples, 'namespace');
  contextual.push(...clusterLinks(ctx, namespaces).slice(0, Math.max(0, MAX_CONTEXTUAL - contextual.length)));

  const types = objectTypes(ctx.model).filter(t => !(subject.includes('#') && subject.startsWith(t + ':')));
  const queries = types.flatMap(type => accessRelations(ctx.model, type).map(relation => ({ type, relation })));
  let results;
  try {
    results = await pool(queries, 6, q => auditListObjects({
      user: subject, relation: q.relation, type: q.type, contextual_tuples: contextual,
    }).then(r => r.objects || []));
  } catch (e) {
    out.innerHTML = `<p class="access-error">${escapeHtml(e.message)}</p>`;
    return;
  }

  // type → objet → Set(relations)
  const byType = new Map();
  queries.forEach((q, i) => {
    for (const obj of results[i]) {
      if (!byType.has(q.type)) byType.set(q.type, new Map());
      const objs = byType.get(q.type);
      if (!objs.has(obj)) objs.set(obj, new Set());
      objs.get(obj).add(q.relation);
    }
  });

  const groupNote = contextual.some(t => t.relation !== 'cluster')
    ? `<span class="access-links">groupes : ${groups.filter(g => g.trim()).map(g => escapeHtml(g.trim())).join(', ')}</span>` : '';
  if (!byType.size) {
    out.innerHTML = `<div class="access-result-head"><h3>${ref(subject)}</h3>${groupNote}</div>${emptyState('ti-lock', 'Aucun droit', 'OpenFGA n\'accorde rien à ce sujet.')}`;
    return;
  }
  const clusterWide = ctx.k8s && byType.get('cluster')?.size
    ? '<p class="access-note"><i class="ti ti-info-circle" aria-hidden="true"></i> Les droits sur le cluster valent pour tous ses namespaces, y compris ceux qui n\'apparaissent dans aucun tuple.</p>' : '';
  out.innerHTML = `
    <div class="access-result-head"><h3>${ref(subject)}</h3>${groupNote}</div>
    ${clusterWide}
    ${[...byType.entries()].map(([type, objs]) => typeTable(ctx, type, objs)).join('')}
    <div id="access-detail"></div>`;
  out.querySelectorAll('tr[data-object]').forEach(tr => {
    const open = () => {
      document.querySelectorAll('.access-matrix tr.selected').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      showPaths(ctx, subject, tr.dataset.object, tr.dataset.relation, contextual);
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  });
}

function typeTable(ctx, type, objs) {
  const roles = assignableRelations(ctx.model, type);
  const rows = [...objs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([obj, rels]) => {
    const top = strongest(ctx.model, type, roles.filter(r => rels.has(r)));
    const perms = [...rels].filter(r => !roles.includes(r));
    return `<tr data-object="${escapeHtml(obj)}" data-relation="${escapeHtml(top || [...rels][0])}" tabindex="0">
      <th>${ref(obj)}</th>
      <td>${top ? relationChip(top, 'role') : '<span class="access-muted">—</span>'}</td>
      <td><div class="access-perms">${perms.map(p => relationChip(p)).join(' ')}</div></td>
    </tr>`;
  }).join('');
  return `<section class="access-type">
    <h4>${escapeHtml(type)} <span class="access-count">${objs.size}</span></h4>
    <div class="access-table-wrap"><table class="access-matrix access-list">
      <thead><tr><th>Objet</th><th>Rôle</th><th>Permissions</th></tr></thead><tbody>${rows}</tbody>
    </table></div></section>`;
}

/** Le rôle qui implique le plus d'autres (admin avant editor avant viewer). */
function strongest(model, type, roles) {
  return roles.sort((a, b) => impliedRelations(model, type, b).size - impliedRelations(model, type, a).size)[0];
}

function showPaths(ctx, subject, object, relation, contextual) {
  document.getElementById('access-detail').innerHTML = `
    <section class="access-detail">
      <h4>Pourquoi ${ref(subject)} est ${relationChip(relation)} sur ${ref(object)}</h4>
      ${renderPaths(explain(ctx, contextual, subject, object, relation), { contextual })}
    </section>`;
}
