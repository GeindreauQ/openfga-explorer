// views/dsl-condition-modal.js — Constructeur de condition (CEL).
//
// Permet d'ajouter/éditer une `condition name(p1: t1, ...) { expr }`.
// Types de paramètres supportés (sous forme courte + TYPE_NAME_*) :
//   int, uint, double, bool, string, bytes, timestamp, duration,
//   ipaddress, any, list<T>, map<T>.

import { parseDSL, serializeDSL } from '../models/dsl.js';

let _container = null;
let _fullText = '';
let _editingName = null;     // nom en cours d'édition (null = nouvelle)
let _condition = null;       // AST local de la condition en cours d'édition
let _onSave = null;
let _ctx = null;

const PARAM_TYPES = [
  'int', 'uint', 'double', 'bool', 'string', 'bytes',
  'timestamp', 'duration', 'ipaddress', 'any',
  'list<string>', 'list<int>', 'list<timestamp>', 'list<duration>',
  'map<string>', 'map<int>',
];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function defaultCondition() {
  return {
    name: '',
    parameters: [{ name: '', type: 'timestamp' }],
    expression: '',
  };
}

function render() {
  const c = _condition;
  _ctx.params.innerHTML = c.parameters.map((p, i) => `
    <li class="dsl-cond-param">
      <input type="text" class="dsl-cond-param-name" data-param-idx="${i}" placeholder="nom" value="${escapeHtml(p.name)}" />
      <select class="dsl-cond-param-type" data-param-idx="${i}">
        ${PARAM_TYPES.map(t => `<option value="${escapeHtml(t)}" ${t === p.type ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
      </select>
      <button type="button" class="dsl-chip-x" data-action="del-param" data-param-idx="${i}" aria-label="Retirer">×</button>
    </li>
  `).join('');
  _ctx.name.value = c.name;
  _ctx.expr.value = c.expression;
  updatePreview();
}

function updatePreview() {
  const c = _condition;
  const params = c.parameters.filter(p => p.name).map(p => `${p.name}: ${p.type}`).join(', ');
  const expr = c.expression.trim() || '<expr>';
  _ctx.preview.textContent = `condition ${c.name || '___'}(${params}) {\n  ${expr}\n}`;
}

function sync() {
  _condition.name = _ctx.name.value.trim();
  _condition.expression = _ctx.expr.value;
  updatePreview();
}

function loadFromFullText(name) {
  const parsed = parseDSL(_fullText);
  const c = (parsed.conditions || []).find(c => c.name === name);
  if (!c) return null;
  return JSON.parse(JSON.stringify(c));
}

/**
 * Insère ou remplace une condition dans le texte DSL complet.
 */
function upsertCondition(fullText, cond) {
  const block = `condition ${cond.name}(${cond.parameters.filter(p => p.name).map(p => `${p.name}: ${p.type}`).join(', ')}) {\n  ${cond.expression}\n}`;
  const lines = fullText.split('\n');
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^condition\s+([a-zA-Z_]\w*)\s*\(/);
    if (m && m[1] === cond.name) { idx = i; break; }
  }
  if (idx >= 0) {
    // Remplace en cherchant l'accolade fermante.
    let depth = 0;
    let found = false;
    let endIdx = idx;
    for (let k = idx; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === '{') { depth++; found = true; }
        else if (ch === '}') { depth--; if (found && depth === 0) { endIdx = k; break; } }
      }
      if (found && depth === 0) { endIdx = k; break; }
    }
    return [...lines.slice(0, idx), ...block.split('\n'), ...lines.slice(endIdx + 1)].join('\n');
  }
  // Insère après le bloc `model ... schema ...`.
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^type\s/.test(lines[i])) { insertAt = i; break; }
    insertAt = i + 1;
  }
  return [...lines.slice(0, insertAt), '', ...block.split('\n'), '', ...lines.slice(insertAt)].join('\n');
}

export function open({ fullText, editName, onSave }) {
  _container = document.getElementById('dsl-cond-modal');
  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'dsl-cond-modal';
    _container.className = 'dsl-cond-modal';
    _container.setAttribute('role', 'dialog');
    _container.setAttribute('aria-modal', 'true');
    document.body.appendChild(_container);
  }
  _fullText = fullText || '';
  _editingName = editName || null;
  _onSave = onSave || (() => {});
  _condition = editName ? (loadFromFullText(editName) || defaultCondition()) : defaultCondition();

  _container.innerHTML = `
    <div class="dsl-edit-overlay"></div>
    <div class="dsl-cond-content">
      <header class="dsl-edit-header">
        <h3>
          <i class="ti ti-${editName ? 'edit' : 'plus'}" aria-hidden="true"></i>
          ${editName ? `Éditer la condition <code>${escapeHtml(editName)}</code>` : 'Ajouter une condition'}
        </h3>
        <button class="icon-btn" id="dsl-cond-close" type="button" aria-label="Fermer">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </header>
      <div class="dsl-cond-body">
        <label class="dsl-cond-field">
          <span>Nom de la condition</span>
          <input type="text" id="dsl-cond-name" placeholder="ex: non_expired_grant" autocomplete="off" />
        </label>
        <div class="dsl-cond-field">
          <span>Paramètres</span>
          <ul class="dsl-cond-params" id="dsl-cond-params"></ul>
          <button type="button" class="btn-mini" id="dsl-cond-add-param">+ paramètre</button>
        </div>
        <label class="dsl-cond-field">
          <span>Expression CEL</span>
          <textarea id="dsl-cond-expr" rows="3" placeholder="ex: current_time &lt; grant_time + grant_duration"></textarea>
          <small>Les paramètres déclarés ci-dessus sont disponibles comme variables CEL.</small>
        </label>
        <div class="dsl-cond-preview">
          <span>Preview :</span>
          <pre id="dsl-cond-preview"></pre>
        </div>
        <div class="dsl-cond-status" id="dsl-cond-status"></div>
      </div>
      <footer class="dsl-edit-actions">
        <button type="button" class="btn dsl-secondary" id="dsl-cond-cancel">Annuler</button>
        <button type="button" class="btn dsl-primary" id="dsl-cond-save">
          <i class="ti ti-check" aria-hidden="true"></i> Sauvegarder
        </button>
      </footer>
    </div>
  `;

  _ctx = {
    name: _container.querySelector('#dsl-cond-name'),
    expr: _container.querySelector('#dsl-cond-expr'),
    params: _container.querySelector('#dsl-cond-params'),
    preview: _container.querySelector('#dsl-cond-preview'),
    status: _container.querySelector('#dsl-cond-status'),
  };

  // Listeners.
  _ctx.name.addEventListener('input', sync);
  _ctx.expr.addEventListener('input', sync);
  _ctx.params.addEventListener('input', (ev) => {
    const t = ev.target;
    const i = parseInt(t.dataset.paramIdx, 10);
    if (Number.isFinite(i)) {
      if (t.classList.contains('dsl-cond-param-name')) _condition.parameters[i].name = t.value;
      if (t.classList.contains('dsl-cond-param-type')) _condition.parameters[i].type = t.value;
      updatePreview();
    }
  });
  _ctx.params.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action="del-param"]');
    if (!btn) return;
    const i = parseInt(btn.dataset.paramIdx, 10);
    _condition.parameters.splice(i, 1);
    render();
  });
  _container.querySelector('#dsl-cond-add-param').addEventListener('click', () => {
    _condition.parameters.push({ name: '', type: 'string' });
    render();
  });

  _container.querySelector('#dsl-cond-close').addEventListener('click', close);
  _container.querySelector('#dsl-cond-cancel').addEventListener('click', close);
  _container.querySelector('.dsl-edit-overlay').addEventListener('click', close);
  _container.querySelector('#dsl-cond-save').addEventListener('click', save);

  render();

  _container.removeAttribute('hidden');
  setTimeout(() => _container.classList.add('visible'), 10);
  setTimeout(() => _ctx.name.focus(), 100);
}

function setStatus(msg, type = 'info') {
  if (!_ctx) return;
  if (!msg) { _ctx.status.textContent = ''; _ctx.status.className = 'dsl-cond-status'; return; }
  _ctx.status.textContent = msg;
  _ctx.status.className = `dsl-cond-status ${type}`;
}

function save() {
  const c = _condition;
  if (!/^[a-zA-Z_]\w*$/.test(c.name)) {
    setStatus('Nom invalide. Commence par une lettre, puis lettres/chiffres/_', 'error');
    return;
  }
  const namedParams = c.parameters.filter(p => p.name);
  for (const p of namedParams) {
    if (!/^[a-zA-Z_]\w*$/.test(p.name)) {
      setStatus(`Nom de paramètre invalide: "${p.name}"`, 'error');
      return;
    }
  }
  if (!c.expression.trim()) {
    setStatus('L\'expression CEL est requise.', 'error');
    return;
  }
  const newText = upsertCondition(_fullText, { ...c, parameters: namedParams });
  // Vérifie qu'on n'écrase pas une autre condition (sauf si on édite).
  const parsed = parseDSL(newText);
  if ((parsed.conditions || []).filter(x => x.name === c.name).length > 1 && _editingName !== c.name) {
    setStatus(`Une condition "${c.name}" existe déjà. Édite-la au lieu d'en créer une nouvelle.`, 'error');
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
  _editingName = null;
  _ctx = null;
  _condition = null;
}