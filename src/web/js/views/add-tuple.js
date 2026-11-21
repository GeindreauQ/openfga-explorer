// Formulaire d'ajout de tuple, piloté par le modèle d'autorisation.

import { $, escapeHtml, parseType, parseId } from '../lib/dom.js';
import {
  typeLabel, objectTypes, directRelations, allowedSubjects,
} from '../models/types.js';
import { state, existingIds, addToPending, removeFromPending } from '../lib/state.js';
import { writeTuple } from '../lib/api.js';
import { connection } from '../config.js';
import { toast } from '../lib/toast.js';
import { render } from './cards.js';
import { renderPendingPanel } from './pending-panel.js';
import { typeClass } from '../lib/type-style.js';

// ── Remplissage des selects / datalists ──────────────────────────────────────

// Alimente une <datalist> avec les ids existants d'un type.
function fillIdSuggestions(listId, type) {
  const dl = $(listId);
  if (!dl) return;
  dl.innerHTML = existingIds(type).map(id => `<option value="${escapeHtml(id)}">`).join('');
}

// Remplit un <select> avec une liste de chaînes ou de { value, label }.
function fillSelect(sel, items, current) {
  const vals = items.map(it => (typeof it === 'string' ? it : it.value));
  sel.innerHTML = items.map(it => {
    const v = typeof it === 'string' ? it : it.value;
    const lbl = typeof it === 'string' ? it : it.label;
    return `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(lbl)}</option>`;
  }).join('');
  // Valeur explicite (défaut = premier item) pour fiabiliser la lecture .value
  sel.value = (current != null && vals.includes(current)) ? current : (vals[0] != null ? vals[0] : '');
}

// ── Ouverture / fermeture ─────────────────────────────────────────────────────

/**
 * Ouvre le formulaire d'ajout, éventuellement pré-rempli.
 *   { object: 'warehouse:wh1' } → pré-remplit l'objet
 *   { user: 'user:U' } | { user: 'team:T#member' } → pré-remplit le sujet
 */
export function openAddTuple(prefill) {
  prefill = prefill || {};

  const objSel = $('add-obj-type');
  const objTypeList = objectTypes();
  fillSelect(objSel, objTypeList.map(t => ({ value: t, label: typeLabel(t) })));
  objSel.value = objTypeList[0];
  $('add-obj-id').value = '';
  $('add-user-id').value = '';

  let focusId = 'add-obj-id';
  if (prefill.object) {
    const base = prefill.object.split('#')[0];
    const oType = parseType(base), oId = parseId(base);
    if (objTypeList.includes(oType)) {
      objSel.value = oType;
      $('add-obj-id').value = oId;
      focusId = 'add-relation';
    }
  }

  onObjTypeChange(); // remplit relations + sujets en cascade

  if (prefill.user) {
    const [base, rel] = prefill.user.split('#');
    const uType = parseType(base), uId = parseId(base);
    const userSel = $('add-user-type');
    if ([...userSel.options].some(o => o.value === uType)) {
      userSel.value = uType;
      onUserTypeChange();
      if (uId !== '*') $('add-user-id').value = uId;
      const userRelSel = $('add-user-rel');
      const wantRel = uId === '*' ? '*' : (rel ? '#' + rel : '');
      if ([...userRelSel.options].some(o => o.value === wantRel)) userRelSel.value = wantRel;
      focusId = 'add-relation';
    }
  }

  updateAddPreview();
  $('add-backdrop').classList.add('open');
  setTimeout(() => $(focusId).focus(), 50);
}

/** Ferme le formulaire d'ajout. */
export function closeAddTuple() {
  $('add-backdrop').classList.remove('open');
}

/** Ferme le formulaire si le clic vise le fond. */
export function onAddBackdropClick(e) {
  if (e.target === $('add-backdrop')) closeAddTuple();
}

// ── Réactions aux changements de champs ───────────────────────────────────────

function onObjTypeChange() {
  const objType = $('add-obj-type').value;
  const rels = directRelations(objType);
  fillSelect($('add-relation'), rels);
  fillIdSuggestions('add-obj-id-list', objType);
  const n = existingIds(objType).length;
  $('add-obj-hint').textContent =
    `id de l'objet ${typeLabel(objType)}` + (n ? ` — ${n} existant${n > 1 ? 's' : ''}` : '');
  onRelationChange();
}

function onRelationChange() {
  const objType = $('add-obj-type').value;
  const relation = $('add-relation').value;
  const sub = allowedSubjects(objType, relation);
  fillSelect($('add-user-type'), sub.types);
  $('add-rel-hint').textContent =
    `sujets autorisés : ${sub.types.join(', ')}${sub.wildcard ? ' (wildcard * autorisé)' : ''}`;
  onUserTypeChange();
}

function onUserTypeChange() {
  const objType = $('add-obj-type').value;
  const relation = $('add-relation').value;
  const userType = $('add-user-type').value;
  const sub = allowedSubjects(objType, relation);
  const relSel = $('add-user-rel');
  const usersetRels = sub.usersets[userType] ? [...sub.usersets[userType]] : [];
  const opts = [{ value: '', label: '— (objet direct)' }];
  if (sub.wildcard && sub.types.includes(userType)) opts.push({ value: '*', label: '* (wildcard)' });
  usersetRels.forEach(r => opts.push({ value: '#' + r, label: '#' + r }));
  fillSelect(relSel, opts);
  relSel.disabled = opts.length <= 1;
  fillIdSuggestions('add-user-id-list', userType);
  updateAddPreview();
}

// ── Lecture / validation / aperçu ─────────────────────────────────────────────

// Compose les champs combinés (user/object) à partir des selects + ids.
function readAddForm() {
  const objType = $('add-obj-type').value;
  const objId = $('add-obj-id').value.trim();
  const relation = $('add-relation').value;
  const userType = $('add-user-type').value;
  const userId = $('add-user-id').value.trim();
  const userRel = $('add-user-rel').value; // '', '*', '#rel'

  let user;
  if (userRel === '*') user = `${userType}:*`;
  else if (userRel.startsWith('#')) user = `${userType}:${userId}${userRel}`;
  else user = `${userType}:${userId}`;

  const object = `${objType}:${objId}`;

  $('add-user').value = user;
  $('add-object').value = object;

  return { user, relation, object, objType, objId, userType, userId, userRel };
}

function updateAddPreview() {
  const f = readAddForm();
  const prev = $('add-preview');
  const warn = $('add-warning');

  prev.innerHTML = `
    <span>${escapeHtml(f.user)}</span>
    <span class="tuple-arrow">→</span>
    <span class="rel-badge type-fill ${typeClass(f.objType)}">${escapeHtml(f.relation || '?')}</span>
    <span class="tuple-arrow">→</span>
    <span>${escapeHtml(f.object)}</span>`;

  const err = validTuple(f);
  if (err) { warn.textContent = err; warn.hidden = false; }
  else { warn.hidden = true; }
}

function validTuple(f) {
  const { relation, objType, objId, userType, userId, userRel } = f;
  if (!objId) return 'Renseigne l\'identifiant de l\'objet';
  if (!relation) return 'Choisis une relation';
  if (userRel !== '*' && !userId) return 'Renseigne l\'identifiant du sujet';
  // Cohérence modèle
  if (!directRelations(objType).includes(relation))
    return `La relation « ${relation} » n'est pas assignable sur ${typeLabel(objType)}`;
  const sub = allowedSubjects(objType, relation);
  if (!sub.types.includes(userType))
    return `Le type de sujet « ${userType} » n'est pas autorisé pour ${typeLabel(objType)}#${relation}`;
  if (userRel.startsWith('#') && !(sub.usersets[userType] && sub.usersets[userType].has(userRel.slice(1))))
    return `Userset ${userType}${userRel} non autorisé pour cette relation`;
  // Format
  if (/[:#\s]/.test(objId)) return 'L\'identifiant d\'objet ne doit pas contenir : # ou espace';
  if (userRel !== '*' && /[:#\s]/.test(userId)) return 'L\'identifiant de sujet ne doit pas contenir : # ou espace';
  return null;
}

// ── Soumission ────────────────────────────────────────────────────────────────

async function submitAddTuple() {
  const t = readAddForm();
  const err = validTuple(t);
  if (err) { toast(err, true); return; }

  const dup = state.tuples.some(x => x.user === t.user && x.relation === t.relation && x.object === t.object);
  if (dup) { toast('Ce tuple existe déjà', true); return; }

  // "Ajouter" ne pousse pas directement : on ajoute aux modifications
  // en attente (state.pendingAdds). Le tuple sera commité en bloc via
  // le panneau pending-panel (bouton "Appliquer"). Permet à l'utilisateur de voir
  // l'ensemble de ses changements avant de muter le store.
  addToPending(t);
  renderPendingPanel();
  closeAddTuple();
  const total = state.pendingAdds.length + state.pendingRemoves.length;
  toast(`Modification en attente (${total} en file).`);
}

// ── Câblage des événements du formulaire (appelé une fois à l'init) ───────────

export function initAddTupleForm() {
  $('add-obj-type').addEventListener('change', onObjTypeChange);
  $('add-relation').addEventListener('change', onRelationChange);
  $('add-user-type').addEventListener('change', onUserTypeChange);
  $('add-user-rel').addEventListener('change', updateAddPreview);

  ['add-obj-id', 'add-user-id'].forEach(id => {
    $(id).addEventListener('input', updateAddPreview);
  });

  $('btn-add-push')?.addEventListener('click', () => submitAddTuple());
  $('btn-close-add').addEventListener('click', closeAddTuple);
  $('add-backdrop').addEventListener('click', onAddBackdropClick);
  $('add-backdrop').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAddTuple();
  });
}
