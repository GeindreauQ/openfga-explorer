// controllers/tuples-io.js — Page Import / Export des tuples en JSONL.
//
// Suit le pattern de audit-page : section plein écran (#io-page),
// onglets pilotés par data-io-mode, rendu du formulaire à gauche
// (form-pane) et des résultats/état à droite (results-pane). Le
// backend expose déjà GET /api/export/tuples et POST /api/import/tuples
// (cf. controllers/tuples_io.go).

import { $ } from '../lib/dom.js';
import { state } from '../lib/state.js';
import { toast } from '../lib/toast.js';
import { previewImport, importTuples, applyDSL } from '../lib/api.js';
import { isGraphActive, destroyGraph } from '../views/graph.js';
import { serializeDSL } from '../models/dsl.js';

let _currentMode = 'export';
let _initialized = false;

/**
 * Affiche la page Import / Export (cache home, montre la section).
 * Suit le pattern de showAuditPage() pour la gestion des classes body.
 */
export async function showIoPage() {
  document.body.classList.remove('home-shown');
  $('home-dashboard')?.setAttribute('hidden', '');
  document.body.classList.remove('dsl-shown', 'audit-shown', 'io-shown');
  // Cache toutes les pages plein écran (audit, dsl) pour éviter qu'elles
  // restent visibles en arrière-plan.
  for (const id of ['dsl-page', 'audit-page', 'io-page']) {
    $(id)?.setAttribute('hidden', '');
  }
  document.body.classList.add('io-shown');
  $('io-page')?.removeAttribute('hidden');

  if (isGraphActive()) destroyGraph();

  if (!_initialized) {
    _initialized = true;
    $('io-home')?.addEventListener('click', async () => {
      const { showHome } = await import('./router.js');
      showHome();
    });
    document.querySelectorAll('.audit-tab[data-io-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-io-mode');
        if (mode === _currentMode) return;
        _currentMode = mode;
        document.querySelectorAll('.audit-tab[data-io-mode]').forEach(b => {
          const isActive = b.getAttribute('data-io-mode') === _currentMode;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', String(isActive));
        });
        renderIoContent();
      });
    });
    // Re-render au changement de store. Sinon l'onglet Export garde
    // le compteur de tuples de l'ancien store, et si l'utilisateur
    // était sur Import, son contenu reste affiché tel quel. On se
    // cale sur le même `connection-refreshed` que audit-page pour
    // rester cohérent.
    document.addEventListener('connection-refreshed', () => {
      if ($('io-page') && !$('io-page').hasAttribute('hidden')) {
        renderIoContent();
        renderEmptyIoResults();
      }
    });
    initIoResizer();
  }

  renderIoContent();
  renderEmptyIoResults();
}

function renderIoContent() {
  const root = $('io-content');
  if (!root) return;
  if (_currentMode === 'export') renderExport(root);
  else if (_currentMode === 'import') renderImport(root);
  else if (_currentMode === 'model') renderModel(root);
  renderEmptyIoResults();
}

// ── Export ──────────────────────────────────────────────────────────────

function renderExport(root) {
  const total = (state.tuples || []).length;
  root.innerHTML = `
    <div class="audit-form">
      <p class="audit-mode-hint">
        <i class="ti ti-info-circle" aria-hidden="true"></i>
        Télécharge tous les tuples du store actif au format
        <code>application/jsonl</code> (1 tuple par ligne). Compatible
        avec <code>jq</code>, <code>awk</code>, pipelines shell.
      </p>
      <div class="io-stat">
        <strong>${total}</strong> tuple${total > 1 ? 's' : ''} dans le store actif.
      </div>
      <div class="audit-actions">
        <button type="button" class="btn primary" id="btn-download-tuples">
          <i class="ti ti-download" aria-hidden="true"></i> Télécharger (.jsonl)
        </button>
      </div>
    </div>
  `;
  $('btn-download-tuples')?.addEventListener('click', () => {
    // L'API force le Content-Disposition attachment ; on crée un <a>
    // invisible et on déclenche un click pour download direct (pas
    // d'onglet ouvert).
    const url = '/api/export/tuples';
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setIoResults(`<div class="audit-results-card audit-results-ok">
      <i class="ti ti-check" aria-hidden="true"></i>
      <div>
        <strong>Export lancé</strong>
        <p>${total} tuple${total > 1 ? 's' : ''} envoyé${total > 1 ? 's' : ''} vers le fichier de téléchargement.</p>
      </div>
    </div>`);
    toast(`Export lancé : ${total} tuple(s).`);
  });
}

// ── Import ──────────────────────────────────────────────────────────────

function renderImport(root) {
  root.innerHTML = `
    <div class="audit-form io-import-form">
      <p class="audit-mode-hint">
        <i class="ti ti-info-circle" aria-hidden="true"></i>
        Colle du JSONL (1 tuple par ligne) dans le textarea ci-dessous
        et clique sur <strong>Prévisualiser</strong> pour voir l'impact
        avant d'écrire. Les tuples sont insérés par lots de 50 ; les
        doublons intra-batch sont ignorés, les lignes invalides sont
        rapportées.
      </p>
      <div class="audit-field io-flex-grow">
        <label><i class="ti ti-file-text" aria-hidden="true"></i> Contenu JSONL</label>
        <textarea id="io-import-textarea"
          placeholder='{"user":"user:alice","relation":"admin","object":"server:lakekeeper"}'
          spellcheck="false"></textarea>
        <div class="hint">1 tuple par ligne — format <code>{user, relation, object}</code>.</div>
      </div>
      <div class="audit-actions">
        <button type="button" class="btn" id="btn-run-preview">
          <i class="ti ti-eye" aria-hidden="true"></i> Prévisualiser
        </button>
        <button type="button" class="btn primary" id="btn-run-import">
          <i class="ti ti-upload" aria-hidden="true"></i> Importer
        </button>
      </div>
    </div>
  `;
  $('btn-run-import')?.addEventListener('click', runImport);
  $('btn-run-preview')?.addEventListener('click', runPreview);
  // Event delegation sur le panneau de résultats : les boutons
  // "Confirmer l'import" / "Annuler" sont ajoutés dynamiquement par
  // renderPreviewReport() dans `#io-results`.
  $('io-results')?.addEventListener('click', ev => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.id === 'btn-preview-confirm') runConfirmImport();
    else if (t.id === 'btn-preview-discard') discardPreview();
  });
}

async function runConfirmImport() {
  // Garde-fou anti double-clic : on désactive immédiatement les deux
  // boutons (Confirmer + Annuler) avant même de re-render le panneau.
  // Empêche un 2e clic pendant que l'import est en vol.
  const confirmBtn = $('btn-preview-confirm');
  const discardBtn = $('btn-preview-discard');
  if (confirmBtn) confirmBtn.disabled = true;
  if (discardBtn) discardBtn.disabled = true;
  // Réutilise le flux d'import existant — le textarea contient déjà
  // le JSONL courant. Note : on ne re-touche pas au `_lastPreview`,
  // c'est runImport() qui le remet à null après succès.
  await runImport();
}

function discardPreview() {
  // Annule le preview : on remet le panneau à l'état vide, on garde
  // le textarea tel quel (l'utilisateur peut corriger puis re-try).
  _lastPreview = null;
  renderEmptyIoResults('Preview annulé. Corrige le JSONL et relance une prévisualisation.');
}

// État du dernier preview affiché dans le panneau de droite — sert
// à `runImport()` pour appliquer exactement le JSONL courant quand
// l'utilisateur clique sur "Confirmer l'import" depuis la prévisualisation.
let _lastPreview = null;

async function runPreview() {
  const textarea = $('io-import-textarea');
  const text = (textarea?.value || '').trim();
  if (!text) {
    setIoResults('<p class="audit-error">Aucune ligne à prévisualiser.</p>');
    return;
  }
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  setIoResultsLoading(`Analyse en cours… (${lineCount} ligne${lineCount > 1 ? 's' : ''})`);
  const btn = $('btn-run-preview');
  const importBtn = $('btn-run-import');
  if (btn) btn.disabled = true;
  if (importBtn) importBtn.disabled = true;
  try {
    const body = await previewImport(text);
    _lastPreview = body;
    setIoResults(renderPreviewReport(body));
  } catch (e) {
    setIoResults(`<p class="audit-error">${escapeHtml(e.message)}</p>`);
  } finally {
    if (btn) btn.disabled = false;
    if (importBtn) importBtn.disabled = false;
  }
}

/**
 * Construit le HTML du rapport de preview :
 *  - 3 compteurs en bandeaux (OK / doublons / erreurs)
 *  - liste détaillée des lignes invalides (max 50 affichées)
 *  - footer sticky avec "Confirmer l'import" / "Annuler"
 *
 * Le rapport est rendu dans le panneau de droite (`#io-results`) —
 * c'est cohérent avec le flow d'import existant.
 */
function renderPreviewReport(body) {
  const willImport = body.will_import || 0;
  const dups = body.duplicates_in_batch || 0;
  const failed = body.failed || [];

  const summary = `
    <div class="audit-results-card ${willImport > 0 ? 'audit-results-ok' : 'audit-results-warn'}">
      <i class="ti ${willImport > 0 ? 'ti-check' : 'ti-alert-circle'}" aria-hidden="true"></i>
      <div>
        <strong>${willImport} tuple${willImport > 1 ? 's' : ''} ajouté${willImport > 1 ? 's' : ''}${willImport > 0 ? '' : ' (rien à importer)'}</strong>
        <p>${failed.length === 0 ? 'Aucun problème détecté.' : `${failed.length} ligne(s) invalide(s) à corriger avant import.`}</p>
      </div>
    </div>
    <div class="io-preview-stats">
      <div class="io-preview-stat ok">
        <i class="ti ti-check" aria-hidden="true"></i>
        <strong>${willImport}</strong>
        <span>à ajouter</span>
      </div>
      <div class="io-preview-stat ${dups > 0 ? 'warn' : ''}">
        <i class="ti ti-copy" aria-hidden="true"></i>
        <strong>${dups}</strong>
        <span>doublon${dups > 1 ? 's' : ''} intra-batch</span>
      </div>
      <div class="io-preview-stat ${failed.length > 0 ? 'err' : ''}">
        <i class="ti ti-alert-triangle" aria-hidden="true"></i>
        <strong>${failed.length}</strong>
        <span>erreur${failed.length > 1 ? 's' : ''}</span>
      </div>
    </div>
  `;

  let failedList = '';
  if (failed.length > 0) {
    const items = failed.slice(0, 50).map(f =>
      `<li><span class="hint">Ligne ${f.line}</span> ${escapeHtml(f.error)}</li>`
    ).join('');
    const more = failed.length > 50
      ? `<li class="hint">… et ${failed.length - 50} de plus</li>`
      : '';
    failedList = `
      <div class="audit-result-header">${failed.length} échec${failed.length > 1 ? 's' : ''}</div>
      <ul class="audit-list">${items}${more}</ul>
    `;
  }

  // Le footer de confirmation ne s'affiche QUE si on a au moins un
  // tuple à importer (sinon Confirmer est inutile). On garde "Annuler"
  // dans tous les cas pour fermer proprement le bandeau de preview.
  const canImport = willImport > 0;
  const actions = `
    <div class="io-preview-actions">
      ${canImport ? `
        <button type="button" class="btn primary" id="btn-preview-confirm">
          <i class="ti ti-check" aria-hidden="true"></i> Confirmer l'import
        </button>
      ` : ''}
      <button type="button" class="btn" id="btn-preview-discard">
        <i class="ti ti-x" aria-hidden="true"></i> Annuler
      </button>
    </div>
  `;

  return summary + failedList + actions;
}

async function runImport() {
  const textarea = $('io-import-textarea');
  const text = (textarea?.value || '').trim();
  if (!text) {
    setIoResults('<p class="audit-error">Aucune ligne à importer.</p>');
    return;
  }
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  setIoResultsLoading(`Import en cours… (${lineCount} ligne${lineCount > 1 ? 's' : ''})`);
  const btn = $('btn-run-import');
  const previewBtn = $('btn-run-preview');
  if (btn) btn.disabled = true;
  if (previewBtn) previewBtn.disabled = true;
  try {
    const body = await importTuples(text);
    setIoResults(renderImportResult(body));
    // Reset le preview affiché : le store a changé, le dernier
    // rapport ne reflète plus l'état courant.
    _lastPreview = null;
    // Stamp le timestamp pour le dédupe SSE : si l'event
    // tuples.write revient via SSE, on sait que c'est notre propre
    // import et on ne refetch pas.
    const { state } = await import('../lib/state.js');
    state.lastLocalWriteAt = Date.now();
    const failedCount = (body.failed || []).length;
    if (failedCount === 0) {
      toast(`Import OK : ${body.imported} tuple(s).`);
    } else {
      toast(`Import partiel : ${body.imported} OK, ${failedCount} en échec.`);
    }
  } catch (e) {
    setIoResults(`<p class="audit-error">${escapeHtml(e.message)}</p>`);
  } finally {
    if (btn) btn.disabled = false;
    if (previewBtn) previewBtn.disabled = false;
  }
}

function renderImportResult(body) {
  const failedCount = (body.failed || []).length;
  if (failedCount === 0) {
    return `<div class="audit-results-card audit-results-ok">
      <i class="ti ti-check" aria-hidden="true"></i>
      <div>
        <strong>${body.imported} tuple${body.imported > 1 ? 's' : ''} importé${body.imported > 1 ? 's' : ''}</strong>
        <p>Aucune erreur — l'import est complet.</p>
      </div>
    </div>`;
  }
  const items = body.failed.slice(0, 50).map(f =>
    `<li><span class="hint">Ligne ${f.line}</span> ${escapeHtml(f.error)}</li>`
  ).join('');
  const more = body.failed.length > 50
    ? `<li class="hint">… et ${body.failed.length - 50} de plus</li>`
    : '';
  return `<div class="audit-results-card audit-results-warn">
    <i class="ti ti-alert-triangle" aria-hidden="true"></i>
    <div>
      <strong>Import partiel</strong>
      <p>${body.imported} importé${body.imported > 1 ? 's' : ''}, ${failedCount} en échec.</p>
    </div>
  </div>
  <div class="audit-result-header">${failedCount} échec${failedCount > 1 ? 's' : ''}</div>
  <ul class="audit-list">${items}${more}</ul>`;
}

// ── Modèle d'autorisation (.fga) ────────────────────────────────────────
//
// L'export télécharge le authorization model du store actif au format
// DSL (extension .fga). L'import POST le DSL sur /api/dsl/apply qui
// crée une nouvelle version du modèle côté OpenFGA.

function renderModel(root) {
  const model = state.storeModel;
  const typeCount = (model?.types || []).length;
  root.innerHTML = `
    <div class="audit-form io-import-form">
      <p class="audit-mode-hint">
        <i class="ti ti-info-circle" aria-hidden="true"></i>
        Le <strong>modèle d'autorisation</strong> définit les types et
        relations du store. Exporte-le en <code>.fga</code> (DSL) pour
        le versionner ou le partager, ou importe un <code>.fga</code>
        pour pousser une nouvelle version du modèle.
      </p>

      <section class="io-model-section">
        <h4><i class="ti ti-download" aria-hidden="true"></i> Exporter le modèle</h4>
        <p class="hint hint-flush">
          ${typeCount > 0
            ? `<strong>${typeCount}</strong> type${typeCount > 1 ? 's' : ''} dans le modèle actif.`
            : 'Aucun modèle chargé pour ce store.'}
        </p>
        <div class="audit-actions">
          <button type="button" class="btn primary" id="btn-download-model" ${typeCount === 0 ? 'disabled' : ''}>
            <i class="ti ti-download" aria-hidden="true"></i> Télécharger (.fga)
          </button>
        </div>
      </section>

      <section class="io-model-section io-flex-grow">
        <h4><i class="ti ti-upload" aria-hidden="true"></i> Importer un modèle</h4>
        <div class="audit-field io-flex-grow">
          <label for="io-model-textarea"><i class="ti ti-file-text" aria-hidden="true"></i> Contenu .fga (DSL)</label>
          <textarea id="io-model-textarea" spellcheck="false"
            placeholder="model\n  schema 1.1\n\ntype user\ntype document\n  relations\n    define owner: [user]"></textarea>
          <div class="hint">
            Ou charge un fichier <code>.fga</code> :
            <input type="file" id="io-model-file" accept=".fga,.txt,text/plain" class="io-file-input" />
          </div>
        </div>
        <div class="audit-actions">
          <button type="button" class="btn primary" id="btn-apply-model">
            <i class="ti ti-cloud-upload" aria-hidden="true"></i> Appliquer au store
          </button>
        </div>
      </section>
    </div>
  `;
  $('btn-download-model')?.addEventListener('click', runModelExport);
  $('btn-apply-model')?.addEventListener('click', runModelImport);
  // Upload de fichier .fga : on lit le contenu et on le met dans le
  // textarea. Pas d'upload direct côté backend (l'API n'expose que
  // POST /api/dsl/apply avec le body texte).
  $('io-model-file')?.addEventListener('change', onModelFileChange);
}

async function runModelExport() {
  if (!state.storeModel) {
    setIoResults('<p class="audit-error">Aucun modèle d\'autorisation à exporter pour ce store.</p>');
    return;
  }
  setIoResultsLoading('Génération du .fga…');
  try {
    const dslText = serializeDSL(state.storeModel);
    const storeSlug = (state.storeModel?.schema_version != null)
      ? `model-${Date.now()}`
      : 'model';
    downloadTextFile(dslText, `openfga-${storeSlug}.fga`, 'text/plain');
    setIoResults(`<div class="audit-results-card audit-results-ok">
      <i class="ti ti-check" aria-hidden="true"></i>
      <div>
        <strong>Export du modèle lancé</strong>
        <p>${escapeHtml((state.storeModel.types || []).length)} type${(state.storeModel.types || []).length > 1 ? 's' : ''} exporté${(state.storeModel.types || []).length > 1 ? 's' : ''} au format <code>.fga</code> (DSL).</p>
      </div>
    </div>`);
    toast('Export .fga lancé.');
  } catch (e) {
    setIoResults(`<p class="audit-error">Échec de la sérialisation : ${escapeHtml(e.message)}</p>`);
  }
}

async function runModelImport() {
  const text = $('io-model-textarea')?.value || '';
  if (!text.trim()) {
    setIoResults('<p class="audit-error">Colle un DSL ou charge un fichier .fga.</p>');
    return;
  }
  // Validation locale : on parse le JSON reçu de /api/dsl pour
  // s'assurer qu'il a au moins un type. La validation complète est
  // faite côté backend.
  setIoResultsLoading('Application du modèle…');
  try {
    const body = await applyDSL(text);
    setIoResults(`<div class="audit-results-card audit-results-ok">
      <i class="ti ti-check" aria-hidden="true"></i>
      <div>
        <strong>Modèle appliqué</strong>
        <p>
          Nouvelle version <code>${escapeHtml(body.authorization_model_id?.slice(-8) || '?')}</code>
          · ${body.types} type${body.types > 1 ? 's' : ''} · schema <code>${escapeHtml(body.schema_version || '?')}</code>
        </p>
      </div>
    </div>`);
    toast(`Modèle appliqué (${body.types} types).`);
    // On rafraîchit le modèle en mémoire + l'éditeur DSL si visible.
    try {
      const { loadDSL } = await import('./dsl-page.js');
      await loadDSL();
    } catch (e) { /* pas bloquant */ }
  } catch (e) {
    setIoResults(`<p class="audit-error">${escapeHtml(e.message)}</p>`);
  }
}

function onModelFileChange(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  // Limite à 1 Mo pour éviter de charger un fichier gigantesque dans
  // le textarea. Le backend a aussi une limite (à voir côté serveur).
  if (file.size > 1024 * 1024) {
    setIoResults('<p class="audit-error">Fichier trop volumineux (&gt; 1 Mo).</p>');
    ev.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const ta = $('io-model-textarea');
    if (ta) ta.value = String(reader.result || '');
  };
  reader.onerror = () => {
    setIoResults('<p class="audit-error">Impossible de lire le fichier.</p>');
  };
  reader.readAsText(file);
}

/** Helper : télécharge un texte comme fichier (utilisé pour .fga et .jsonl). */
function downloadTextFile(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Laisse le navigateur traiter le click avant de révoquer l'URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Helpers panneau de résultats (droite) ──────────────────────────────

function setIoResults(html) {
  const out = $('io-results');
  if (out) out.innerHTML = html;
}

function renderEmptyIoResults(message) {
  const out = $('io-results');
  if (!out) return;
  const msg = message || 'Lance un import ou un export pour voir le résultat ici.';
  out.innerHTML = `
    <div class="audit-results-empty">
      <i class="ti ti-arrow-narrow-right" aria-hidden="true"></i>
      <p>${escapeHtml(msg)}</p>
    </div>`;
}

function setIoResultsLoading(text) {
  setIoResults(`<div class="audit-results-loading">
    <div class="audit-spinner" aria-hidden="true"></div>
    <p>${escapeHtml(text || 'Requête en cours…')}</p>
  </div>`);
}

/** Séparateur redimensionnable du split-pane Import / Export. */
function initIoResizer() {
  const resizer = $('io-resizer');
  const split = $('io-split');
  const left = $('io-pane-form');
  if (!resizer || !split || !left) return;
  let dragging = false;
  let startX = 0;
  let startRatio = 0.42;
  resizer.addEventListener('mousedown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    const cs = window.getComputedStyle(left);
    const w = left.getBoundingClientRect().width;
    const total = split.getBoundingClientRect().width;
    startRatio = total > 0 ? w / total : 0.42;
    document.body.style.cursor = 'col-resize';
    ev.preventDefault();
  });
  document.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const dx = ev.clientX - startX;
    const newRatio = Math.max(0.25, Math.min(0.7, startRatio + dx / rect.width));
    left.style.flex = `${newRatio} ${newRatio} 0`;
    const right = $('io-pane-results');
    if (right) right.style.flex = `${1 - newRatio} ${1 - newRatio} 0`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}