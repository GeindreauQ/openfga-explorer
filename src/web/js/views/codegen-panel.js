// views/codegen-panel.js — Génération de code client SDK à partir du modèle.
//
// Bouton "Generate SDK" dans l'Admin DSL qui ouvre un modal avec
// 4 onglets (TypeScript, Go, Python, curl) montrant le code généré,
// à copier ou à télécharger.
//
// Pas de dépendance externe : on utilise le modèle parsé en mémoire
// (state.storeModel), le store et le modèle actifs (valeurs par défaut du
// code généré) et le module `lib/codegen/index.js`. Le code est régénéré à
// chaque ouverture du modal pour rester synchro avec le modèle courant.

import { $, escapeHtml } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { connection } from '../config.js';
import { filenameFor, generateCode, listLanguages } from '../lib/codegen/index.js';
import { toast } from '../lib/toast.js';

let _initialized = false;
let _currentLang = 'typescript';

const LANG_LABELS = {
  typescript: 'TypeScript',
  go: 'Go',
  python: 'Python',
  curl: 'curl',
};

const LANG_ICONS = {
  typescript: 'ti-brand-typescript',
  go: 'ti-brand-go',
  python: 'ti-brand-python',
  curl: 'ti-terminal-2',
};

/** Initialise le panneau + listeners. */
export function initCodegenPanel() {
  if (_initialized) return;
  _initialized = true;
  $('btn-generate-sdk')?.addEventListener('click', openCodegenModal);
  $('btn-close-codegen')?.addEventListener('click', closeCodegenModal);
  $('codegen-backdrop')?.addEventListener('click', (ev) => {
    if (ev.target === $('codegen-backdrop')) closeCodegenModal();
  });
  // Tab switching : event delegation car les onglets sont créés
  // dynamiquement par renderCodegenTabs().
  $('codegen-tabs')?.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.codegen-tab');
    if (!tab) return;
    _currentLang = tab.getAttribute('data-lang');
    renderCodegenTabs();
    renderCodegenCode();
  });
  $('btn-codegen-download')?.addEventListener('click', () => {
    const code = $('codegen-code')?.textContent || '';
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFor(_currentLang);
    link.click();
    URL.revokeObjectURL(url);
  });
  // Copy button
  $('btn-codegen-copy')?.addEventListener('click', async () => {
    const code = $('codegen-code')?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      toast('Code copié dans le presse-papier');
    } catch (e) {
      toast('Copie impossible : ' + e.message, true);
    }
  });
}

/** Ouvre le modal et génère le code. */
function openCodegenModal() {
  if (!state.storeModel) {
    toast('Aucun modèle chargé — connecte-toi à un store avec un authorization model.', true);
    return;
  }
  $('codegen-backdrop')?.classList.add('open');
  renderCodegenTabs();
  renderCodegenCode();
}

/** Ferme le modal. */
function closeCodegenModal() {
  $('codegen-backdrop')?.classList.remove('open');
}

function renderCodegenTabs() {
  const langs = listLanguages();
  const tabsHtml = langs.map(lang => {
    const active = lang === _currentLang;
    return `<button type="button" class="codegen-tab ${active ? 'active' : ''}"
      data-lang="${lang}" role="tab" aria-selected="${active}">
      <i class="ti ${LANG_ICONS[lang]}" aria-hidden="true"></i> ${LANG_LABELS[lang]}
    </button>`;
  }).join('');
  const tabsEl = $('codegen-tabs');
  if (tabsEl) tabsEl.innerHTML = tabsHtml;
}

/** Store et modèle actifs : valeurs par défaut du code généré. */
function codegenContext() {
  return {
    storeId: connection.storeId,
    storeName: connection.storeName,
    modelId: state.authorizationModelId || '',
    apiUrl: connection.openfgaUrl || undefined,
  };
}

function renderCodegenMeta(ctx) {
  const meta = $('codegen-meta');
  if (meta) {
    const store = ctx.storeName || ctx.storeId || '—';
    meta.innerHTML = `Store <strong>${escapeHtml(store)}</strong>`
      + (ctx.modelId ? ` · modèle <code>${escapeHtml(ctx.modelId)}</code>` : '')
      + ' · surchargés par <code>FGA_STORE_ID</code> / <code>FGA_MODEL_ID</code>';
  }
  const filename = $('codegen-filename');
  if (filename) filename.textContent = filenameFor(_currentLang);
}

function renderCodegenCode() {
  if (!state.storeModel) return;
  const ctx = codegenContext();
  renderCodegenMeta(ctx);
  let code = '';
  try {
    code = generateCode(state.storeModel, _currentLang, ctx);
  } catch (e) {
    code = `// Erreur de génération : ${e.message}`;
  }
  const codeEl = $('codegen-code');
  if (codeEl) {
    codeEl.textContent = code;
    codeEl.setAttribute('data-lang', _currentLang);
  }
}