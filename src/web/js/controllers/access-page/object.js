// controllers/access-page/object.js — Onglet « Qui a accès » : pour un
// objet, la matrice sujets × droits (ListUsers), distinguant les tuples
// directs des droits hérités, et le chemin de chaque accès.

import { escapeHtml } from '../../lib/dom.js';
import { auditListUsers, deleteTuples } from '../../lib/api.js';
import { toast } from '../../lib/toast.js';
import {
  objectTypes, accessRelations, assignableRelations, subjectFilters, knownObjects,
  linkRelations, splitObject, userToString,
} from '../../lib/access.js';
import {
  context, clusterLinks, options, field, ref, relationChip, renderPaths, explain,
  loading, emptyState, pool, reloadTuples,
} from './common.js';

let last = null; // { object, rows, relations, contextual }

export function renderObjectForm(form, prefill = {}) {
  const ctx = context();
  const types = objectTypes(ctx.model);
  const type = prefill.type || (types.includes('namespace') ? 'namespace' : types[0]);
  form.innerHTML = `
    ${field('Type', `<select name="type">${options(types, type)}</select>`)}
    ${field('Objet', `<input name="id" list="access-object-ids" placeholder="identifiant" value="${escapeHtml(prefill.id || '')}" required spellcheck="false" /><datalist id="access-object-ids"></datalist>`)}
    <button type="submit" class="btn primary"><i class="ti ti-search" aria-hidden="true"></i> Afficher</button>`;
  const fillIds = () => {
    const t = form.elements.type.value;
    document.getElementById('access-object-ids').innerHTML = options(knownObjects(ctx.tuples, t).map(o => splitObject(o)[1]));
  };
  form.elements.type.addEventListener('change', fillIds);
  fillIds();
  form.onsubmit = e => {
    e.preventDefault();
    showObject(`${form.elements.type.value}:${form.elements.id.value.trim()}`);
  };
  if (prefill.id) showObject(`${type}:${prefill.id}`);
  else document.getElementById('access-results').innerHTML = emptyState('ti-box', 'Choisissez un objet',
    'La matrice liste chaque utilisateur ou groupe ayant un droit sur l\'objet, et d\'où vient ce droit.');
}

async function showObject(object) {
  const out = document.getElementById('access-results');
  const ctx = context();
  const [type, id] = splitObject(object);
  if (!id) return;
  out.innerHTML = loading(`Droits sur ${object}…`);

  const relations = orderRelations(ctx.model, type);
  const filters = subjectFilters(ctx.model, type);
  const contextual = type === 'namespace' ? clusterLinks(ctx, [object]) : [];
  const queries = relations.flatMap(relation => filters.map(f => ({ relation, f })));
  let results;
  try {
    results = await pool(queries, 6, ({ relation, f }) => auditListUsers({
      object, relation, user_type: f.type, user_relation: f.relation, contextual_tuples: contextual,
    }).then(r => (r.users || []).map(userToString)));
  } catch (e) {
    out.innerHTML = `<p class="access-error">${escapeHtml(e.message)}</p>`;
    return;
  }

  // sujet → { relations: Set, direct: Set }
  const rows = new Map();
  queries.forEach(({ relation }, i) => {
    for (const subject of results[i]) {
      if (!rows.has(subject)) rows.set(subject, { relations: new Set(), direct: new Set() });
      rows.get(subject).relations.add(relation);
    }
  });
  for (const t of ctx.tuples) {
    if (t.object === object && rows.has(t.user)) rows.get(t.user).direct.add(t.relation);
  }
  last = { object, rows, relations, contextual };

  const links = ctx.tuples.filter(t => t.object === object && linkRelations(ctx.model, type).has(t.relation));
  const linkLine = [...links, ...contextual].map(t => `${relationChip(t.relation, 'link')} ${ref(t.user)}`).join(' · ');

  if (!rows.size) {
    out.innerHTML = `${header(object, linkLine)}${emptyState('ti-lock', 'Personne', 'Aucun sujet n\'a de droit sur cet objet.')}`;
    return;
  }
  // Seules les relations accordées à quelqu'un font une colonne : sur un type
  // riche, les autres poussaient les droits réels hors de l'écran.
  const shown = relations.filter(r => [...rows.values()].some(row => row.relations.has(r)));
  const hidden = relations.length - shown.length;
  const sorted = [...rows.entries()].sort((a, b) => b[1].relations.size - a[1].relations.size || a[0].localeCompare(b[0]));
  // Peu de relations : matrice sujet × relation. Au-delà, une matrice ne
  // tient plus à l'écran ; chaque sujet liste alors ses droits en badges.
  const MAX_COLUMNS = 8;
  const dot = (row, r) => row.direct.has(r) ? '<span class="access-dot direct" title="tuple direct">●</span>' : row.relations.has(r) ? '<span class="access-dot" title="hérité">○</span>' : '';
  const table = shown.length <= MAX_COLUMNS ? `
      <table class="access-matrix">
        <thead><tr><th>Sujet</th>${shown.map(r => `<th><span>${escapeHtml(r)}</span></th>`).join('')}</tr></thead>
        <tbody>${sorted.map(([subject, row]) => `
          <tr data-subject="${escapeHtml(subject)}" tabindex="0">
            <th>${ref(subject)}</th>
            ${shown.map(r => `<td>${dot(row, r)}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>` : `
      <table class="access-matrix access-matrix-list">
        <thead><tr><th>Sujet</th><th>Droits</th></tr></thead>
        <tbody>${sorted.map(([subject, row]) => `
          <tr data-subject="${escapeHtml(subject)}" tabindex="0">
            <th>${ref(subject)}</th>
            <td><div class="access-rels">${shown.filter(r => row.relations.has(r)).map(r => relationChip(r, row.direct.has(r) ? 'direct' : '')).join('')}</div></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  const legend = shown.length <= MAX_COLUMNS
    ? '<span class="access-dot direct">●</span> tuple direct <span class="access-dot">○</span> hérité'
    : `${relationChip('relation', 'direct')} tuple direct ${relationChip('relation')} hérité`;
  out.innerHTML = `
    ${header(object, linkLine)}
    <div class="access-table-wrap">${table}
    </div>
    <p class="access-legend">${legend} (rôle supérieur, projet, cluster, groupe). Cliquez une ligne pour le détail.${hidden ? ` ${hidden} relation${hidden > 1 ? 's' : ''} accordée${hidden > 1 ? 's' : ''} à personne masquée${hidden > 1 ? 's' : ''}.` : ''}</p>
    <div id="access-detail"></div>`;
  out.querySelectorAll('tr[data-subject]').forEach(tr => {
    const open = () => showDetail(tr.dataset.subject, tr);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  });
}

function header(object, linkLine) {
  return `<div class="access-result-head"><h3>${ref(object)}</h3>${linkLine ? `<span class="access-links">rattaché à ${linkLine}</span>` : ''}</div>`;
}

/** Rôles attribuables d'abord, puis les permissions calculées. */
function orderRelations(model, type) {
  const assignable = assignableRelations(model, type);
  return [...assignable, ...accessRelations(model, type).filter(r => !assignable.includes(r))];
}

function showDetail(subject, tr) {
  const ctx = context();
  const { object, rows, contextual } = last;
  const row = rows.get(subject);
  document.querySelectorAll('.access-matrix tr.selected').forEach(r => r.classList.remove('selected'));
  tr.classList.add('selected');
  const held = last.relations.filter(r => row.relations.has(r));
  // Un chemin par droit le plus fort : les rôles attribuables suffisent à expliquer le reste.
  const roles = held.filter(r => assignableRelations(ctx.model, splitObject(object)[0]).includes(r));
  const explained = (roles.length ? roles : held.slice(0, 1)).map(r => `
    <div class="access-detail-block">
      <div>${relationChip(r)}</div>
      ${renderPaths(explain(ctx, contextual, subject, object, r), { contextual })}
    </div>`).join('');
  const direct = ctx.tuples.filter(t => t.object === object && t.user === subject);
  document.getElementById('access-detail').innerHTML = `
    <section class="access-detail">
      <h4>${ref(subject)} sur ${ref(object)}</h4>
      <p class="access-detail-held">${held.map(r => relationChip(r, row.direct.has(r) ? 'direct' : '')).join(' ')}</p>
      ${explained}
      ${direct.length ? `<div class="access-detail-actions" data-requires-write>
        ${direct.map(t => `<button type="button" class="btn danger" data-revoke='${escapeHtml(JSON.stringify(t))}'>
          <i class="ti ti-user-minus" aria-hidden="true"></i> Retirer ${escapeHtml(t.relation)}</button>`).join('')}
      </div>` : ''}
    </section>`;
  document.querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', async () => {
    const t = JSON.parse(btn.dataset.revoke);
    if (!confirm(`Retirer « ${t.user} ${t.relation} ${t.object} » ?`)) return;
    try {
      await deleteTuples([t]);
      await reloadTuples();
      toast('Accès retiré');
      showObject(object);
    } catch (e) {
      toast('Erreur : ' + e.message, true);
    }
  }));
}
