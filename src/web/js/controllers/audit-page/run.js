// controllers/audit-page/run.js — Handlers "Run" + rendu des résultats
// pour les 3 modes (Check, Reverse, Forward).
//
// Les fonctions `renderCheckResult`, `renderUsersResult`,
// `renderObjectsResult` sont exportées pour permettre aux tests de
// valider la sortie HTML isolément (pas de dépendance à un store).
//
// Dépendances : panel.js (zone résultats) + why.js (chemin de
// résolution) + lib/dom.

import { $, escapeHtml } from '../../lib/dom.js';
import { auditListObjects, auditListUsers } from '../../lib/api.js';
import { setResults, setResultsLoading } from './panel.js';
import { renderWhySection } from './why.js';

// ── Run handlers ────────────────────────────────────────────────────────

export async function runCheck() {
  const userType = $('audit-check-user-type')?.value.trim();
  const userId = $('audit-check-user')?.value.trim();
  const relation = $('audit-check-relation')?.value.trim();
  const objType = $('audit-check-object-type')?.value.trim();
  const objId = $('audit-check-object')?.value.trim();
  const ctxRaw = $('audit-check-context')?.value.trim();
  if (!userType || !userId || !relation || !objType || !objId) {
    setResults('<p class="audit-error">user, relation et object sont requis.</p>');
    return;
  }
  const user = `${userType}:${userId}`;
  const object = `${objType}:${objId}`;
  let ctx;
  if (ctxRaw) {
    try { ctx = JSON.parse(ctxRaw); } catch (e) {
      setResults(`<p class="audit-error">Context JSON invalide : ${escapeHtml(e.message)}</p>`);
      return;
    }
  }
  setResultsLoading('Check en cours…');
  try {
    // On lance check + expand en parallèle : le verdict (ALLOWED/DENIED)
    // et le chemin de résolution ("Pourquoi ?") sont les deux faces
    // d'une même question — l'utilisateur s'attend à les voir
    // ensemble, sans avoir à refaire un second appel.
    const [checkResp, expandResp] = await Promise.all([
      fetch('/api/audit/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, relation, object, context: ctx }),
      }),
      fetch('/api/audit/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, relation, object }),
      }),
    ]);
    const checkBody = await checkResp.json();
    if (!checkResp.ok) {
      setResults(`<p class="audit-error">${escapeHtml(checkBody.error || 'Erreur ' + checkResp.status)}</p>`);
      return;
    }
    // L'expand peut légitimement échouer (ex: modèle sans
    // authorization_model_id, store mal configuré). On tolère et on
    // affiche uniquement le verdict dans ce cas.
    let expandBody = null;
    if (expandResp.ok) {
      try { expandBody = await expandResp.json(); } catch (_) { /* noop */ }
    }
    setResults(
      renderCheckResult(checkBody) +
      renderWhySection(expandBody, { user, relation, object })
    );
  } catch (e) {
    setResults(`<p class="audit-error">${escapeHtml(e.message)}</p>`);
  }
}

export async function runReverse() {
  const objType = $('audit-rev-object-type')?.value.trim();
  const objId = $('audit-rev-object')?.value.trim();
  const relation = $('audit-rev-relation')?.value.trim();
  const userType = $('audit-rev-usertype')?.value.trim();
  const ctxRaw = $('audit-rev-context')?.value.trim();
  if (!objType || !objId || !relation || !userType) {
    setResults('<p class="audit-error">object, relation et user_type sont requis.</p>');
    return;
  }
  const object = `${objType}:${objId}`;
  let ctx;
  if (ctxRaw) {
    try { ctx = JSON.parse(ctxRaw); } catch (e) {
      setResults('<p class="audit-error">Context JSON invalide</p>');
      return;
    }
  }
  setResultsLoading('ListUsers en cours…');
  try {
    const body = await auditListUsers({ object, relation, user_type: userType, context: ctx });
    setResults(renderUsersResult(body, { object, relation }));
  } catch (e) {
    setResults(`<p class="audit-error">${escapeHtml(e.message)}</p>`);
  }
}

export async function runForward() {
  const userType = $('audit-fwd-user-type')?.value.trim();
  const userId = $('audit-fwd-user')?.value.trim();
  const relation = $('audit-fwd-relation')?.value.trim();
  const type = $('audit-fwd-type')?.value.trim();
  const ctxRaw = $('audit-fwd-context')?.value.trim();
  if (!userType || !userId || !relation || !type) {
    setResults('<p class="audit-error">user, relation et type sont requis.</p>');
    return;
  }
  const user = `${userType}:${userId}`;
  let ctx;
  if (ctxRaw) {
    try { ctx = JSON.parse(ctxRaw); } catch (e) {
      setResults('<p class="audit-error">Context JSON invalide</p>');
      return;
    }
  }
  setResultsLoading('ListObjects en cours…');
  try {
    const body = await auditListObjects({ user, relation, type, context: ctx });
    setResults(renderObjectsResult(body, { user, relation }));
  } catch (e) {
    setResults(`<p class="audit-error">${escapeHtml(e.message)}</p>`);
  }
}

// ── Renderers de résultats (HTML) ───────────────────────────────────────

export function renderCheckResult(body) {
  const allowed = body.allowed;
  const cardClass = allowed ? 'audit-results-ok' : 'audit-results-warn';
  const icon = allowed ? 'ti-check' : 'ti-x';
  const verdict = allowed ? 'ALLOWED' : 'DENIED';
  const t = body.tuple || {};
  return `
    <div class="audit-results-card ${cardClass}">
      <i class="ti ${icon}" aria-hidden="true"></i>
      <div>
        <strong>${verdict}</strong>
        <p>
          <span class="audit-tree-leaf audit-tree-target">
            <span class="audit-tree-subject">${escapeHtml(t.user)}</span>
            <span class="audit-tree-arrow">→</span>
            <span class="audit-tree-rel">${escapeHtml(t.relation)}</span>
            <span class="audit-tree-arrow">→</span>
            <span class="audit-tree-object">${escapeHtml(t.object)}</span>
          </span>
        </p>
      </div>
    </div>
  `;
}

export function renderUsersResult(body, { object, relation }) {
  const users = body.users || [];
  if (users.length === 0) {
    return `<p class="audit-empty">Aucun user de ce type n'a accès à l'objet avec cette relation.</p>`;
  }
  const items = users.map(u => {
    // On essaie d'extraire une ref "user" pour pouvoir appeler expand
    // dessus. Les wildcards (user:*) ne sont pas requêtables (pas
    // d'utilisateur concret) → on n'expose pas le bouton "Pourquoi ?"
    // pour eux.
    let userRef = null;
    let label = '';
    if (u.object) {
      userRef = `${u.object.type}:${u.object.id}`;
      label = `<code>${escapeHtml(userRef)}</code>`;
    } else if (u.userset) {
      const obj = u.userset.object || {};
      userRef = `${obj.type || '?'}:${obj.id || '?'}#${u.userset.relation || '?'}`;
      label = `<code>${escapeHtml(userRef)}</code> <span class="hint">userset</span>`;
    } else if (u.wildcard) {
      const obj = u.wildcard || {};
      label = `<code>${escapeHtml(obj.type || '?')}:*</code> <span class="hint">wildcard</span>`;
    } else {
      label = `<code>${escapeHtml(JSON.stringify(u))}</code>`;
    }
    const whyBtn = userRef
      ? `<button type="button" class="audit-why-btn"
            data-why-user="${escapeHtml(userRef)}"
            data-why-relation="${escapeHtml(relation)}"
            data-why-object="${escapeHtml(object)}"
            title="Afficher le chemin de résolution pour cet accès">
          <i class="ti ti-help" aria-hidden="true"></i> Pourquoi ?
        </button>`
      : '';
    return `<li class="audit-list-item">
      <div class="audit-list-row">${label}${whyBtn}</div>
      <div class="audit-why-detail" hidden></div>
    </li>`;
  }).join('');
  return `<div class="audit-result-header">${body.count} user${body.count > 1 ? 's' : ''} trouvé${body.count > 1 ? 's' : ''}</div><ul class="audit-list">${items}</ul>`;
}

export function renderObjectsResult(body, { user, relation }) {
  const objects = body.objects || [];
  if (objects.length === 0) {
    return `<p class="audit-empty">Cet user n'a aucun accès à des objects de ce type via cette relation.</p>`;
  }
  const items = objects.map(o => {
    // Pour chaque object, on expose un bouton "Pourquoi ?" qui fetch
    // expand(user, relation, object) pour voir le chemin.
    const whyBtn = `<button type="button" class="audit-why-btn"
          data-why-user="${escapeHtml(user)}"
          data-why-relation="${escapeHtml(relation)}"
          data-why-object="${escapeHtml(o)}"
          title="Afficher le chemin de résolution pour cet accès">
        <i class="ti ti-help" aria-hidden="true"></i> Pourquoi ?
      </button>`;
    return `<li class="audit-list-item">
      <div class="audit-list-row"><code>${escapeHtml(o)}</code>${whyBtn}</div>
      <div class="audit-why-detail" hidden></div>
    </li>`;
  }).join('');
  return `<div class="audit-result-header">${body.count} object${body.count > 1 ? 's' : ''} trouvé${body.count > 1 ? 's' : ''}</div><ul class="audit-list">${items}</ul>`;
}