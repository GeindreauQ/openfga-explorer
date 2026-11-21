// Modale de détail d'un nœud : liste des tuples entrants/sortants et actions
// (ajouter une relation, supprimer un lien, supprimer le nœud).

import { $, escapeHtml, parseType } from '../lib/dom.js';
import { cfg, objectTypes } from '../models/types.js';
import { state, buildAllNodes } from '../lib/state.js';
import { connection } from '../config.js';
import { toast } from '../lib/toast.js';
import { render } from './cards.js';
import { renderPendingPanel } from './pending-panel.js';
import { typeClass } from '../lib/type-style.js';

// Injecté par main.js : ouverture du formulaire d'ajout pré-rempli.
let openAddTuple = () => {};
export function setOpenAddTuple(fn) { openAddTuple = fn; }

/** Ouvre la modale de détail pour un nœud. */
export function openModal(node) {
  state.currentModalNode = node;
  const c = cfg(node.type);
  $('modal-title').innerHTML = `
    <div class="node-icon node-icon-sm type-bg ${typeClass(node.type)}">
      <i class="ti ${c.icon}" aria-hidden="true"></i>
    </div>
    <span class="modal-node-raw">${escapeHtml(node.raw)}</span>
  `;

  // Actions : ajouter une relation impliquant ce nœud
  const isObjectType = objectTypes().includes(node.type);
  let html = '<div class="add-actions modal-actions" data-requires-write>';
  if (isObjectType) {
    html += `<button class="btn primary" data-action="add-object" title="Ce nœud reçoit une relation entrante">
      <i class="ti ti-plus" aria-hidden="true"></i> Ajouter un accès sur ce nœud
    </button>`;
  }
  html += `<button class="btn" data-action="add-user" title="Ce nœud devient sujet d'une relation">
    <i class="ti ti-arrow-up-right" aria-hidden="true"></i> Donner un accès à ce nœud
  </button>`;
  html += `<button class="btn danger" data-action="delete-node" title="Supprimer l'objet et tous ses liens">
    <i class="ti ti-trash-x" aria-hidden="true"></i> Supprimer cet objet
  </button>`;
  html += '</div>';

  html += renderTupleList(node, c);

  const body = $('modal-body');
  body.innerHTML = html;

  // Câblage des actions d'en-tête
  body.querySelector('[data-action="add-object"]')?.addEventListener('click', () => addRelationForNode('object'));
  body.querySelector('[data-action="add-user"]')?.addEventListener('click', () => addRelationForNode('user'));
  body.querySelector('[data-action="delete-node"]')?.addEventListener('click', () => deleteNode());

  // Câblage des boutons de suppression de lien (un par tuple)
  body.querySelectorAll('[data-del-tuple]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = JSON.parse(btn.getAttribute('data-del-tuple'));
      deleteTuple(t);
    });
  });

  $('modal-backdrop').classList.add('open');
}

// Construit le HTML des listes de tuples entrants/sortants.
function renderTupleList(node, c) {
  let html = '';
  const delBtn = t =>
    `<button class="tuple-del" data-requires-write title="Supprimer ce lien" data-del-tuple='${escapeHtml(JSON.stringify(t))}'>
      <i class="ti ti-trash" aria-hidden="true"></i>
    </button>`;

  if (node.incoming.length) {
    html += `<div class="section-label">Accès entrants (${node.incoming.length})</div>`;
    node.incoming.forEach(t => {
      html += `<div class="tuple-row">
        <span class="type-text ${typeClass(parseType(t.user))}">${escapeHtml(t.user)}</span>
        <span class="tuple-arrow">→</span>
        <span class="rel-badge type-fill ${typeClass(node.type)}">${escapeHtml(t.relation)}</span>
        <span class="tuple-arrow">→</span>
        <span>${escapeHtml(t.object)}</span>
        <span class="spacer"></span>
        ${delBtn(t)}
      </div>`;
    });
  }
  if (node.outgoing.length) {
    html += `<div class="section-label">Relations sortantes (${node.outgoing.length})</div>`;
    node.outgoing.forEach(t => {
      html += `<div class="tuple-row">
        <span>${escapeHtml(t.user)}</span>
        <span class="tuple-arrow">→</span>
        <span class="rel-badge type-fill ${typeClass(node.type)}">${escapeHtml(t.relation)}</span>
        <span class="tuple-arrow">→</span>
        <span class="type-text ${typeClass(parseType(t.object))}">${escapeHtml(t.object)}</span>
        <span class="spacer"></span>
        ${delBtn(t)}
      </div>`;
    });
  }
  if (!node.incoming.length && !node.outgoing.length) {
    html += '<p class="modal-empty">Aucun tuple associé.</p>';
  }
  return html;
}

/** Ferme la modale de détail. */
export function closeModal() {
  $('modal-backdrop').classList.remove('open');
}

/** Ferme la modale si le clic vise le fond. */
export function onBackdropClick(e) {
  if (e.target === $('modal-backdrop')) closeModal();
}

// Ouvre le formulaire d'ajout pré-rempli avec le nœud courant (objet ou sujet).
function addRelationForNode(role) {
  if (!state.currentModalNode) return;
  const ref = state.currentModalNode.raw;
  closeModal();
  if (role === 'object') openAddTuple({ object: ref });
  else openAddTuple({ user: ref });
}

// Supprime un lien (tuple). On l'ajoute aux modifications en attente
// plutôt que de pousser immédiatement : l'utilisateur confirme via le
// bouton "Appliquer" du drawer pending-panel.
async function deleteTuple(t) {
  const idx = state.tuples.findIndex(x => x.user === t.user && x.relation === t.relation && x.object === t.object);
  if (idx === -1) { toast('Lien introuvable', true); return; }

  if (!confirm(`Supprimer ce lien ?\n\n${t.user} → ${t.relation} → ${t.object}`)) return;

  // On retire le tuple du state local tout de suite (UX réactive) et
  // on l'ajoute au pending buffer pour commit groupé ultérieur.
  state.tuples.splice(idx, 1);
  state.pendingRemoves.push({
    tuple: t,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    addedAt: Date.now(),
  });
  renderPendingPanel();

  // Recalcule le nœud courant ; s'il n'a plus de tuple, ferme la modale
  const stillThere = state.currentModalNode &&
    buildAllNodes().find(n => n.raw === state.currentModalNode.raw);
  render();
  if (stillThere) openModal(stillThere);
  else closeModal();

  const total = state.pendingAdds.length + state.pendingRemoves.length;
  toast(`Suppression en attente (${total} en file).`);
}

// Supprime entièrement le nœud courant : tous ses liens entrants ET
// sortants. Idem deleteTuple : on ajoute tout au pending buffer.
async function deleteNode() {
  if (!state.currentModalNode) return;
  const raw = state.currentModalNode.raw;

  const related = state.tuples.filter(t =>
    t.object.split('#')[0] === raw || t.user.split('#')[0] === raw
  );
  if (related.length === 0) { toast('Aucun lien à supprimer', true); return; }

  const incoming = related.filter(t => t.object.split('#')[0] === raw).length;
  const outgoing = related.length - incoming;
  const warning =
    `⚠️ Supprimer définitivement l'objet « ${raw} » ?\n\n` +
    `Cela supprimera ${related.length} lien(s) :\n` +
    `  • ${incoming} accès entrant(s)\n` +
    `  • ${outgoing} relation(s) sortante(s)\n\n` +
    `Ces suppressions seront ajoutées aux modifications en attente.`;
  if (!confirm(warning)) return;

  // Retire tous les tuples liés du state local et les ajoute au buffer.
  const toRemove = new Set(related);
  state.tuples = state.tuples.filter(t => !toRemove.has(t));
  for (const t of related) {
    state.pendingRemoves.push({
      tuple: t,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${state.pendingRemoves.length}`,
      addedAt: Date.now(),
    });
  }
  renderPendingPanel();

  render();
  closeModal();
  const total = state.pendingAdds.length + state.pendingRemoves.length;
  toast(`${related.length} suppression(s) en attente (${total} en file).`);
}
