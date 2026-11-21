// views/dsl-editor.js — Éditeur de texte pour le DSL OpenFGA.
//
// Caractéristiques (v2, refonte après inspection du playground FGA) :
//   - Theme dark monospace (lisibilité du syntax highlighting)
//   - Numérotation des lignes synchronisée avec l'overlay
//   - Syntax highlighting via overlay CSS (overlay <pre> sous <textarea>)
//   - Status bar en bas (line:col, char count, validation status)
//   - Collapsible (toolbar button, ou Ctrl+. pour toggler)
//   - Le bouton "Restaurer" a été SUPPRIMÉ : il est remplacé par
//     "Reset" dans le header de la page (plus clair pour l'utilisateur).
//
// API : init(container, { initialText, onChange })

import { parseDSL, validateDSL } from '../models/dsl.js';

// État module-level : partagé entre les méthodes du module.
let _container = null;
let _textarea = null;
let _highlight = null;       // <pre> d'overlay (conteneur)
let _highlightInner = null;   // <code> à l'intérieur du <pre> (contenu)
let _gutter = null;
let _gutterInner = null;     // <div> à l'intérieur du gutter (contenu, pour transform)
let _statusText = null;
let _errors = null;
let _isCollapsed = false;
let _onChange = null;
let _lineCol = null;

const STORAGE_KEY = 'openfga-explorer:dsl-text';

function tokenize(text) {
  // Tokenisation simple pour la coloration syntaxique (dark theme).
  // On tokenise l'original (non-échappé) puis on encode le résultat,
  // en ayant remplacé les segments à tokeniser par des placeholders
  // pour éviter que les regex suivantes n'interfèrent.
  //
  // Algorithme :
  //  1. Découpe le texte en segments (strings, comments, mots-clés,
  //     identifiants, nombres, brackets).
  //  2. Encode HTML chaque segment, en préservant les classes CSS.
  //  3. Concatène et retourne.
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // On utilise des placeholders (U+E000-U+E007) qu'on n'échappe PAS,
  // pour ne pas se marcher dessus. On les insère AVANT l'escape, puis
  // on les remplace APRÈS par les spans HTML.
  let s = text;
  // 1. Strings : "..." → placeholder E000
  s = s.replace(/"([^"]*)"/g, (m, inner) => `\uE000${inner}\uE001`);
  // 2. Comments : #... → placeholder E002
  s = s.replace(/(^|\s)(#[^\n]*)/g, (m, lead, c) => `${lead}\uE002${c}\uE003`);
  // 3. Keywords
  s = s.replace(/\b(model|schema|type|relations|define)\b/g, (m) => `\uE004${m}\uE005`);
  // 4. Identifiers (after type/define)
  s = s.replace(/(\b(?:type|define)\s+)([a-zA-Z_]\w*)/g, (m, lead, name) => `${lead}\uE006${name}\uE007`);
  // 5. Version numbers
  s = s.replace(/\b(\d+\.\d+)\b/g, (m, n) => `\uE008${n}\uE009`);
  // 6. Brackets — on isole le BLOC `[...]` complet d'un coup (pas
  // bracket par bracket, sinon le contenu entre crochets est avalé
  // par le replace final). On supporte les crochets imbriqués.
  {
    let depth = 0;
    let buf = '';
    let out = '';
    let flushBuf = () => { out += buf; buf = ''; };
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (depth === 0 && ch !== '[' && ch !== ']') {
        buf += ch;
        continue;
      }
      if (ch === '[') {
        if (depth === 0) { flushBuf(); }
        buf += ch;
        depth++;
      } else if (ch === ']') {
        buf += ch;
        depth--;
        if (depth === 0) {
          out += `\uE00A${buf}\uE00B`;
          buf = '';
        }
      } else {
        buf += ch;
      }
    }
    flushBuf();
    s = out;
  }

  // Échappe le texte + les placeholders (qui ne sont pas dans les
  // caractères HTML dangereux, mais on les laisse intacts car on les
  // remplacera juste après).
  s = escape(s);

  // Remplace les placeholders par les vrais spans (sur le texte déjà
  // échappé). Les spans sont insérés tels quels.
  s = s
    .replace(/\uE000([^\uE000\uE001]*)\uE001/g, (_, inner) => `<span class="tok-string">"${inner}"</span>`)
    .replace(/\uE002([^\uE002\uE003]*)\uE003/g, (_, c) => `<span class="tok-comment">${c}</span>`)
    .replace(/\uE004([^\uE004\uE005]*)\uE005/g, (_, kw) => `<span class="tok-kw">${kw}</span>`)
    .replace(/\uE006([^\uE006\uE007]*)\uE007/g, (_, name) => `<span class="tok-name">${name}</span>`)
    .replace(/\uE008([^\uE008\uE009]*)\uE009/g, (_, n) => `<span class="tok-number">${n}</span>`)
    .replace(/\uE00A([^\uE00A\uE00B]*)\uE00B/g, (_, b) => `<span class="tok-bracket">${b}</span>`);
  return s;
}

function renderHighlight() {
  if (!_textarea || !_highlightInner) return;
  _highlightInner.innerHTML = tokenize(_textarea.value) + '\n';
}

function updateGutter() {
  if (!_textarea || !_gutterInner) return;
  const lines = _textarea.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= lines; i++) html += i + '\n';
  _gutterInner.textContent = html;
}

function updateStatus() {
  if (!_textarea || !_lineCol || !_statusText) return;
  const text = _textarea.value;
  const pos = _textarea.selectionStart;
  let line = 1, col = 1;
  for (let i = 0; i < pos; i++) {
    if (text[i] === '\n') { line++; col = 1; } else col++;
  }
  _lineCol.textContent = `${line}:${col}`;
  _statusText.textContent = `${text.length} char · ${line} lignes`;
}

/**
 * Initialise et monte l'éditeur dans `container`.
 */
export function init(container, { initialText, onChange } = {}) {
  _container = container;
  _onChange = onChange || (() => {});

  // Récupère le texte sauvegardé (localStorage) ou utilise initialText.
  const saved = (() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  })();
  const text = saved || initialText || '';

  _container.innerHTML = `
    <div class="dsl-editor-wrap" data-collapsed="false">
      <div class="dsl-editor-toolbar">
        <button class="icon-btn dsl-collapse" title="Plier l'éditeur (Ctrl+.)" type="button" aria-label="Plier l'éditeur">
          <i class="ti ti-layout-sidebar-left-collapse" aria-hidden="true"></i>
        </button>
        <span class="dsl-editor-title">DSL</span>
      </div>
      <div class="dsl-editor-body">
        <div class="dsl-editor-gutter" aria-hidden="true"><div class="dsl-editor-gutter-inner"></div></div>
        <pre class="dsl-editor-highlight" aria-hidden="true"><code></code></pre>
        <textarea class="dsl-editor-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Éditeur DSL OpenFGA"></textarea>
      </div>
      <div class="dsl-editor-errors" id="dsl-errors"></div>
      <div class="dsl-editor-statusbar">
        <span class="dsl-editor-linecol" id="dsl-linecol">1:1</span>
        <span class="dsl-editor-stats" id="dsl-editor-stats">—</span>
      </div>
    </div>
  `;

  const ta = _container.querySelector('.dsl-editor-textarea');
  // On stocke le <pre> (scrollable, conteneur) ET le <code> (contenu
  // tokenisé). Le scroll est appliqué via transform: translateY sur le
  // <code> pour éviter la désynchro des scrollTop natifs (qui causait
  // un résidu "fantôme" sur scroll rapide).
  _textarea = ta;
  _highlight = _container.querySelector('.dsl-editor-highlight');     // <pre>
  _highlightInner = _container.querySelector('.dsl-editor-highlight > code');
  _gutter = _container.querySelector('.dsl-editor-gutter');
  _gutterInner = _container.querySelector('.dsl-editor-gutter-inner');
  _errors = _container.querySelector('.dsl-errors');
  _lineCol = _container.querySelector('.dsl-linecol');
  _statusText = _container.querySelector('#dsl-editor-stats');

  ta.value = text;
  renderHighlight();
  updateGutter();
  updateStatus();

  // Listeners
  ta.addEventListener('input', () => {
    renderHighlight();
    updateGutter();
    updateStatus();
    saveAndValidate();
  });
  ta.addEventListener('scroll', () => {
    // Translate le contenu highlight + gutter en suivant le scrollTop
    // du textarea. Plus fiable que scrollTop natif (force le GPU et
    // évite les artefacts de rendu "fantôme" lors du scroll rapide).
    const tx = -ta.scrollLeft;
    const ty = -ta.scrollTop;
    _highlightInner.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
    _gutterInner.style.transform = `translate3d(0, ${ty}px, 0)`;
  });
  ta.addEventListener('keyup', updateStatus);
  ta.addEventListener('click', updateStatus);
  ta.addEventListener('keydown', handleKeydown);

  _container.querySelector('.dsl-collapse').addEventListener('click', () => {
    setCollapsed(!_isCollapsed);
  });

  saveAndValidate();
  // _onChange is invoked by saveAndValidate already.
}

function handleKeydown(ev) {
  // Tab → 2 espaces (meilleure UX pour le DSL).
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const ta = _textarea;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
    renderHighlight();
    updateGutter();
    updateStatus();
    saveAndValidate();
  }
  // Ctrl+. → toggle collapse
  if ((ev.ctrlKey || ev.metaKey) && ev.key === '.') {
    ev.preventDefault();
    setCollapsed(!_isCollapsed);
  }
}

function saveAndValidate() {
  const text = _textarea.value;
  // Persist locally.
  try { localStorage.setItem(STORAGE_KEY, text); } catch {}

  // Validate.
  const parsed = parseDSL(text);
  // Compat ascendante : le format historique exposait `types` (array),
  // le parser officiel expose `type_definitions`. On accepte les deux.
  const types = parsed.type_definitions || parsed.types || [];
  const conditions = parsed.conditions || [];
  const parseErrors = parsed.errors || [];
  // On passe aussi `conditions` pour que le validateur puisse
  // résoudre les références `[user with non_expired_grant]`
  // (sinon il croit que la condition n'est pas définie).
  const validationErrors = validateDSL({ types, conditions });
  const allErrors = [...parseErrors, ...validationErrors];
  renderErrors(allErrors);
  // Notify count for the header (caller does this via onChange).
  if (_onChange) _onChange(text, { types, conditions, errors: allErrors });
}

function renderErrors(errors) {
  if (!_errors) return;
  if (!errors.length) {
    _errors.innerHTML = '';
    _errors.style.display = 'none';
    return;
  }
  _errors.style.display = '';
  _errors.innerHTML = errors.slice(0, 20).map(e => {
    const line = e.line ? `Ligne ${e.line}` : 'Erreur';
    const msg = e.message || String(e);
    return `<li><strong>${line}</strong> : <span>${escapeHtml(msg)}</span></li>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Renvoie le texte courant. */
export function getValue() {
  return _textarea ? _textarea.value : '';
}

/** Set le texte (et déclenche une validation). */
export function setValue(text) {
  if (!_textarea) return;
  _textarea.value = text;
  renderHighlight();
  updateGutter();
  updateStatus();
  saveAndValidate();
}

/** Collapse/expand. */
export function setCollapsed(collapsed) {
  _isCollapsed = !!collapsed;
  const wrap = _container?.querySelector('.dsl-editor-wrap');
  if (wrap) wrap.setAttribute('data-collapsed', String(_isCollapsed));
}

/** Détruit proprement l'éditeur (cleanup des listeners). */
export function destroy() {
  _container = _textarea = _highlight = _highlightInner = _gutter = _gutterInner = _statusText = _errors = _lineCol = null;
  _onChange = null;
}
