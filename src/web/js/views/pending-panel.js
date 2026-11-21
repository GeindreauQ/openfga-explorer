// views/pending-panel.js — Panneau "Modifications en attente".
//
// Staging area pour les tuples en attente de commit
// (state.pendingAdds + state.pendingRemoves). Permet de :
//   - voir chaque modification en attente (add / remove)
//   - retirer une modification (bouton X sur la ligne)
//   - commiter en bloc ("Appliquer")
//   - tout jeter ("Annuler")
//
// Pas d'analyse d'impact dans cette version (coûteuse en N×M appels
// Check). À faire dans une étape ultérieure si le besoin se fait sentir.

import { $, escapeHtml } from '../lib/dom.js';
import { state, removeFromPending, clearPending } from '../lib/state.js';
import { writeTuple, deleteTuples } from '../lib/api.js';
import { connection } from '../config.js';
import { toast } from '../lib/toast.js';
import { render } from './cards.js';

let _initialized = false;
let _committing = false;

/** Initialise le panneau (à appeler une fois au boot). */
export function initPendingPanel() {
  if (_initialized) return;
  _initialized = true;
  const panel = $('pending-panel');
  if (!panel) return;
  // Event delegation : les boutons sont générés dynamiquement.
  panel.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (_committing) return;
    const id = t.getAttribute('data-id');
    if (t.classList.contains('pending-remove')) {
      removeFromPending(id);
      renderPendingPanel();
    } else if (t.id === 'pending-apply') {
      applyPending();
    } else if (t.id === 'pending-discard') {
      clearPending();
      renderPendingPanel();
    } else if (t.id === 'pending-close') {
      setOpen(false);
    }
  });
  // Bouton toggle (pastille à droite) : rouvre le drawer quand fermé.
  $('pending-toggle')?.addEventListener('click', () => setOpen(true));
}

/** Ouvre ou ferme le drawer. */
function setOpen(open) {
  const panel = $('pending-panel');
  const toggle = $('pending-toggle');
  if (panel) panel.classList.toggle('open', open);
  if (toggle) toggle.classList.toggle('shown', !open);
}

/** Re-render le panneau. À appeler après chaque mutation de state.pending*. */
export function renderPendingPanel() {
  const panel = $('pending-panel');
  if (!panel) return;
  const adds = state.pendingAdds;
  const removes = state.pendingRemoves;
  const total = adds.length + removes.length;

  if (total === 0) {
    panel.classList.remove('open');
    setOpen(false);
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = renderPanelHTML(adds, removes, total);
  setOpen(true);
  // Met à jour le badge du toggle (pastille à droite).
  const toggle = $('pending-toggle');
  if (toggle) {
    const tb = toggle.querySelector('.pending-toggle-badge');
    if (tb) tb.textContent = total;
  }
}

function renderPanelHTML(adds, removes, total) {
  const closeBtn = _committing
    ? '<div class="pending-spinner"><i class="ti ti-loader"></i> Application…</div>'
    : '<button type="button" class="pending-close" id="pending-close" title="Fermer le panneau" aria-label="Fermer"><i class="ti ti-x"></i></button>';
  const applyIcon = _committing ? 'ti-loader' : 'ti-check';
  const applyLabel = _committing ? 'Application…' : 'Appliquer';
  const applyDisabled = _committing ? 'disabled' : '';
  const discardDisabled = _committing ? 'disabled' : '';

  const addsSection = adds.length > 0
    ? '<div class="pending-section">'
      + '<div class="pending-section-title">'
        + '<span class="pending-kind-badge add">+' + adds.length + '</span>'
        + '<span>Ajout' + (adds.length > 1 ? 's' : '') + '</span>'
      + '</div>'
      + '<ul class="pending-list">' + adds.map(p => pendingItemHTML(p, 'add')).join('') + '</ul>'
    + '</div>'
    : '';

  const removesSection = removes.length > 0
    ? '<div class="pending-section">'
      + '<div class="pending-section-title">'
        + '<span class="pending-kind-badge remove">−' + removes.length + '</span>'
        + '<span>Retrait' + (removes.length > 1 ? 's' : '') + '</span>'
      + '</div>'
      + '<ul class="pending-list">' + removes.map(p => pendingItemHTML(p, 'remove')).join('') + '</ul>'
    + '</div>'
    : '';

  return '<header class="pending-header">'
    + '<div class="pending-header-title">'
      + '<i class="ti ti-stack-2 pending-header-icon" aria-hidden="true"></i>'
      + '<h3>Modifications en attente</h3>'
      + '<span class="pending-count-badge">' + total + '</span>'
    + '</div>'
    + closeBtn
  + '</header>'
  + '<div class="pending-body">'
    + addsSection
    + removesSection
  + '</div>'
  + '<footer class="pending-footer">'
    + '<button type="button" class="btn btn-ghost" id="pending-discard" ' + discardDisabled + '>'
      + '<i class="ti ti-x" aria-hidden="true"></i> Annuler'
    + '</button>'
    + '<button type="button" class="btn primary" id="pending-apply" ' + applyDisabled + '>'
      + '<i class="ti ti-' + applyIcon + '" aria-hidden="true"></i> ' + applyLabel
    + '</button>'
  + '</footer>';
}

function pendingItemHTML(item, kind) {
  const t = item.tuple;
  const full = `${t.user} → ${t.relation} → ${t.object}`;
  return '<li class="pending-item pending-' + kind + '" title="' + escapeHtml(full) + '">'
    + '<span class="pending-kind-dot" aria-hidden="true"></span>'
    + '<span class="pending-tuple">'
      + '<span class="pending-side">' + escapeHtml(t.user) + '</span>'
      + '<span class="pending-arrow">→</span>'
      + '<span class="pending-rel">' + escapeHtml(t.relation) + '</span>'
      + '<span class="pending-arrow">→</span>'
      + '<span class="pending-side">' + escapeHtml(t.object) + '</span>'
    + '</span>'
    + '<button type="button" class="pending-remove" data-id="' + item.id + '" '
      + 'title="Retirer cette modification" aria-label="Retirer">'
      + '<i class="ti ti-x" aria-hidden="true"></i>'
    + '</button>'
  + '</li>';
}

/**
 * Applique les modifications en attente :
 *   - ajoute les pendingAdds via POST /api/tuples (en parallèle)
 *   - supprime les pendingRemoves via DELETE /api/tuples
 *   - refetch le store et vide le panneau
 *
 * Les erreurs individuelles sont toastées sans bloquer le commit
 * (un tuple qui échoue ne fait pas échouer les autres).
 */
async function applyPending() {
  if (!connection.configured) {
    toast('OpenFGA non configuré côté serveur', true);
    return;
  }
  if (state.pendingAdds.length === 0 && state.pendingRemoves.length === 0) return;

  _committing = true;
  renderPendingPanel();
  const addsCount = state.pendingAdds.length;
  const removesCount = state.pendingRemoves.length;
  const errors = [];

  try {
    if (state.pendingAdds.length > 0) {
      await Promise.all(state.pendingAdds.map(p =>
        writeTuple(p.tuple).catch(e => {
          errors.push(p.tuple.user + ' → ' + p.tuple.object + ' : ' + e.message);
        })
      ));
    }
    if (state.pendingRemoves.length > 0) {
      try {
        await deleteTuples(state.pendingRemoves.map(p => p.tuple));
      } catch (e) {
        errors.push('suppressions : ' + e.message);
      }
    }
    clearPending();
    const mod = await import('../controllers/store.js');
    await mod.loadFromAPI();
    renderPendingPanel();
    if (errors.length === 0) {
      toast('Modifications appliquées (' + addsCount + ' ajout' + (addsCount > 1 ? 's' : '') + ', ' + removesCount + ' retrait' + (removesCount > 1 ? 's' : '') + ').');
    } else {
      toast('Appliqué avec ' + errors.length + ' erreur(s) : ' + errors[0], true);
    }
  } catch (e) {
    toast("Échec de l'application : " + e.message, true);
  } finally {
    _committing = false;
    renderPendingPanel();
  }
}
