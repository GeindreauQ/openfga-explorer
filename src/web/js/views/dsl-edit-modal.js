// views/dsl-edit-modal.js — Modale d'édition directe du DSL.
//
// Quand l'utilisateur clique sur un nœud du graphe et appuie sur
// "Éditer ce type", cette modale s'ouvre avec :
//   - À gauche : un éditeur de texte focalisé sur le type sélectionné
//     (avec syntax highlighting + line numbers, similaire à
//     dsl-editor.js mais en plus simple)
//   - À droite : un panneau d'aide contextuelle (syntaxe, exemples)
//   - En bas : boutons "Annuler", "Restaurer le défaut", "Appliquer"
//
// Cette modale permet de modifier le DSL d'UN type spécifique (ou le
// DSL complet) sans toucher à l'éditeur principal. Les changements
// sont reflétés dans l'éditeur principal à la fermeture (via callback).

import { parseDSL, validateDSL } from '../models/dsl.js';

// État module-level.
let _container = null;
let _overlay = null;
let _editorEl = null;
let _highlightEl = null;
let _helpEl = null;
let _errorsEl = null;
let _onSave = null;  // callback (newText) => void
let _originalText = '';
let _typeFocus = null; // si non-null, on édite seulement ce type
let _fullText = '';    // texte complet du DSL (référence pour les modifs partielles)

const HELP_BY_TYPE = {
  type: {
    title: 'Définir un type',
    description: 'Un type OpenFGA représente une catégorie d\'objets (user, role, document, ...).',
    syntax: 'type <nom>',
    example: `type document

type organization
  relations
    define admin: [user]`,
  },
  relations: {
    title: 'Bloc relations',
    description: 'Le bloc relations contient les définitions de relations directes pour ce type.',
    syntax: 'relations\n  define ...',
    example: `relations
  define reader: [user]
  define writer: [user, role#member]`,
  },
  define: {
    title: 'Définir une relation',
    description: 'Une relation associe ce type à un ensemble de subjects (utilisateurs autorisés).',
    syntax: 'define <nom>: [<type>, <type>#<rel>, ...]',
    example: `# Sujets autorisés (this) :
define owner:   [user, role#admin]    # un user OU un role avec #admin
define member:  [user:*]               # tous les users (wildcard)
define parent:  [organization]         # référence vers un autre type
define viewer:  [user with my_cond]    # avec une condition

# Expressions (union, intersection, exclusion, computed userset) :
define viewer:    [user] or editor                  # or (union)
define can_read:  member and viewer                 # and (intersection)
define published: [user] but not blocked            # but not (difference)
define owner:     owner from parent                 # computed userset (X from Y)
define admin:     [user] or repo_admin from owner   # combinaison libre`,
  },
  condition: {
    title: 'Définir une condition',
    description: 'Une condition est une expression CEL qui s\'évalue à true/false. Elle peut être attachée à un type direct via `with <cond>`.',
    syntax: 'condition <nom>(<p>: <type>, ...) { <expr_CEL> }',
    example: `condition non_expired_grant(
  current_time: timestamp,
  grant_time:   timestamp,
  grant_duration: duration
) {
  current_time < grant_time + grant_duration
}`,
  },
};

function tokenize(text) {
  // Tokenizer simplifié basé sur des placeholders Unicode (pour éviter
  // que les regex ne se chevauchent). Voir dsl-editor.js pour la
  // version complète.
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let s = text;
  s = s.replace(/"([^"]*)"/g, (m, inner) => `\uE000${inner}\uE001`);
  s = s.replace(/(^|\s)(#[^\n]*)/g, (m, lead, c) => `${lead}\uE002${c}\uE003`);
  // Keywords principaux.
  s = s.replace(/\b(model|schema|type|relations|define|condition)\b/g, (m) => `\uE004${m}\uE005`);
  // Keywords d'expression.
  s = s.replace(/\b(or|and|from|with|but not)\b/g, (m) => `\uE010${m}\uE011`);
  s = s.replace(/(\b(?:type|define|condition)\s+)([a-zA-Z_]\w*)/g, (m, lead, name) => `${lead}\uE006${name}\uE007`);
  s = s.replace(/\b(\d+\.\d+)\b/g, (m, n) => `\uE008${n}\uE009`);
  s = s.replace(/(\[|\])/g, (m) => `\uE00A${m}\uE00B`);
  s = escape(s);
  s = s
    .replace(/\uE000([^\uE000\uE001]*)\uE001/g, (_, inner) => `<span class="tok-string">"${inner}"</span>`)
    .replace(/\uE002([^\uE002\uE003]*)\uE003/g, (_, c) => `<span class="tok-comment">${c}</span>`)
    .replace(/\uE004([^\uE004\uE005]*)\uE005/g, (_, kw) => `<span class="tok-kw">${kw}</span>`)
    .replace(/\uE010([^\uE010\uE011]*)\uE011/g, (_, kw) => `<span class="tok-op">${kw}</span>`)
    .replace(/\uE006([^\uE006\uE007]*)\uE007/g, (_, name) => `<span class="tok-name">${name}</span>`)
    .replace(/\uE008([^\uE008\uE009]*)\uE009/g, (_, n) => `<span class="tok-number">${n}</span>`)
    .replace(/\uE00A([^\uE00A\uE00B]*)\uE00B/g, (_, b) => `<span class="tok-bracket">${b}</span>`);
  return s;
}

function renderHighlight() {
  if (!_editorEl || !_highlightEl) return;
  _highlightEl.innerHTML = tokenize(_editorEl.value) + '\n';
  // Sync scroll.
  _highlightEl.scrollTop = _editorEl.scrollTop;
  _highlightEl.scrollLeft = _editorEl.scrollLeft;
}

function renderHelp() {
  if (!_helpEl) return;
  const def = HELP_BY_TYPE[_typeFocus] || HELP_BY_TYPE.define;
  _helpEl.innerHTML = `
    <div class="dsl-edit-help-section">
      <h4><i class="ti ti-help" aria-hidden="true"></i> ${escapeHtml(def.title)}</h4>
      <p>${escapeHtml(def.description)}</p>
    </div>
    <div class="dsl-edit-help-section">
      <h4><i class="ti ti-code" aria-hidden="true"></i> Syntaxe</h4>
      <pre class="dsl-edit-help-syntax">${escapeHtml(def.syntax)}</pre>
    </div>
    <div class="dsl-edit-help-section">
      <h4><i class="ti ti-sparkles" aria-hidden="true"></i> Exemples</h4>
      <pre class="dsl-edit-help-example">${escapeHtml(def.example)}</pre>
    </div>
    <div class="dsl-edit-help-section">
      <h4><i class="ti ti-book" aria-hidden="true"></i> Raccourcis</h4>
      <ul class="dsl-edit-help-shortcuts">
        <li><kbd>Tab</kbd> : 2 espaces</li>
        <li><kbd>Ctrl</kbd>+<kbd>S</kbd> : Appliquer</li>
        <li><kbd>Esc</kbd> : Fermer</li>
      </ul>
    </div>
  `;
}

function renderErrors() {
  if (!_editorEl || !_errorsEl) return;
  const text = _editorEl.value;
  const { errors: parseErrors } = parseDSL(text);
  const errors = parseErrors;
  if (!errors.length) {
    _errorsEl.innerHTML = '<span class="dsl-edit-status-ok"><i class="ti ti-check"></i> DSL valide</span>';
    return;
  }
  _errorsEl.innerHTML = errors.slice(0, 5).map(e => {
    const line = e.line ? `L${e.line}` : '';
    return `<span class="dsl-edit-status-err"><i class="ti ti-alert-triangle"></i> ${escapeHtml(line)}: ${escapeHtml(e.message || '')}</span>`;
  }).join(' ');
}

/**
 * Extrait la portion du DSL qui correspond à un type donné.
 */
function extractTypeBlock(fullText, typeName) {
  if (!typeName) return fullText;
  const lines = fullText.split('\n');
  const startIdx = lines.findIndex(l => new RegExp(`^type\\s+${typeName}\\s*$`).test(l));
  if (startIdx < 0) return '';
  // Trouve la fin du bloc : prochain `type` ou fin du fichier.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^type\s+\w+\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

/**
 * Remplace un bloc de type dans le texte complet.
 */
function replaceTypeBlock(fullText, typeName, newBlock) {
  if (!typeName) return newBlock;
  const lines = fullText.split('\n');
  const startIdx = lines.findIndex(l => new RegExp(`^type\\s+${typeName}\\s*$`).test(l));
  if (startIdx < 0) {
    // Le type n'existe pas, on l'ajoute à la fin.
    return fullText.trimEnd() + '\n\n' + newBlock + '\n';
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^type\s+\w+\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return [...lines.slice(0, startIdx), ...newBlock.split('\n'), ...lines.slice(endIdx)].join('\n');
}

/**
 * Ouvre la modale d'édition.
 *
 * @param {object} options
 * @param {string} options.fullText Texte complet du DSL.
 * @param {string|null} options.typeFocus Nom du type à éditer (null = tout).
 * @param {function} options.onSave Callback appelé avec le texte complet mis à jour.
 */
export function open({ fullText, typeFocus, onSave }) {
  _container = document.getElementById('dsl-edit-modal');
  if (!_container) {
    // Crée la modale une seule fois.
    _container = document.createElement('div');
    _container.id = 'dsl-edit-modal';
    _container.className = 'dsl-edit-modal';
    _container.setAttribute('role', 'dialog');
    _container.setAttribute('aria-modal', 'true');
    _container.setAttribute('aria-labelledby', 'dsl-edit-title');
    document.body.appendChild(_container);
  }
  _onSave = onSave || (() => {});
  _fullText = fullText || '';
  _typeFocus = typeFocus || null;

  const block = extractTypeBlock(_fullText, _typeFocus);
  _originalText = block;

  _container.innerHTML = `
    <div class="dsl-edit-overlay"></div>
    <div class="dsl-edit-content">
      <header class="dsl-edit-header">
        <h3 id="dsl-edit-title">
          <i class="ti ti-edit" aria-hidden="true"></i>
          ${typeFocus ? `Éditer le type <code>${escapeHtml(typeFocus)}</code>` : 'Éditer le DSL complet'}
        </h3>
        <button class="icon-btn" id="dsl-edit-close" type="button" aria-label="Fermer">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </header>
      <div class="dsl-edit-body">
        <div class="dsl-edit-editor-pane">
          <div class="dsl-edit-gutter" aria-hidden="true"></div>
          <pre class="dsl-edit-highlight" aria-hidden="true"><code></code></pre>
          <textarea class="dsl-edit-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
        </div>
        <aside class="dsl-edit-help" id="dsl-edit-help"></aside>
      </div>
      <div class="dsl-edit-statusbar" id="dsl-edit-statusbar"></div>
      <footer class="dsl-edit-actions">
        <button type="button" class="btn dsl-secondary" id="dsl-edit-revert">
          <i class="ti ti-rotate" aria-hidden="true"></i> Restaurer
        </button>
        <button type="button" class="btn dsl-secondary" id="dsl-edit-cancel">
          Annuler
        </button>
        <button type="button" class="btn dsl-primary" id="dsl-edit-apply">
          <i class="ti ti-check" aria-hidden="true"></i> Appliquer
        </button>
      </footer>
    </div>
  `;

  _editorEl = _container.querySelector('.dsl-edit-textarea');
  _highlightEl = _container.querySelector('.dsl-edit-highlight > code');
  _helpEl = _container.querySelector('#dsl-edit-help');
  _errorsEl = _container.querySelector('#dsl-edit-statusbar');
  const gutter = _container.querySelector('.dsl-edit-gutter');

  _editorEl.value = block;
  renderHighlight();
  renderHelp();
  renderErrors();
  updateGutter();

  function updateGutter() {
    const lines = _editorEl.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lines; i++) html += i + '\n';
    gutter.textContent = html;
  }

  // Listeners.
  _editorEl.addEventListener('input', () => {
    renderHighlight();
    renderErrors();
    updateGutter();
  });
  _editorEl.addEventListener('scroll', () => {
    _highlightEl.scrollTop = _editorEl.scrollTop;
    _highlightEl.scrollLeft = _editorEl.scrollLeft;
    gutter.scrollTop = _editorEl.scrollTop;
  });
  _editorEl.addEventListener('keydown', handleKeydown);

  _container.querySelector('#dsl-edit-close')?.addEventListener('click', close);
  _container.querySelector('#dsl-edit-cancel')?.addEventListener('click', close);
  _container.querySelector('#dsl-edit-revert')?.addEventListener('click', () => {
    _editorEl.value = _originalText;
    renderHighlight();
    renderErrors();
    updateGutter();
  });
  _container.querySelector('#dsl-edit-apply')?.addEventListener('click', apply);
  _container.querySelector('.dsl-edit-overlay')?.addEventListener('click', close);

  // Affiche.
  _container.removeAttribute('hidden');
  setTimeout(() => _container.classList.add('visible'), 10);
  setTimeout(() => _editorEl.focus(), 100);
}

function handleKeydown(ev) {
  // Tab → 2 espaces.
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const start = _editorEl.selectionStart;
    const end = _editorEl.selectionEnd;
    _editorEl.value = _editorEl.value.slice(0, start) + '  ' + _editorEl.value.slice(end);
    _editorEl.selectionStart = _editorEl.selectionEnd = start + 2;
    renderHighlight();
    renderErrors();
  }
  // Ctrl+S → appliquer.
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
    ev.preventDefault();
    apply();
  }
  // Esc → fermer.
  if (ev.key === 'Escape') {
    ev.preventDefault();
    close();
  }
}

function apply() {
  const text = _editorEl.value;
  const { errors } = parseDSL(text);
  if (errors.length > 0) {
    // On demande confirmation si erreurs.
    if (!confirm(`Le DSL contient ${errors.length} erreur(s). Appliquer quand même ?`)) {
      return;
    }
  }
  // Remplace le bloc dans le texte complet.
  const newFull = replaceTypeBlock(_fullText, _typeFocus, text);
  _onSave(newFull);
  close();
}

export function close() {
  if (!_container) return;
  _container.classList.remove('visible');
  setTimeout(() => {
    _container?.setAttribute('hidden', '');
  }, 200);
  _onSave = null;
  _originalText = '';
  _typeFocus = null;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
