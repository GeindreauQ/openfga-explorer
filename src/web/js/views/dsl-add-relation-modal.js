// views/dsl-add-relation-modal.js — Constructeur visuel de relation.
//
// Réécriture v2 : on ne manipule plus une liste plate de strings
// `["user", "team#member"]` mais un AST d'expression
// (`{kind:'union', children:[...]}`, `{kind:'computed', relation:'x'}`,
// `{kind:'tupleToUserset', computed, tupleset}`, `{kind:'this',
// types:[...]}`, etc.). Cela permet de supporter toutes les formes du
// DSL OpenFGA officiel : `or`, `and`, `but not`, `X from Y`,
// `[user with <condition>]`, etc.
//
// UI : la modale présente un constructeur d'expression récursif.
// L'utilisateur peut empiler des nœuds :
//   - [+ this]   : ouvre un sélecteur de types directs + `with <cond>`
//   - [+ computed]  : référence à une autre relation du même type
//   - [+ from]   : `X from Y` (computed + tupleset)
//   - [+ or] / [+ and] / [+ but not] : opérateur binaire
// À chaque modif, le preview live affiche le `define ...: ...` qui sera
// généré.

import { parseDSL, validateDSL, serializeDSL } from '../models/dsl.js';

let _container = null;
let _typeName = null;
let _existingDef = null;
let _fullText = '';
let _allTypeNames = [];
let _allRelations = [];      // noms des relations existantes sur _typeName
let _allConditionNames = []; // noms des conditions définies globalement
let _onSave = null;
let _rootExpr = null;        // AST racine de l'expression en cours d'édition
let _ctx = null;             // refs vers les éléments DOM du constructeur

const PRESETS = ['user', 'user:*'];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Construit le texte `define X: ...` à partir de l'AST. On réutilise
 * le sérialiseur officiel (round-trip stable).
 */
function expressionToText(expr) {
  if (!expr) return '';
  // On triche : on sérialise un type factice contenant juste notre
  // expression, puis on extrait la ligne `define`.
  const fake = {
    schemaVersion: '1.1',
    types: [{ name: '_', relations: [{ name: '_', expression: expr, directTypes: [] }] }],
    conditions: [],
  };
  const text = serializeDSL(fake);
  const m = text.match(/define _:\s*(.+?)\n/);
  return m ? m[1].trim() : '';
}

/**
 * Rendu récursif d'une expression enÉditeur visuel.
 */
function renderEditor(expr, path) {
  if (!expr) {
    return `<div class="dsl-expr-empty">cliquez sur un opérateur ci-dessous pour commencer</div>`;
  }
  switch (expr.kind) {
    case 'this':
      return renderThis(expr, path);
    case 'computed':
      return renderComputed(expr, path);
    case 'tupleToUserset':
      return renderFrom(expr, path);
    case 'union':
      return renderBinary('or', expr, path);
    case 'intersection':
      return renderBinary('and', expr, path);
    case 'difference':
      return renderDifference(expr, path);
    default:
      return `<div class="dsl-expr-error">kind inconnu: ${escapeHtml(expr.kind)}</div>`;
  }
}

function renderThis(expr, path) {
  const types = expr.types || [];
  const chips = types.length
    ? types.map((dt, i) => renderDirectTypeChip(dt, [...path, 'types', i])).join('')
    : '<span class="dsl-expr-empty">aucun type</span>';
  return `
    <div class="dsl-expr-node dsl-expr-this">
      <div class="dsl-expr-node-head">
        <span class="dsl-expr-kw">this</span>
        <span class="dsl-expr-bracket">[</span>
        <button class="btn-mini" data-action="add-type" data-path="${path.join('.')}">+ type</button>
      </div>
      <div class="dsl-expr-types">${chips}</div>
      <span class="dsl-expr-bracket">]</span>
    </div>`;
}

function renderDirectTypeChip(dt, path) {
  let label;
  if (dt.wildcard) label = `${dt.type}:*`;
  else if (dt.relation) label = `${dt.type}#${dt.relation}`;
  else label = dt.type;
  if (dt.condition) label += ` with ${dt.condition}`;
  return `<span class="dsl-chip" data-path="${path.join('.')}">
    <span>${escapeHtml(label)}</span>
    <button class="dsl-chip-x" data-action="del-direct-type" data-path="${path.join('.')}" aria-label="Retirer">×</button>
  </span>`;
}

function renderComputed(expr, path) {
  return `<div class="dsl-expr-node dsl-expr-computed">
    <span class="dsl-expr-kw">computed</span>
    <select data-action="set-computed" data-path="${path.join('.')}">
      <option value="">— choisir —</option>
      ${_allRelations.map(r => `<option value="${escapeHtml(r)}" ${r === expr.relation ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
    </select>
    <button class="btn-mini" data-action="del-node" data-path="${path.join('.')}">×</button>
  </div>`;
}

function renderFrom(expr, path) {
  return `<div class="dsl-expr-node dsl-expr-from">
    <span class="dsl-expr-kw">computed</span>
    <select data-action="set-from-computed" data-path="${path.join('.')}">
      <option value="">— relation —</option>
      ${_allRelations.map(r => `<option value="${escapeHtml(r)}" ${r === expr.computed ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
    </select>
    <span class="dsl-expr-kw">from</span>
    <span class="dsl-expr-kw">tupleset</span>
    <select data-action="set-from-tupleset" data-path="${path.join('.')}">
      <option value="">— relation —</option>
      ${_allRelations.map(r => `<option value="${escapeHtml(r)}" ${r === expr.tupleset ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}
    </select>
    <button class="btn-mini" data-action="del-node" data-path="${path.join('.')}">×</button>
  </div>`;
}

function renderBinary(opLabel, expr, path) {
  const children = (expr.children || []).map((c, i) => {
    const cp = [...path, 'children', i];
    return `<li>${renderEditor(c, cp)}</li>`;
  }).join('');
  return `<div class="dsl-expr-node dsl-expr-binary">
    <div class="dsl-expr-node-head">
      <span class="dsl-expr-kw">${opLabel}</span>
      <button class="btn-mini" data-action="add-child" data-path="${path.join('.')}">+</button>
      <button class="btn-mini" data-action="del-node" data-path="${path.join('.')}">×</button>
    </div>
    <ul class="dsl-expr-children">${children}</ul>
  </div>`;
}

function renderDifference(expr, path) {
  return `<div class="dsl-expr-node dsl-expr-diff">
    <div class="dsl-expr-node-head">
      <span class="dsl-expr-kw">but not</span>
      <button class="btn-mini" data-action="del-node" data-path="${path.join('.')}">×</button>
    </div>
    <div class="dsl-expr-pair">
      <label>base:</label>
      ${renderEditor(expr.base, [...path, 'base'])}
    </div>
    <div class="dsl-expr-pair">
      <label>subtract:</label>
      ${renderEditor(expr.subtract, [...path, 'subtract'])}
    </div>
  </div>`;
}

/**
 * Mutateur générique : applique `mutator(ast)` à la sous-expression
 * désignée par `path` (séquence de clés/index). Retourne un nouvel
 * AST (ou `null` pour supprimer).
 */
function mutatePath(root, path, mutator) {
  if (path.length === 0) {
    return mutator(root);
  }
  // Clone superficiel.
  const out = Array.isArray(root) ? [...root] : { ...root };
  let cursor = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cursor[key];
    if (next == null) return root;
    const cloned = Array.isArray(next) ? [...next] : { ...next };
    cursor[key] = cloned;
    cursor = cloned;
  }
  const last = path[path.length - 1];
  cursor[last] = mutator(cursor[last]);
  return out;
}

/**
 * Met à jour le DOM après une mutation de `_rootExpr`.
 */
function rerender() {
  const html = renderEditor(_rootExpr, []);
  _ctx.editor.innerHTML = html;
  _ctx.editor.dataset.depth = '0';
  updatePreview();
}

/**
 * Met à jour le preview `define X: ...`.
 */
function updatePreview() {
  const relName = _ctx.nameInput.value.trim() || '___';
  const exprStr = expressionToText(_rootExpr);
  _ctx.previewRelName.textContent = relName;
  _ctx.previewList.textContent = exprStr || '(vide)';
}

/**
 * Handler principal des clics sur les boutons du constructeur.
 */
function handleAction(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const path = btn.dataset.path ? btn.dataset.path.split('.').map(s => /^\d+$/.test(s) ? parseInt(s, 10) : s) : [];
  switch (action) {
    case 'add-type':
      _rootExpr = mutatePath(_rootExpr, path, e => ({
        ...e,
        types: [...(e.types || []), { type: 'user' }],
      }));
      break;
    case 'del-direct-type':
      _rootExpr = mutatePath(_rootExpr, path.slice(0, -1), e => ({
        ...e,
        types: e.types.filter((_, i) => i !== path[path.length - 1]),
      }));
      break;
    case 'set-computed':
      _rootExpr = mutatePath(_rootExpr, path, e => ({ ...e, relation: btn.parentElement.querySelector('select').value }));
      break;
    case 'set-from-computed':
      _rootExpr = mutatePath(_rootExpr, path, e => ({ ...e, computed: btn.value }));
      break;
    case 'set-from-tupleset':
      _rootExpr = mutatePath(_rootExpr, path, e => ({ ...e, tupleset: btn.value }));
      break;
    case 'add-child':
      _rootExpr = mutatePath(_rootExpr, path, e => ({
        ...e,
        children: [...(e.children || []), { kind: 'this', types: [] }],
      }));
      break;
    case 'del-node':
      _rootExpr = null;
      break;
  }
  rerender();
}

function handleRootOp(kind) {
  if (_rootExpr && (_rootExpr.kind === 'union' || _rootExpr.kind === 'intersection' || _rootExpr.kind === 'difference')) {
    // On ajoute une nouvelle clause à l'opérateur existant.
    if (kind === 'or' || kind === 'and') {
      _rootExpr = { ..._rootExpr, children: [..._rootExpr.children, { kind: 'this', types: [] }] };
    }
    return rerender();
  }
  if (kind === 'this') { _rootExpr = { kind: 'this', types: [] }; return rerender(); }
  if (kind === 'computed') { _rootExpr = { kind: 'computed', relation: '' }; return rerender(); }
  if (kind === 'from') { _rootExpr = { kind: 'tupleToUserset', computed: '', tupleset: '' }; return rerender(); }
  if (kind === 'or' || kind === 'and') {
    _rootExpr = { kind: kind === 'or' ? 'union' : 'intersection', children: [_rootExpr || { kind: 'this', types: [] }, { kind: 'this', types: [] }] };
    return rerender();
  }
  if (kind === 'but not') {
    _rootExpr = { kind: 'difference', base: _rootExpr || { kind: 'this', types: [] }, subtract: { kind: 'this', types: [] } };
    return rerender();
  }
}

/**
 * Génère le texte `define X: <expr>` et l'insère dans `_fullText`,
 * en remplaçant la relation existante ou en l'ajoutant.
 */
function upsertRelation(fullText, typeName, relName, exprText) {
  const lines = fullText.split('\n');
  const startIdx = lines.findIndex(l => new RegExp(`^type\\s+${typeName}\\s*$`).test(l));
  if (startIdx < 0) {
    return fullText.trimEnd() + `\n\ntype ${typeName}\n  relations\n    define ${relName}: ${exprText}\n`;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^type\s+\w+\s*$/.test(lines[i])) { endIdx = i; break; }
  }
  const block = lines.slice(startIdx, endIdx);
  let relationsIdx = -1;
  for (let i = 0; i < block.length; i++) {
    if (/^(\s*)relations\s*$/.test(block[i])) { relationsIdx = i; break; }
  }
  let existingLine = -1;
  if (relationsIdx >= 0) {
    for (let i = relationsIdx + 1; i < block.length; i++) {
      if (new RegExp(`^\\s*define\\s+${relName}\\s*:`).test(block[i])) {
        existingLine = i;
        break;
      }
      if (/^type\s+/.test(block[i])) break;
    }
  }
  const newDefineLine = `    define ${relName}: ${exprText}`;
  if (existingLine >= 0) {
    block[existingLine] = newDefineLine;
  } else {
    if (relationsIdx < 0) {
      block.push('  relations');
      block.push(newDefineLine);
    } else {
      block.splice(relationsIdx + 1, 0, newDefineLine);
    }
  }
  return [...lines.slice(0, startIdx), ...block, ...lines.slice(endIdx)].join('\n');
}

/**
 * Charge l'AST d'une relation existante depuis le DSL parsé. Si la
 * relation est simple (`[user, ...]`), on reconstruit l'AST this ; si
 * elle est complexe (passthrough string), on essaie de re-parser.
 */
function loadExistingExpr(typeName, relName, fullText) {
  const parsed = parseDSL(fullText);
  const t = parsed.types.find(x => x.name === typeName);
  if (!t) return null;
  const r = t.relations.find(x => x.name === relName);
  if (r && r.expression) return r.expression;
  return null;
}

/**
 * Ouvre la modale.
 */
export function open({ typeName, fullText, allTypeNames, editRel, onSave }) {
  _container = document.getElementById('dsl-add-rel-modal');
  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'dsl-add-rel-modal';
    _container.className = 'dsl-add-rel-modal';
    _container.setAttribute('role', 'dialog');
    _container.setAttribute('aria-modal', 'true');
    document.body.appendChild(_container);
  }
  _typeName = typeName;
  _fullText = fullText || '';
  _allTypeNames = allTypeNames || [];
  _onSave = onSave || (() => {});

  // Charge les noms de relations existantes sur le type et les conditions
  // globales pour peupler les `<select>` du constructeur.
  const parsed = parseDSL(_fullText);
  const typeDef = parsed.types.find(t => t.name === typeName);
  _allRelations = typeDef ? typeDef.relations.map(r => r.name).filter(n => n !== editRel) : [];
  _allConditionNames = (parsed.conditions || []).map(c => c.name);

  _existingDef = editRel || null;
  _rootExpr = _existingDef
    ? (loadExistingExpr(typeName, _existingDef, _fullText) || { kind: 'this', types: [] })
    : { kind: 'this', types: [] };

  _container.innerHTML = `
    <div class="dsl-edit-overlay"></div>
    <div class="dsl-add-rel-content">
      <header class="dsl-edit-header">
        <h3>
          <i class="ti ti-${editRel ? 'edit' : 'plus'}" aria-hidden="true"></i>
          ${editRel ? `Éditer <code>${escapeHtml(editRel)}</code> sur <code>${escapeHtml(typeName)}</code>` : `Ajouter une relation à <code>${escapeHtml(typeName)}</code>`}
        </h3>
        <button class="icon-btn" id="dsl-add-rel-close" type="button" aria-label="Fermer">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </header>
      <div class="dsl-add-rel-body">
        <label class="dsl-add-rel-field">
          <span>Nom de la relation</span>
          <input type="text" id="dsl-rel-name" placeholder="ex: admin" autocomplete="off" />
          <small>Le nom doit commencer par une lettre et ne contenir que lettres/chiffres/_</small>
        </label>

        <div class="dsl-add-rel-field">
          <span>Expression</span>
          <div class="dsl-expr-toolbar">
            <button type="button" class="btn-mini" data-root-op="this">[ this ]</button>
            <button type="button" class="btn-mini" data-root-op="computed">computed</button>
            <button type="button" class="btn-mini" data-root-op="from">X from Y</button>
            <span class="dsl-expr-sep"></span>
            <button type="button" class="btn-mini" data-root-op="or">or</button>
            <button type="button" class="btn-mini" data-root-op="and">and</button>
            <button type="button" class="btn-mini" data-root-op="but not">but not</button>
            <span class="dsl-expr-sep"></span>
            <span class="dsl-expr-hint">
              Types :
              ${PRESETS.map(p => `<button type="button" class="chip-btn" data-quick-type="${escapeHtml(p)}" data-preset="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}
              ${_allTypeNames.filter(n => n !== typeName).slice(0, 8).map(n => `<button type="button" class="chip-btn" data-quick-type="${escapeHtml(n)}" data-preset="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('')}
            </span>
          </div>
          <div class="dsl-expr-canvas" id="dsl-rel-canvas"></div>
        </div>

        <div class="dsl-add-rel-preview">
          <span>Preview :</span>
          <pre id="dsl-rel-preview">define <span class="tok-rel-name"></span>: <span class="tok-rel-list"></span></pre>
        </div>

        <div class="dsl-add-rel-status" id="dsl-add-rel-status"></div>
      </div>
      <footer class="dsl-edit-actions">
        <button type="button" class="btn dsl-secondary" id="dsl-add-rel-cancel">Annuler</button>
        <button type="button" class="btn dsl-primary" id="dsl-add-rel-save">
          <i class="ti ti-check" aria-hidden="true"></i> Sauvegarder
        </button>
      </footer>
    </div>
  `;

  _ctx = {
    nameInput: _container.querySelector('#dsl-rel-name'),
    editor: _container.querySelector('#dsl-rel-canvas'),
    previewRelName: _container.querySelector('.tok-rel-name'),
    previewList: _container.querySelector('.tok-rel-list'),
  };
  _ctx.nameInput.value = editRel || '';
  _ctx.nameInput.addEventListener('input', updatePreview);
  _container.querySelectorAll('[data-root-op]').forEach(btn => {
    btn.addEventListener('click', () => handleRootOp(btn.dataset.rootOp));
  });
  _container.querySelectorAll('[data-quick-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.quickType;
      // Quick-add : on insère dans `this` racine ou on crée un `this`.
      let expr = _rootExpr;
      if (!expr || expr.kind !== 'this') {
        expr = { kind: 'this', types: [] };
      }
      const dt = { type: v };
      if (v.endsWith(':*')) { dt.type = v.slice(0, -2); dt.wildcard = true; }
      _rootExpr = { ...expr, types: [...(expr.types || []), dt] };
      rerender();
    });
  });
  _container.querySelector('#dsl-add-rel-close').addEventListener('click', close);
  _container.querySelector('#dsl-add-rel-cancel').addEventListener('click', close);
  _container.querySelector('.dsl-edit-overlay').addEventListener('click', close);
  _container.querySelector('#dsl-add-rel-save').addEventListener('click', save);

  // Délégation des clics sur le canvas.
  _ctx.editor.addEventListener('click', handleAction);
  _ctx.editor.addEventListener('change', handleAction);

  rerender();
  updatePreview();

  _container.removeAttribute('hidden');
  setTimeout(() => _container.classList.add('visible'), 10);
  setTimeout(() => _ctx.nameInput.focus(), 100);
}

function setStatus(msg, type = 'info') {
  const el = _container.querySelector('#dsl-add-rel-status');
  if (!el) return;
  if (!msg) {
    el.innerHTML = '';
    el.className = 'dsl-add-rel-status';
    return;
  }
  el.textContent = msg;
  el.className = `dsl-add-rel-status ${type}`;
}

function save() {
  const relName = _ctx.nameInput.value.trim();
  if (!relName) {
    setStatus('Le nom de la relation est requis.', 'error');
    return;
  }
  if (!/^[a-zA-Z_]\w*$/.test(relName)) {
    setStatus('Nom invalide. Commence par une lettre, puis lettres/chiffres/_', 'error');
    return;
  }
  if (!_rootExpr) {
    setStatus('L\'expression est vide.', 'error');
    return;
  }
  // Vérifie qu'on n'écrase pas une autre relation du même nom.
  const parsed = parseDSL(_fullText);
  const t = parsed.types.find(x => x.name === _typeName);
  if (t && !_existingDef && t.relations.some(r => r.name === relName)) {
    setStatus(`Une relation "${relName}" existe déjà sur ce type. Édite-la au lieu d'en créer une nouvelle.`, 'error');
    return;
  }
  const exprText = expressionToText(_rootExpr);
  const newText = upsertRelation(_fullText, _typeName, relName, exprText);
  // Valide le résultat complet.
  const after = parseDSL(newText);
  const errs = validateDSL(after);
  if (errs.length > 0) {
    setStatus(`DSL invalide après modif : ${errs[0]}`, 'error');
    return;
  }
  _onSave(newText);
  close();
}

export function close() {
  if (!_container) return;
  _container.classList.remove('visible');
  setTimeout(() => _container?.setAttribute('hidden', ''), 200);
  _onSave = null;
  _existingDef = null;
  _ctx = null;
  _rootExpr = null;
}