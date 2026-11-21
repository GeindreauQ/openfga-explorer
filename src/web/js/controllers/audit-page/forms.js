// controllers/audit-page/forms.js — Rendu des 3 formulaires (Check,
// Reverse, Forward) + helpers de peuplement des selects/datalists.
//
// Chaque `render*Form` :
//   1. Injecte le HTML du formulaire dans `root` (zone de gauche)
//   2. Peuple les selects de type
//   3. Câble les filtres (datalist d'IDs par type, combobox relation)
//   4. Branche le bouton "Run" sur la fonction correspondante (run.js)

import { $, escapeHtml } from '../../lib/dom.js';
import { state } from '../../lib/state.js';
import { runCheck } from './run.js';
import { runReverse } from './run.js';
import { runForward } from './run.js';

// ── Formulaires ─────────────────────────────────────────────────────────

export function renderCheckForm(root) {
  root.innerHTML = `
    <div class="audit-form">
      <p class="audit-mode-hint">
        <i class="ti ti-info-circle" aria-hidden="true"></i>
        Vérifie si <strong>user</strong> a la <strong>relation</strong> choisie
        sur l'<strong>objet</strong> ciblé. Réponse : ALLOWED ou DENIED.
      </p>
      <div class="audit-grid">
        <div class="audit-field">
          <label><i class="ti ti-user" aria-hidden="true"></i> Sujet (qui&nbsp;?)</label>
          <div class="audit-input-row">
            <select id="audit-check-user-type" class="audit-type-select" aria-label="Type du sujet"></select>
            <span class="audit-colon">:</span>
            <input type="text" id="audit-check-user" placeholder="alice" autocomplete="off" list="audit-check-user-list" />
            <datalist id="audit-check-user-list"></datalist>
          </div>
          <div class="hint" id="audit-check-user-hint"></div>
        </div>
        <div class="audit-field audit-field-arrow">
          <div class="audit-arrow"><i class="ti ti-arrow-narrow-right" aria-hidden="true"></i></div>
        </div>
        <div class="audit-field">
          <label><i class="ti ti-shield-check" aria-hidden="true"></i> Relation</label>
          <div class="audit-relation-wrap">
            <input type="text" id="audit-check-relation" placeholder="assignee" autocomplete="off" list="audit-check-relation-list" />
            <datalist id="audit-check-relation-list"></datalist>
            <button type="button" class="audit-relation-toggle" id="audit-check-relation-toggle" title="Voir toutes les relations" aria-label="Toutes les relations">
              <i class="ti ti-list" aria-hidden="true"></i>
            </button>
          </div>
          <div class="hint" id="audit-check-relation-hint"></div>
        </div>
        <div class="audit-field audit-field-arrow">
          <div class="audit-arrow"><i class="ti ti-arrow-narrow-right" aria-hidden="true"></i></div>
        </div>
        <div class="audit-field">
          <label><i class="ti ti-box" aria-hidden="true"></i> Objet (sur quoi&nbsp;?)</label>
          <div class="audit-input-row">
            <select id="audit-check-object-type" class="audit-type-select" aria-label="Type de l'objet"></select>
            <span class="audit-colon">:</span>
            <input type="text" id="audit-check-object" placeholder="readme" autocomplete="off" list="audit-check-object-list" />
            <datalist id="audit-check-object-list"></datalist>
          </div>
          <div class="hint" id="audit-check-object-hint"></div>
        </div>
      </div>
      <details class="audit-context-details">
        <summary><i class="ti ti-code" aria-hidden="true"></i> Contexte CEL (optionnel, pour les conditions)</summary>
        <textarea id="audit-check-context" rows="3" placeholder='{"current_time": "2026-06-27T12:00:00Z", "cidr": "10.0.0.0/8"}'></textarea>
      </details>
      <div class="audit-actions">
        <button type="button" class="btn primary" id="audit-check-run">
          <i class="ti ti-shield-check" aria-hidden="true"></i> Exécuter le Check
        </button>
      </div>
    </div>
  `;
  populateTypes('audit-check-user-type', 'subject');
  populateTypes('audit-check-object-type', 'object');
  wireTypeFilter('audit-check-user-type', 'audit-check-user', 'audit-check-user-list', 'audit-check-user-hint', 'user');
  wireTypeFilter('audit-check-object-type', 'audit-check-object', 'audit-check-object-list', 'audit-check-object-hint', 'object');
  wireRelationFilter('audit-check-object-type', 'audit-check-relation', 'audit-check-relation-list', 'audit-check-relation-hint', 'audit-check-relation-toggle');
  $('audit-check-run')?.addEventListener('click', runCheck);
}

export function renderReverseForm(root) {
  root.innerHTML = `
    <div class="audit-form">
      <p class="audit-mode-hint">
        <i class="ti ti-info-circle" aria-hidden="true"></i>
        Liste tous les <strong>users</strong> (du type choisi) qui ont la
        <strong>relation</strong> sélectionnée sur l'<strong>objet</strong> ciblé.
      </p>
      <div class="audit-grid">
        <div class="audit-field">
          <label><i class="ti ti-box" aria-hidden="true"></i> Objet (sur quoi&nbsp;?)</label>
          <div class="audit-input-row">
            <select id="audit-rev-object-type" class="audit-type-select" aria-label="Type de l'objet"></select>
            <span class="audit-colon">:</span>
            <input type="text" id="audit-rev-object" placeholder="readme" autocomplete="off" list="audit-rev-object-list" />
            <datalist id="audit-rev-object-list"></datalist>
          </div>
          <div class="hint" id="audit-rev-object-hint"></div>
        </div>
        <div class="audit-field audit-field-arrow">
          <div class="audit-arrow"><i class="ti ti-arrow-narrow-left" aria-hidden="true"></i></div>
        </div>
        <div class="audit-field">
          <label><i class="ti ti-shield-check" aria-hidden="true"></i> Relation</label>
          <div class="audit-relation-wrap">
            <input type="text" id="audit-rev-relation" placeholder="assignee" autocomplete="off" list="audit-rev-relation-list" />
            <datalist id="audit-rev-relation-list"></datalist>
            <button type="button" class="audit-relation-toggle" id="audit-rev-relation-toggle" title="Voir toutes les relations" aria-label="Toutes les relations">
              <i class="ti ti-list" aria-hidden="true"></i>
            </button>
          </div>
          <div class="hint" id="audit-rev-relation-hint"></div>
        </div>
      </div>
      <div class="audit-field">
        <label><i class="ti ti-filter" aria-hidden="true"></i> Type de user à lister</label>
        <select id="audit-rev-usertype"></select>
        <div class="hint" id="audit-rev-usertype-hint"></div>
      </div>
      <details class="audit-context-details">
        <summary><i class="ti ti-code" aria-hidden="true"></i> Contexte CEL (optionnel)</summary>
        <textarea id="audit-rev-context" rows="3" placeholder='{"cidr": "10.0.0.0/8"}'></textarea>
      </details>
      <div class="audit-actions">
        <button type="button" class="btn primary" id="audit-rev-run">
          <i class="ti ti-arrow-back-up" aria-hidden="true"></i> Lister les users
        </button>
      </div>
    </div>
  `;
  populateTypes('audit-rev-object-type', 'object');
  populateTypes('audit-rev-usertype', 'subject');
  wireTypeFilter('audit-rev-object-type', 'audit-rev-object', 'audit-rev-object-list', 'audit-rev-object-hint', 'object');
  wireRelationFilter('audit-rev-object-type', 'audit-rev-relation', 'audit-rev-relation-list', 'audit-rev-relation-hint', 'audit-rev-relation-toggle');
  $('audit-rev-run')?.addEventListener('click', runReverse);
}

export function renderForwardForm(root) {
  root.innerHTML = `
    <div class="audit-form">
      <p class="audit-mode-hint">
        <i class="ti ti-info-circle" aria-hidden="true"></i>
        Liste tous les <strong>objects</strong> du type choisi accessibles
        par le <strong>user</strong> via la <strong>relation</strong> sélectionnée.
      </p>
      <div class="audit-grid">
        <div class="audit-field">
          <label><i class="ti ti-user" aria-hidden="true"></i> Sujet (qui&nbsp;?)</label>
          <div class="audit-input-row">
            <select id="audit-fwd-user-type" class="audit-type-select" aria-label="Type du sujet"></select>
            <span class="audit-colon">:</span>
            <input type="text" id="audit-fwd-user" placeholder="alice" autocomplete="off" list="audit-fwd-user-list" />
            <datalist id="audit-fwd-user-list"></datalist>
          </div>
          <div class="hint" id="audit-fwd-user-hint"></div>
        </div>
        <div class="audit-field audit-field-arrow">
          <div class="audit-arrow"><i class="ti ti-arrow-narrow-right" aria-hidden="true"></i></div>
        </div>
        <div class="audit-field">
          <label><i class="ti ti-shield-check" aria-hidden="true"></i> Relation</label>
          <div class="audit-relation-wrap">
            <input type="text" id="audit-fwd-relation" placeholder="assignee" autocomplete="off" list="audit-fwd-relation-list" />
            <datalist id="audit-fwd-relation-list"></datalist>
            <button type="button" class="audit-relation-toggle" id="audit-fwd-relation-toggle" title="Voir toutes les relations" aria-label="Toutes les relations">
              <i class="ti ti-list" aria-hidden="true"></i>
            </button>
          </div>
          <div class="hint" id="audit-fwd-relation-hint"></div>
        </div>
        <div class="audit-field audit-field-arrow">
          <div class="audit-arrow"><i class="ti ti-arrow-narrow-right" aria-hidden="true"></i></div>
        </div>
        <div class="audit-field">
          <label><i class="ti ti-box" aria-hidden="true"></i> Type d'object (résultats)</label>
          <select id="audit-fwd-type"></select>
          <div class="hint" id="audit-fwd-type-hint"></div>
        </div>
      </div>
      <details class="audit-context-details">
        <summary><i class="ti ti-code" aria-hidden="true"></i> Contexte CEL (optionnel)</summary>
        <textarea id="audit-fwd-context" rows="3" placeholder='{"cidr": "10.0.0.0/8"}'></textarea>
      </details>
      <div class="audit-actions">
        <button type="button" class="btn primary" id="audit-fwd-run">
          <i class="ti ti-arrow-right" aria-hidden="true"></i> Lister les objects
        </button>
      </div>
    </div>
  `;
  populateTypes('audit-fwd-user-type', 'subject');
  populateTypes('audit-fwd-type', 'object');
  wireTypeFilter('audit-fwd-user-type', 'audit-fwd-user', 'audit-fwd-user-list', 'audit-fwd-user-hint', 'user');
  wireRelationFilter('audit-fwd-user-type', 'audit-fwd-relation', 'audit-fwd-relation-list', 'audit-fwd-relation-hint', 'audit-fwd-relation-toggle');
  $('audit-fwd-run')?.addEventListener('click', runForward);
}

// ── Helpers : peuplement des dropdowns ──────────────────────────────────

function populateTypes(selectId, role) {
  const sel = $(selectId);
  if (!sel) return;
  const model = state.storeModel;
  if (!model) {
    sel.innerHTML = '<option value="">— Aucun modèle —</option>';
    return;
  }
  const types = (model.types || []).map(t => t.name).sort();
  // On n'inclut pas l'option vide placeholder : on veut que l'utilisateur
  // choisisse explicitement un type (sinon l'auto-complétion ne filtre
  // rien).
  sel.innerHTML = types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  const preferred = defaultType(model, role);
  if (preferred) sel.value = preferred;
}

/**
 * Type proposé par défaut : pour un sujet, "user" s'il peut être assigné
 * directement, sinon le type le plus souvent assignable ; pour un objet, le
 * premier type qui porte des relations et qui n'est pas un pur sujet.
 */
function defaultType(model, role) {
  const types = (model.types || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const subjectCount = new Map();
  for (const t of types) {
    for (const r of t.relations || []) {
      for (const d of r.directTypes || []) {
        if (!d.relation) subjectCount.set(d.type, (subjectCount.get(d.type) || 0) + 1);
      }
    }
  }
  if (role === 'subject') {
    if (subjectCount.has('user')) return 'user';
    return [...subjectCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || types[0]?.name;
  }
  const withRelations = types.filter(t => (t.relations || []).length);
  return (withRelations.find(t => t.name !== 'user') || withRelations[0] || types[0])?.name;
}

/**
 * Câble un combobox de relation intelligent : les options affichées
 * dépendent du type d'objet (ou user) sélectionné à côté. Au clic sur
 * le bouton "↕" (toggle), l'utilisateur peut basculer entre :
 *   - mode filtré : seulement les relations définies sur le type ciblé
 *   - mode complet : toutes les relations du modèle
 *
 * Le combobox utilise un <input> + <datalist> pour bénéficier de
 * l'auto-complétion native du navigateur (saisie libre possible).
 */
function wireRelationFilter(typeSelId, inputId, listId, hintId, toggleId) {
  const typeSel = $(typeSelId);
  const input = $(inputId);
  const dl = $(listId);
  const hint = $(hintId);
  const toggle = $(toggleId);
  if (!typeSel || !input || !dl || !hint) return;
  const model = state.storeModel;

  // État local : "filtered" (par type) ou "all" (toutes).
  let mode = 'filtered';
  // Cache : relations du type sélectionné (mode filtered).
  let filteredRels = [];
  // Cache : toutes les relations (mode all).
  let allRels = (() => {
    if (!model) return [];
    const s = new Set();
    for (const t of model.types || []) {
      for (const r of t.relations || []) s.add(r.name);
    }
    return [...s].sort();
  })();

  const update = () => {
    const t = typeSel.value;
    if (mode === 'all' || !t) {
      filteredRels = [];
      dl.innerHTML = allRels.map(r => `<option value="${escapeHtml(r)}">`).join('');
      hint.textContent = allRels.length
        ? `${allRels.length} relations au total dans le modèle.`
        : 'Aucune relation dans le modèle.';
    } else {
      // On récupère les relations du type ciblé.
      const tdef = (model?.types || []).find(x => x.name === t);
      filteredRels = (tdef?.relations || []).map(r => r.name).sort();
      dl.innerHTML = filteredRels.map(r => `<option value="${escapeHtml(r)}">`).join('');
      if (filteredRels.length === 0) {
        hint.innerHTML = `Le type <code>${escapeHtml(t)}</code> n'a aucune relation directe. ` +
          `<button type="button" class="audit-link-btn" data-rel-toggle="all">Voir toutes les relations</button>`;
        hint.querySelector('[data-rel-toggle="all"]')?.addEventListener('click', () => {
          mode = 'all';
          if (toggle) toggle.classList.add('active');
          update();
        });
      } else {
        hint.textContent = `${filteredRels.length} relation${filteredRels.length > 1 ? 's' : ''} sur "${t}".`;
      }
    }
    if (toggle) {
      const onFiltered = (mode === 'filtered' && t);
      toggle.classList.toggle('active', !onFiltered);
      toggle.title = onFiltered
        ? 'Voir toutes les relations (tous types)'
        : 'Filtrer par type sélectionné';
    }
    hint.style.color = filteredRels.length === 0
      ? 'var(--text-tertiary)'
      : 'var(--text-secondary)';
  };

  typeSel.addEventListener('change', update);
  if (toggle) {
    toggle.addEventListener('click', () => {
      mode = mode === 'filtered' ? 'all' : 'filtered';
      toggle.classList.toggle('active', mode === 'all');
      update();
    });
  }
  update();
}

/**
 * Câble un sélecteur de type + input ID + datalist + hint, façon
 * manage-tuple. À chaque changement de type, on filtre la liste
 * d'IDs existants (depuis state.tuples) pour ne proposer que ceux
 * du type sélectionné.
 *
 * @param {'user'|'object'} side  côté : "user" (membre des tuples) ou
 *                               "object" (cible des tuples)
 */
function wireTypeFilter(typeSelId, inputId, datalistId, hintId, side) {
  const typeSel = $(typeSelId);
  const input = $(inputId);
  const dl = $(datalistId);
  const hint = $(hintId);
  if (!typeSel || !input || !dl || !hint) return;

  const update = () => {
    const t = typeSel.value;
    if (!t) { hint.textContent = ''; dl.innerHTML = ''; return; }
    // On récupère tous les IDs du côté demandé (user / object) qui
    // matchent le type sélectionné.
    const ids = new Set();
    for (const tuple of state.tuples || []) {
      const ref = side === 'user' ? tuple.user : tuple.object;
      const refBase = ref.split('#')[0];
      const colonIdx = refBase.indexOf(':');
      if (colonIdx < 0) continue;
      const type = refBase.slice(0, colonIdx);
      const id = refBase.slice(colonIdx + 1);
      if (type === t && id) ids.add(id);
    }
    const arr = [...ids].sort();
    dl.innerHTML = arr.map(id => `<option value="${escapeHtml(id)}">`).join('');
    if (arr.length === 0) {
      hint.textContent = `Aucun ${side} de type "${t}" dans les tuples. Tapez un id libre.`;
      hint.style.color = 'var(--text-tertiary)';
    } else {
      hint.textContent = `${arr.length} ${side} de type "${t}" existant${arr.length > 1 ? 's' : ''}.`;
      hint.style.color = 'var(--text-secondary)';
    }
  };

  typeSel.addEventListener('change', update);
  // Si l'input change et que l'ID tapé matche un ID suggéré, on ne fait
  // rien. Sinon on autorise la saisie libre.
  update();
}