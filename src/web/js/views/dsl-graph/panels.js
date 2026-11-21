// views/dsl-graph/panels.js — Side panel (détail nœud) + edge panel
// (détail arête épinglée) + légende des types.
//
// Lit et mute `state.selectedNode` / `state.pinnedEdge` / `state.hoveredEdge`
// via les callbacks utilisateurs enregistrés dans init().

import { state, svgEl, escapeHtml, classifyRelation } from './state.js';
import { typeClass } from '../../lib/type-style.js';

// Couleur de fallback pour les types custom (sans entrée dans le thème).
/** Classe de couleurs d'un nœud (neutre pour un nœud sans type connu). */
function classFor(node) {
  return node && !node.custom ? typeClass(node.type) : 'type-neutral';
}

// ── Légende (types présents dans le graphe) ──────────────────────────────

export function renderLegend() {
  const legend = document.getElementById('dsl-legend');
  if (!legend) return;
  legend.innerHTML = '';
  // Déduplique par type.
  const typesSeen = new Map();
  for (const n of state.nodes) {
    if (typesSeen.has(n.type)) continue;
    typesSeen.set(n.type, classFor(n));
  }
  const sorted = [...typesSeen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [type, cls] of sorted) {
    const el = document.createElement('span');
    el.className = 'dsl-legend-item';
    el.title = type;
    el.innerHTML = `<span class="dsl-legend-dot type-dot ${cls}"></span> ${escapeHtml(type)}`;
    legend.appendChild(el);
  }
  const relEl = document.createElement('span');
  relEl.className = 'dsl-legend-item dsl-legend-rel';
  relEl.innerHTML = `<svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="14" y2="4" stroke="var(--text-secondary)" stroke-width="1.5" marker-end="url(#dsl-arrow-legend)"/></svg> relation`;
  legend.appendChild(relEl);
}

// ── Side panel (détail nœud sélectionné) ─────────────────────────────────

export function renderSidePanel() {
  if (!state.container) return;
  const panel = state.container.querySelector('#dsl-side-panel');
  if (!panel) return;
  const titleEl = state.container.querySelector('#dsl-side-title');
  const badgeEl = state.container.querySelector('#dsl-side-badge');
  const bodyEl = state.container.querySelector('#dsl-side-body');
  if (!titleEl || !badgeEl || !bodyEl) return;
  if (!state.selectedNode || !state.nodeById.has(state.selectedNode)) {
    panel.setAttribute('hidden', '');
    return;
  }
  const node = state.nodeById.get(state.selectedNode);

  // Arêtes entrantes et sortantes (sur les arêtes dédupliquées,
  // on liste les relations impliquées).
  const incoming = state.edges.filter(e => e.to === node.id);
  const outgoing = state.edges.filter(e => e.from === node.id);
  const defs = node.relations || [];

  panel.removeAttribute('hidden');
  titleEl.innerHTML = `<span class="dsl-side-dot type-dot ${classFor(node)}"></span> ${escapeHtml(node.id)}`;
  badgeEl.textContent = `${defs.length} définie${defs.length !== 1 ? 's' : ''}`;

  bodyEl.innerHTML = `
    <div class="dsl-side-section">
      <h4><i class="ti ti-arrow-down" aria-hidden="true"></i> Entrantes
        <span class="dsl-side-count">${incoming.length}</span></h4>
      <p class="dsl-side-help">Types qui définissent une relation vers <code>${escapeHtml(node.id)}</code>.</p>
      ${incoming.length ? `
        <ul class="dsl-side-list">
          ${incoming.map(e => `
            <li>
              <span class="dsl-side-source">${escapeHtml(e.from)}</span>
              <span class="dsl-side-arrow">→</span>
              <span class="dsl-side-rel-group">${e.relations.map(r => `<span class="dsl-side-rel">${escapeHtml(r)}</span>`).join(' ')}</span>
            </li>`).join('')}
        </ul>
      ` : `<p class="dsl-side-empty">Aucune relation entrante.</p>`}
    </div>

    <div class="dsl-side-section">
      <h4><i class="ti ti-arrow-up" aria-hidden="true"></i> Sortantes
        <span class="dsl-side-count">${outgoing.length}</span></h4>
      <p class="dsl-side-help">Relations définies par <code>${escapeHtml(node.id)}</code>.</p>
      ${outgoing.length ? `
        <ul class="dsl-side-list">
          ${outgoing.map(e => `
            <li>
              <span class="dsl-side-rel-group">${e.relations.map(r => `<span class="dsl-side-rel">${escapeHtml(r)}</span>`).join(' ')}</span>
              <span class="dsl-side-arrow">→</span>
              <span class="dsl-side-target">${escapeHtml(e.to)}</span>
            </li>`).join('')}
        </ul>
      ` : `<p class="dsl-side-empty">Aucune relation sortante.</p>`}
    </div>

    <div class="dsl-side-section">
      <h4><i class="ti ti-code" aria-hidden="true"></i> Définitions
        <span class="dsl-side-count">${defs.length}</span></h4>
      ${defs.length ? `
        <div class="dsl-side-defs">
          ${defs.map(d => `
            <div class="dsl-side-def">
              <div class="dsl-side-def-name">define <strong>${escapeHtml(d.name)}</strong></div>
              <div class="dsl-side-def-allowed">[${d.allowed.map(escapeHtml).join(', ')}]</div>
            </div>`).join('')}
        </div>
      ` : `<p class="dsl-side-empty">Aucune définition.</p>`}
    </div>

    <div class="dsl-side-actions">
      <button type="button" class="btn dsl-secondary" id="dsl-side-close" title="Fermer le panneau">
        <i class="ti ti-x" aria-hidden="true"></i> Fermer
      </button>
      <button type="button" class="btn dsl-secondary" id="dsl-side-edit" title="Éditer ce type dans le DSL">
        <i class="ti ti-edit" aria-hidden="true"></i> Éditer
      </button>
      <button type="button" class="btn dsl-primary" id="dsl-side-add" title="Ajouter une relation sur ce type">
        <i class="ti ti-plus" aria-hidden="true"></i> + Relation
      </button>
    </div>
  `;

  state.container.querySelector('#dsl-side-close')?.addEventListener('click', () => {
    state.selectedNode = null;
    renderSidePanel();
    // Note : render() est invoqué par l'orchestrateur via le callback
    // onSelectionChanged, mais ici on est dans un handler user-facing
    // donc on appelle render directement via la closure du module
    // parent (cf. import circulaire évité).
  });
  state.container.querySelector('#dsl-side-edit')?.addEventListener('click', () => {
    if (state.onAddRelation) state.onAddRelation(node, 'edit');
  });
  state.container.querySelector('#dsl-side-add')?.addEventListener('click', () => {
    if (state.onAddRelation) state.onAddRelation(node, 'add');
  });
}

// ── Edge panel (détail arête épinglée) ────────────────────────────────────

export function renderEdgePanel() {
  if (!state.container) return;
  const panel = state.container.querySelector('#dsl-edge-panel');
  if (!panel) return;
  const titleEl = state.container.querySelector('#dsl-edge-panel-title');
  const bodyEl = state.container.querySelector('#dsl-edge-panel-body');
  if (!titleEl || !bodyEl) return;
  if (!state.pinnedEdge || state.edges.length === 0) {
    panel.setAttribute('hidden', '');
    return;
  }
  const [from, to] = state.pinnedEdge.split('|');
  const edge = state.edges.find(e => e.from === from && e.to === to);
  if (!edge) { panel.setAttribute('hidden', ''); return; }
  const fromNode = state.nodeById.get(from);
  const toNode = state.nodeById.get(to);
  panel.removeAttribute('hidden');
  titleEl.innerHTML = `<span class="dsl-side-rel">${escapeHtml(from)} → ${escapeHtml(to)}</span>`;
  // Tableau des relations : 1 ligne par relation, avec ses
  // caractéristiques (type d'arête, style). Click sur une ligne =
  // navigation vers la relation dans l'éditeur.
  const relationRows = edge.relations.map(rel => {
    const meta = classifyRelation(rel);
    return `<tr data-rel="${escapeHtml(rel)}">
      <td class="dsl-edge-rel-name">${escapeHtml(rel)}</td>
      <td><span class="dsl-edge-pill ${meta.cls}">${meta.label}</span></td>
      <td><code class="dsl-edge-rel-style">${meta.style}</code></td>
    </tr>`;
  }).join('');
  bodyEl.innerHTML = `
    <div class="dsl-side-section">
      <h4><i class="ti ti-route" aria-hidden="true"></i> Trajet</h4>
      <div class="dsl-edge-journey">
        <span class="dsl-edge-node type-fill ${classFor(fromNode)}">${escapeHtml(from)}</span>
        <span class="dsl-edge-arrow">→</span>
        <span class="dsl-edge-arrow">→</span>
        <span class="dsl-edge-node type-fill ${classFor(toNode)}">${escapeHtml(to)}</span>
      </div>
    </div>
    <div class="dsl-side-section">
      <h4><i class="ti ti-key" aria-hidden="true"></i> Relations (${edge.relations.length})</h4>
      <table class="dsl-edge-table">
        <thead>
          <tr>
            <th>Relation</th>
            <th>Type</th>
            <th>Style</th>
          </tr>
        </thead>
        <tbody>${relationRows}</tbody>
      </table>
      <p class="hint">Cliquez une ligne pour éditer la relation dans l'éditeur DSL.</p>
    </div>`;
}