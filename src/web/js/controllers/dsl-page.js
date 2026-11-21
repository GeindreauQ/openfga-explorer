// controllers/dsl-page.js — Page Admin DSL (éditeur + graphe).
//
// Affiche la page DSL avec split-pane, header (Apply/Reset/Help), tour
// au premier chargement, format toggle DSL/JSON. S'appuie sur les
// modules views/dsl-editor, views/dsl-graph/index.js, etc.

import { $ } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { toast } from '../lib/toast.js';
import { connection } from '../config.js';
import { csrfHeader, fetchDSL, fetchModelVersion, fetchModelVersions, applyDSL as applyDSLApi } from '../lib/api.js';
import { parseJSONModel, serializeDSL, parseDSL, toOpenFGAJSON, checkDSL } from '../models/dsl.js';
import { setActiveStoreModel } from '../models/types.js';
import { setStoreModel } from '../lib/state.js';
import { isGraphActive, destroyGraph } from '../views/graph.js';
import * as dslEditor from '../views/dsl-editor.js';
import * as dslGraph from '../views/dsl-graph/index.js';

let _dslPageInitialized = false;
let _dslCurrentFormat = 'dsl';
let _dslDefaultText = '';
// Dernier modèle parsé avec des types non-vides. Sert de filet de
// sécurité dans le onChange : si le parse courant échoue (typiquement
// après un switch de format qui produit un texte invalide — voir
// @openfga/syntax-transformer qui sérialise mal certains computed
// usersets), on garde le graphe sur ce modèle au lieu de le vider.
let _lastValidParsed = null;

/** Affiche la page Admin DSL. */
export async function showDSLPage() {
  document.body.classList.remove('home-shown');
  $('home-dashboard')?.setAttribute('hidden', '');
  document.body.classList.remove('dsl-shown', 'audit-shown', 'io-shown');
  // Cache toutes les autres pages plein écran (audit, io) pour éviter
  // qu'elles restent visibles en arrière-plan.
  for (const id of ['dsl-page', 'audit-page', 'io-page']) {
    $(id)?.setAttribute('hidden', '');
  }
  document.body.classList.add('dsl-shown');
  $('dsl-page')?.removeAttribute('hidden');

  if (isGraphActive()) destroyGraph();

  const editorContainer = $('dsl-pane-editor');
  const graphContainer = $('dsl-pane-graph');

  if (!_dslPageInitialized) {
    _dslPageInitialized = true;

    // Important : initialiser dslGraph AVANT dslEditor. L'init de
    // dslEditor déclenche immédiatement un `saveAndValidate` (donc un
    // onChange → dslGraph.setData). Si le graphe n'est pas encore init,
    // `_svg` est null et `layoutAndRender` crash. En initialisant le
    // graphe d'abord, on garantit que `_svg` est set avant le premier
    // render.
    dslGraph.init(graphContainer, {
      onNodeClick: () => {},
      onAddRelation: (node, mode) => openDSLRelationModal(node.id, mode),
      onRelationClick: (relName) => openDSLEditRelationModal(relName),
    });

dslEditor.init(editorContainer, {
      initialText: '',
      onChange: (text, { types, errors }) => {
        updateDSLStatus(types.length, errors);
        let parsed = checkDSL(text).parsed;
        // Mémorise le dernier modèle valide. Si le parse courant
        // échoue (texte vide, JSON tronqué, ou — cas du bug —
        // sérialisation DSL invalide produite par un switch de
        // format), on garde le graphe sur ce modèle plutôt que de
        // l'effacer.
        if (parsed.types && parsed.types.length > 0) {
          _lastValidParsed = parsed;
        } else if (_lastValidParsed && _lastValidParsed.types?.length > 0) {
          parsed = _lastValidParsed;
        }
        dslGraph.setData(parsed);
        scheduleLint(parsed);
      },
    });

    initDSLResizer();
    wireDSLHeader();
  }

  // La visite s'affiche avec la page, pas après le chargement du modèle :
  // une fenêtre qui surgit en différé intercepte le clic en cours.
  let seen = false;
  try { seen = !!localStorage.getItem('openfga-explorer:dsl-tour-seen'); } catch {}
  if (!seen) $('dsl-tour')?.removeAttribute('hidden');

  await loadDSL();
}

function wireDSLHeader() {
  $('dsl-apply')?.addEventListener('click', applyDSL);
  $('dsl-reset')?.addEventListener('click', async () => {
    if (!confirm('Réinitialiser le DSL ? Vos modifications locales seront perdues.')) return;
    try {
      const parsed = await fetchDSL();
      const errors = parsed.errors || [];
      if (errors.length) {
        toast('Modèle du store invalide : ' + errors[0].message, true);
        return;
      }
      _dslDefaultText = serializeDSL(parsed);
      dslEditor.setValue(_dslDefaultText);
      toast('DSL réinitialisé depuis le store.');
    } catch (e) {
      // 404 = store sans authorization model, pas une vraie erreur.
      if (e.message.startsWith('HTTP 404')) {
        _dslDefaultText = '# DSL non disponible\n';
        dslEditor.setValue(_dslDefaultText);
        toast('Store sans authorization model — éditeur vide.');
      } else {
        toast('Erreur : ' + e.message, true);
      }
    }
  });
  $('dsl-help')?.addEventListener('click', () => {
    $('dsl-tour')?.removeAttribute('hidden');
  });
  $('dsl-tour-close')?.addEventListener('click', () => {
    $('dsl-tour')?.setAttribute('hidden', '');
    try { localStorage.setItem('openfga-explorer:dsl-tour-seen', '1'); } catch {}
  });
  const historyBtn = document.getElementById('btn-dsl-history');
  if (historyBtn) historyBtn.addEventListener('click', openHistoryModal);
  const historyClose = document.getElementById('btn-close-history');
  if (historyClose) historyClose.addEventListener('click', closeHistoryModal);
  const historyBackdrop = document.getElementById('history-backdrop');
  if (historyBackdrop) {
    historyBackdrop.addEventListener('click', (e) => {
      if (e.target === historyBackdrop) closeHistoryModal();
    });
  }
  document.querySelectorAll('.dsl-fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fmt = btn.getAttribute('data-fmt');
      if (fmt === _dslCurrentFormat) return;
      switchDSLFormat(fmt);
    });
  });
}

function switchDSLFormat(toFmt) {
  const cur = dslEditor.getValue();
  let newText = '';
  try {
    if (_dslCurrentFormat === 'dsl' && toFmt === 'json') {
      newText = dslToJSON(cur);
    } else if (_dslCurrentFormat === 'json' && toFmt === 'dsl') {
      newText = jsonToDSL(cur);
    } else {
      return;
    }
  } catch (e) {
    toast('Conversion impossible : ' + e.message, true);
    return;
  }
  _dslCurrentFormat = toFmt;
  dslEditor.setValue(newText);
  document.querySelectorAll('.dsl-fmt-btn').forEach(btn => {
    const isActive = btn.getAttribute('data-fmt') === toFmt;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
}

function dslToJSON(text) {
  const { parsed } = checkDSL(text);
  return JSON.stringify(toOpenFGAJSON(parsed), null, 2) + '\n';
}

function jsonToDSL(text) {
  const parsed = parseJSONModel(text);
  if ((parsed.errors || []).length) {
    throw new Error(parsed.errors[0].message || 'JSON invalide');
  }
  return sanitizeTransformedDSL(serializeDSL(parsed));
}

// Le sérialiseur @openfga/syntax-transformer produit des artefacts
// `[] or X`, `X or []`, `[] and X`, `X and []`, `X but not []`,
// `[] but not X` quand `directly_related_user_types` est vide pour
// une composante `this` dans une relation composite (union/intersection/
// difference). Le parser DSL officiel rejette `[]` comme expression
// seule → le switch JSON→DSL échoue silencieusement (graphe vide).
//
// On nettoie en post-traitement, en respectant l'algèbre booléenne :
//   - `A or []`  / `[] or A` → `A`     (true OR A = A)
//   - `A and []` / `[] and A` → `[]`    (true AND A = A ; mais ici
//                                         `[]` côté this = false →
//                                         court-circuit à `[]`)
//   - `A but not []`           → `A`     (A AND NOT false = A)
//   - `[] but not A`           → `[]`    (false AND NOT A = false)
//
// On matche UNIQUEMENT `[]` (crochets vides), jamais `[user]` qui
// est une liste valide.
function sanitizeTransformedDSL(text) {
  return text
    // A or []  / [] or A
    .replace(/\s*or\s+\[\s*\]\s*$/gm, '')
    .replace(/\[\s*\]\s+or\s+/g, '')
    // A and []
    .replace(/\s+and\s+\[\s*\]\s*$/gm, ' []')
    .replace(/\[\s*\]\s+and\s+/g, '[] ')
    // A but not []
    .replace(/\s+but\s+not\s+\[\s*\]\s*$/gm, '')
    // [] but not A
    .replace(/\[\s*\]\s+but\s+not\s+/g, '[] ');
}

async function applyDSL() {
  const text = dslEditor.getValue();
  const btn = $('dsl-apply');
  if (!text || !text.trim()) {
    toast('DSL vide.', true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Application…';
  }
  try {
    const data = await applyDSLApi(text);
    toast(`Modèle appliqué (id ${data.authorization_model_id?.slice(-8) || '?'}, ${data.types} types, schema ${data.schema_version}).`);
  } catch (e) {
    toast('Erreur : ' + (e.message || ''), true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-cloud-upload" aria-hidden="true"></i> Apply';
    }
  }
}

function updateDSLStatus(typeCount, errors) {
  const count = $('dsl-type-count');
  if (count) count.textContent = `(${typeCount} type${typeCount !== 1 ? 's' : ''})`;

  const statusIcon = document.querySelector('#dsl-status i');
  const statusText = $('dsl-status-text');
  if (statusIcon && statusText) {
    if (errors.length === 0 && typeCount > 0) {
      statusIcon.className = 'ti ti-check';
      statusText.textContent = `OK · ${typeCount} type${typeCount !== 1 ? 's' : ''} · 0 erreur`;
      $('dsl-status')?.classList.add('ok');
      $('dsl-status')?.classList.remove('error');
    } else if (errors.length > 0) {
      statusIcon.className = 'ti ti-alert-triangle';
      statusText.textContent = `${typeCount} type${typeCount !== 1 ? 's' : ''}, ${errors.length} erreur${errors.length > 1 ? 's' : ''}`;
      $('dsl-status')?.classList.remove('ok');
      $('dsl-status')?.classList.add('error');
    } else {
      statusIcon.className = 'ti ti-check';
      statusText.textContent = '—';
      $('dsl-status')?.classList.remove('ok', 'error');
    }
  }
}

/**
 * Charge le DSL depuis /api/dsl (introspection OpenFGA), met à jour
 * l'éditeur et synchronise le modèle actif.
 */
export async function loadDSL() {
  let text = '';
  let parsedModel = null;
  let displayFormat = 'dsl'; // 'dsl' ou 'json' (fallback si serializeDSL roundtrip foire)
  try {
    const res = await fetch('/api/dsl');
    if (res.ok) {
      const jsonText = await res.text();
      // Extract authorization model ID from the raw response
      try {
        const raw = JSON.parse(jsonText);
        state.authorizationModelId = raw.id || null;
      } catch {}
      try {
        const parsed = parseJSONModel(jsonText);
        if (parsed.errors?.length) {
          console.warn('loadDSL: modèle du store invalide', parsed.errors);
        } else {
          parsedModel = parsed;
          // On tente le roundtrip DSL → re-parse pour valider. Si le
          // sérialiseur upstream produit un DSL invalide (ex: certains
          // modèles lakekeeper avec computed usersets exotiques), on
          // retombe sur le format JSON pour l'affichage dans l'éditeur.
          // L'utilisateur peut toujours voir et modifier le modèle.
          try {
            text = serializeDSL(parsed);
            const { checkDSL } = await import('../models/dsl.js');
            const reCheck = checkDSL(text);
            if (!reCheck.ok || reCheck.parsed.types.length !== parsed.types.length) {
              throw new Error('roundtrip failed');
            }
          } catch (e) {
            console.warn('loadDSL: roundtrip DSL invalide, fallback JSON:', e.message);
            text = JSON.stringify(toOpenFGAJSON(parsed), null, 2) + '\n';
            displayFormat = 'json';
          }
        }
      } catch (e) {
        console.warn('loadDSL: parse du modèle du store a échoué', e);
      }
    } else if (res.status === 404) {
      console.info('loadDSL: store sans authorization model, éditeur vide');
    } else {
      console.warn(`loadDSL: → HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn('loadDSL: fetch a échoué', e);
  }
  if (!text) text = '# DSL non disponible\n';
  _dslDefaultText = text;
  // Synchronise le toggle DSL/JSON avec le format réellement affiché.
  // Si on a fallback en JSON, on bascule l'UI sur JSON.
  if (_dslCurrentFormat !== displayFormat && displayFormat === 'json') {
    _dslCurrentFormat = 'json';
    document.querySelectorAll('.dsl-fmt-btn').forEach(btn => {
      const isActive = btn.getAttribute('data-fmt') === 'json';
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
  }

  if (parsedModel) {
    setStoreModel(parsedModel);
    setActiveStoreModel(parsedModel);
    // Mémorise le modèle valide tout de suite : si l'utilisateur
    // bascule DSL/JSON immédiatement après le load et que la
    // conversion produit un texte non re-parsable, ce modèle sert
    // de fallback pour ne pas vider le graphe.
    _lastValidParsed = parsedModel;
  } else {
    setStoreModel(null);
    setActiveStoreModel(null);
  }

  if (_dslCurrentFormat === 'json' && displayFormat === 'dsl') {
    try { text = dslToJSON(text); } catch {}
  }
  dslEditor.setValue(text);
  if (connection.storeName) {
    toast(`DSL chargé depuis le store "${connection.storeName}"`, false);
  }
}

function openDSLEditModal(typeName) {
  const fullText = dslEditor.getValue();
  import('../views/dsl-edit-modal.js').then(({ open }) => {
    open({
      fullText,
      typeFocus: typeName,
      onSave: (newFullText) => {
        let text = newFullText;
        if (_dslCurrentFormat === 'json') {
          try { text = dslToJSON(text); } catch {}
        }
        dslEditor.setValue(text);
        toast(typeName ? `Type "${typeName}" mis à jour.` : 'DSL mis à jour.');
      },
    });
  });
}

function openDSLRelationModal(typeName, mode, editRel) {
  const fullText = dslEditor.getValue();
  const parsed = parseDSL(fullText);
  const allTypeNames = parsed.types.map(t => t.name);
  let relToEdit = editRel || null;
  if (mode === 'edit' && !relToEdit) {
    const t = parsed.types.find(x => x.name === typeName);
    if (t && t.relations.length > 0) relToEdit = t.relations[0].name;
  }
  import('../views/dsl-add-relation-modal.js').then(({ open }) => {
    open({
      typeName,
      fullText,
      allTypeNames,
      editRel: relToEdit,
      onSave: (newFullText) => {
        let text = newFullText;
        if (_dslCurrentFormat === 'json') {
          try { text = dslToJSON(text); } catch {}
        }
        dslEditor.setValue(text);
        toast(relToEdit ? `Relation "${relToEdit}" mise à jour.` : `Relation ajoutée à "${typeName}".`);
      },
    });
  });
}

// ── Lint sémantique ──────────────────────────────────────────────────
// On debounce pour éviter d'appeler /api/dsl/lint à chaque touche
// pendant la frappe (déjà lent via le parse complet du modèle).
let _lintTimer = null;
let _lintAbort = null;
function scheduleLint(parsedModel) {
  if (_lintTimer) clearTimeout(_lintTimer);
  if (_lintAbort) _lintAbort.abort();
  _lintTimer = setTimeout(() => runLint(parsedModel), 350);
}

async function runLint(parsedModel) {
  if (!parsedModel) {
    renderLintPanel([]);
    return;
  }
  if (_lintAbort) _lintAbort.abort();
  _lintAbort = new AbortController();
  try {
    const res = await fetch('/api/dsl/lint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ model: parsedModel }),
      signal: _lintAbort.signal,
    });
    if (!res.ok) {
      renderLintPanel([]);
      return;
    }
    const data = await res.json();
    renderLintPanel(data.warnings || []);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.warn('lint:', e);
    }
    renderLintPanel([]);
  }
}

function renderLintPanel(warnings) {
  const panel = $('dsl-lint-panel');
  if (!panel) return;
  const warns = warnings.filter(w => w.severity === 'warn');
  const infos = warnings.filter(w => w.severity === 'info');

  let html = '';
  if (warnings.length === 0) {
    html = `<div class="dsl-lint-empty">
      <i class="ti ti-shield-check" aria-hidden="true"></i>
      <span>Aucun problème détecté par le linter sémantique.</span>
    </div>`;
  } else {
    const items = warnings.map(w => {
      const icon = w.severity === 'warn' ? 'ti-alert-triangle' : 'ti-info-circle';
      const cls = w.severity === 'warn' ? 'warn' : 'info';
      const where = w.type
        ? `<code>${w.type}${w.relation ? '#' + w.relation : ''}</code>`
        : (w.cycle ? `<code>${w.cycle.join(' → ')}</code>` : '');
      return `<li class="dsl-lint-item ${cls}">
        <i class="ti ${icon}" aria-hidden="true"></i>
        <div>
          <span class="dsl-lint-message">${w.message}</span>
          ${where ? `<span class="dsl-lint-where">${where}</span>` : ''}
        </div>
      </li>`;
    }).join('');
    html = `
      <div class="dsl-lint-summary">
        <i class="ti ${warns.length > 0 ? 'ti-alert-triangle' : 'ti-info-circle'}" aria-hidden="true"></i>
        <span>
          ${warns.length} avertissement${warns.length > 1 ? 's' : ''}${infos.length > 0 ? `, ${infos.length} info` : ''}
        </span>
      </div>
      <ul class="dsl-lint-list">${items}</ul>
    `;
  }
  panel.innerHTML = html;
}

function initDSLResizer() {
  const resizer = $('dsl-resizer');
  const split = $('dsl-split');
  const left = $('dsl-pane-editor');
  if (!resizer || !split || !left) return;
  let dragging = false;
  let startX = 0;
  let startFlex = 0;

  resizer.addEventListener('mousedown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    const cs = window.getComputedStyle(left);
    const flex = cs.flex;
    const m = flex.match(/^(\d+)\s+(\d+)\s+(\d+)/);
    startFlex = m ? parseFloat(m[2]) : 1;
    document.body.style.cursor = 'col-resize';
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const dx = ev.clientX - startX;
    const delta = dx / rect.width;
    const newLeft = Math.max(0.2, Math.min(2, startFlex + delta * 2));
    const newRight = Math.max(0.2, 2 - newLeft);
    left.style.flex = `${newLeft} ${newLeft} 0`;
    const right = $('dsl-pane-graph');
    if (right) right.style.flex = `${newRight} ${newRight} 0`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; }
  });
}

// ── Model History Modal ──────────────────────────────────────────

async function openHistoryModal() {
  const backdrop = document.getElementById('history-backdrop');
  const body = document.getElementById('history-body');
  if (!backdrop || !body) return;
  // Affiche le backdrop via la classe `.open` (cf. CSS
  // `.modal-backdrop:not(.open) { display: none }`). Sans cette
  // classe, le modal reste invisible même après `removeAttribute('hidden')`.
  backdrop.classList.add('open');
  backdrop.removeAttribute('hidden');
  body.innerHTML = '<p class="hint">Chargement des versions…</p>';

  try {
    const versions = await fetchModelVersions();
    if (versions.length === 0) {
      body.innerHTML = '<p class="hint">Aucune version trouvée pour ce store.</p>';
      return;
    }
    let html = '<table class="history-table"><thead><tr><th>ID</th><th>Créé le</th><th>Schema</th><th>Actions</th></tr></thead><tbody>';
    for (const v of versions) {
      const id = v.id || '—';
      const shortId = id.length > 12 ? id.slice(-12) : id;
      const createdAt = v.created_at || '—';
      const schemaVer = v.schema_version || '—';
      html += `<tr>
        <td><code title="${esc(id)}">${esc(shortId)}</code></td>
        <td>${esc(createdAt)}</td>
        <td>${esc(schemaVer)}</td>
        <td class="history-actions">
          <button type="button" class="btn history-view-btn" data-id="${esc(id)}"><i class="ti ti-eye"></i> Voir</button>
          <button type="button" class="btn history-rollback-btn" data-requires-write data-id="${esc(id)}"><i class="ti ti-rotate"></i> Rollback</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
    body.innerHTML = html;

    body.querySelectorAll('.history-view-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        await viewVersion(id, body);
      });
    });
    body.querySelectorAll('.history-rollback-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm(`Appliquer la version ${id.slice(-12)} comme nouveau modèle ?`)) return;
        await rollbackToVersion(id);
        closeHistoryModal();
      });
    });
  } catch (e) {
    body.innerHTML = `<p class="hint hint-error">Erreur : ${esc(e.message)}</p>`;
  }
}

function closeHistoryModal() {
  const backdrop = document.getElementById('history-backdrop');
  if (backdrop) {
    backdrop.classList.remove('open');
    backdrop.setAttribute('hidden', '');
  }
}

async function viewVersion(id, body) {
  const detail = document.createElement('div');
  detail.className = 'history-detail';
  detail.innerHTML = '<p class="hint">Chargement…</p>';
  // Insert after the table
  const table = body.querySelector('table');
  if (table) table.after(detail);
  else body.appendChild(detail);

  let data;
  try {
    data = await fetchModelVersion(id);
  } catch (e) {
    detail.innerHTML = `<p class="hint hint-error">${esc(e.message)}</p>`;
    return;
  }
  // If we got JSON, try to format it
  if (data && data.type_definitions) {
      // Attempt to serialize to DSL
      try {
        const { rawModelToDSL } = await import('../models/dsl.js');
        const dsl = rawModelToDSL(data);
        detail.innerHTML = `<pre class="history-dsl">${esc(dsl)}</pre>`;
      } catch {
        detail.innerHTML = `<pre class="history-dsl">${esc(JSON.stringify(data, null, 2))}</pre>`;
      }
    } else {
      detail.innerHTML = `<pre class="history-dsl">${esc(JSON.stringify(data, null, 2))}</pre>`;
    }
}

async function rollbackToVersion(id) {
  let data;
  try {
    data = await fetchModelVersion(id);
  } catch (e) {
    toast('Erreur : ' + e.message, true);
    return;
  }

    // Apply it as the current model
    let text;
    try {
      const { rawModelToDSL } = await import('../models/dsl.js');
      text = rawModelToDSL(data);
    } catch {
      text = JSON.stringify(data, null, 2);
    }

    try {
      await applyDSLApi(text);
      toast(`Rollback effectué vers la version ${id.slice(-12)}`);
      // Reload the DSL editor
      await loadDSL();
    } catch (e) {
      toast('Rollback échoué : ' + e.message, true);
    }
}

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}