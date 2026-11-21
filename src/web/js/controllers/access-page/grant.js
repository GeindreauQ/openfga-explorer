// controllers/access-page/grant.js — Onglet « Attribuer » : construit un
// tuple sous forme de phrase (« donner editor sur project:billing à
// group:billing-team#member »), montre ce que le rôle accorde, l'écrit, et
// liste les accès directs de l'objet pour les retirer.

import { escapeHtml } from '../../lib/dom.js';
import { writeTuple, deleteTuples } from '../../lib/api.js';
import { toast } from '../../lib/toast.js';
import {
  objectTypes, assignableRelations, linkRelations, impliedRelations, typeDef, knownObjects, splitObject,
} from '../../lib/access.js';
import { context, options, field, ref, relationChip, emptyState, reloadTuples } from './common.js';

export function renderGrantForm(form, prefill = {}) {
  const ctx = context();
  const types = objectTypes(ctx.model);
  const [pType, pId] = prefill.object ? splitObject(prefill.object) : [];
  const type = pType || (types.includes('namespace') ? 'namespace' : types[0]);

  form.innerHTML = `
    <div class="access-sentence">
      <span>Donner</span>
      ${field('Rôle', '<select name="relation"></select>')}
      <span>sur</span>
      ${field('Type', `<select name="type">${options(types, type)}</select>`)}
      ${field('Objet', `<input name="object" list="access-grant-objects" value="${escapeHtml(pId || '')}" placeholder="identifiant" required spellcheck="false" /><datalist id="access-grant-objects"></datalist>`)}
      <span>à</span>
      ${field('Sujet', '<select name="subjectType"></select>')}
      ${field('Identifiant', `<input name="subject" list="access-grant-subjects" placeholder="alice" required spellcheck="false" /><datalist id="access-grant-subjects"></datalist>`)}
    </div>
    <div class="access-preview" id="access-grant-preview"></div>
    <button type="submit" class="btn primary"><i class="ti ti-user-plus" aria-hidden="true"></i> Attribuer</button>`;

  const f = form.elements;
  const fillRelations = () => {
    const t = f.type.value;
    const roles = assignableRelations(ctx.model, t);
    const links = [...linkRelations(ctx.model, t)];
    f.relation.innerHTML = `<optgroup label="Rôles">${options(roles, prefill.relation)}</optgroup>` +
      (links.length ? `<optgroup label="Rattacher à">${options(links, prefill.relation)}</optgroup>` : '');
    document.getElementById('access-grant-objects').innerHTML = options(knownObjects(ctx.tuples, t).map(o => splitObject(o)[1]));
    fillSubjects();
  };
  const fillSubjects = () => {
    const rel = (typeDef(ctx.model, f.type.value)?.relations || []).find(r => r.name === f.relation.value);
    const kinds = (rel?.directTypes || []).map(d => d.wildcard ? `${d.type}:*` : d.relation ? `${d.type}#${d.relation}` : d.type);
    const wanted = prefill.subject ? subjectKind(prefill.subject) : undefined;
    f.subjectType.innerHTML = options([...new Set(kinds)], wanted);
    if (prefill.subject) f.subject.value = subjectId(prefill.subject);
    fillSubjectIds();
  };
  const fillSubjectIds = () => {
    const kind = f.subjectType.value || '';
    f.subject.disabled = kind.endsWith(':*');
    f.subject.required = !f.subject.disabled;
    if (f.subject.disabled) f.subject.value = '';
    document.getElementById('access-grant-subjects').innerHTML = options(knownObjects(ctx.tuples, kind.split(/[#:]/)[0]).map(o => splitObject(o)[1]));
    preview();
  };
  f.type.addEventListener('change', () => { prefill = {}; fillRelations(); });
  f.relation.addEventListener('change', () => { prefill = {}; fillSubjects(); });
  f.subjectType.addEventListener('change', fillSubjectIds);
  for (const input of [f.object, f.subject]) input.addEventListener('input', preview);
  form.onsubmit = async e => {
    e.preventDefault();
    const t = tuple(f);
    if (!t) return;
    try {
      await writeTuple(t);
      await reloadTuples();
      toast('Accès attribué');
      f.subject.value = '';
      preview();
    } catch (err) {
      toast('Erreur : ' + err.message, true);
    }
  };
  fillRelations();

  function preview() {
    const t = tuple(f);
    const box = document.getElementById('access-grant-preview');
    if (!t) {
      box.innerHTML = '';
      form.querySelector('button[type=submit]').disabled = false;
      const id = f.object.value.trim();
      renderCurrent(id ? `${f.type.value}:${id}` : null);
      return;
    }
    const ctxNow = context();
    const exists = ctxNow.tuples.some(x => x.user === t.user && x.relation === t.relation && x.object === t.object);
    const isNew = !knownObjects(ctxNow.tuples, f.type.value).includes(t.object);
    const implied = [...impliedRelations(ctxNow.model, f.type.value, t.relation)].filter(r => r !== t.relation);
    const isLink = linkRelations(ctxNow.model, f.type.value).has(t.relation);
    box.innerHTML = `
      <div class="access-tuple-preview">${ref(t.user)} ${relationChip(t.relation, isLink ? 'link' : 'role')} ${ref(t.object)}</div>
      ${isLink ? `<p>${ref(t.object)} hérite des rôles donnés sur ${ref(t.user)}.</p>`
        : implied.length ? `<p>Accorde aussi : ${implied.map(r => relationChip(r)).join(' ')}</p>` : ''}
      ${exists ? '<p class="access-warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Ce tuple existe déjà.</p>' : ''}
      ${isNew && !exists ? '<p class="access-note"><i class="ti ti-info-circle" aria-hidden="true"></i> Objet absent des tuples : il sera créé.</p>' : ''}`;
    form.querySelector('button[type=submit]').disabled = exists;
    renderCurrent(t.object);
  }
}

function tuple(f) {
  const id = f.object.value.trim();
  const kind = f.subjectType.value;
  if (!id || !kind || !f.relation.value) return null;
  let user;
  if (kind.endsWith(':*')) user = kind;
  else {
    const sid = f.subject.value.trim();
    if (!sid) return null;
    const [type, rel] = kind.split('#');
    user = `${type}:${sid}${rel ? `#${rel}` : ''}`;
  }
  return { user, relation: f.relation.value, object: `${f.type.value}:${id}` };
}

function subjectKind(subject) {
  const [type, rest] = splitObject(subject);
  if (rest === '*') return `${type}:*`;
  const rel = rest.split('#')[1];
  return rel ? `${type}#${rel}` : type;
}

function subjectId(subject) {
  return splitObject(subject)[1].split('#')[0];
}

/** Accès directs existants sur l'objet, avec retrait. */
function renderCurrent(object) {
  const out = document.getElementById('access-results');
  if (!object) {
    out.innerHTML = emptyState('ti-user-plus', 'Attribuer un rôle',
      'Composez la phrase ci-dessus ; les accès directs de l\'objet s\'affichent ici.');
    return;
  }
  const ctx = context();
  const direct = ctx.tuples.filter(t => t.object === object);
  out.innerHTML = `
    <div class="access-result-head"><h3>Accès directs sur ${ref(object)}</h3><span class="access-count">${direct.length}</span></div>
    ${direct.length ? `<ul class="access-direct">${direct.map(t => `
      <li>${ref(t.user)} ${relationChip(t.relation, linkRelations(ctx.model, splitObject(object)[0]).has(t.relation) ? 'link' : 'role')}
        <button type="button" class="btn danger" data-revoke='${escapeHtml(JSON.stringify(t))}' title="Retirer" aria-label="Retirer ${escapeHtml(t.relation)} à ${escapeHtml(t.user)}"><i class="ti ti-user-minus" aria-hidden="true"></i></button>
      </li>`).join('')}</ul>` : '<p class="access-empty-line">Aucun tuple direct.</p>'}`;
  out.querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', async () => {
    const t = JSON.parse(btn.dataset.revoke);
    if (!confirm(`Retirer « ${t.user} ${t.relation} ${t.object} » ?`)) return;
    try {
      await deleteTuples([t]);
      await reloadTuples();
      toast('Accès retiré');
      renderCurrent(object);
    } catch (e) {
      toast('Erreur : ' + e.message, true);
    }
  }));
}
