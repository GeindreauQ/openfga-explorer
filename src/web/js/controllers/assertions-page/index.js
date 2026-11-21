import { $ } from '../../lib/dom.js';
import { state } from '../../lib/state.js';
import { toast } from '../../lib/toast.js';
import { isGraphActive, destroyGraph } from '../../views/graph.js';
import { fetchAssertions, writeAssertions, checkAssertion } from '../../lib/api.js';

let _initialized = false;
let _boundModelId = null; // modèle-id auquel les assertions chargées sont liées

export async function showAssertionsPage() {
  document.body.classList.remove('home-shown');
  $('home-dashboard')?.setAttribute('hidden', '');
  document.body.classList.remove('dsl-shown', 'audit-shown', 'io-shown', 'assertions-shown');
  for (const id of ['dsl-page', 'audit-page', 'io-page', 'assertions-page']) {
    $(id)?.setAttribute('hidden', '');
  }
  document.body.classList.add('assertions-shown');
  $('assertions-page')?.removeAttribute('hidden');

  if (isGraphActive()) destroyGraph();

  if (!_initialized) {
    _initialized = true;
    $('assertions-home')?.addEventListener('click', async () => {
      const { showHome } = await import('../router.js');
      showHome();
    });
    $('btn-assertions-save')?.addEventListener('click', saveAssertions);
    $('btn-assertions-run')?.addEventListener('click', runAllAssertions);
    $('btn-assertions-add')?.addEventListener('click', addAssertionRow);
    document.addEventListener('connection-refreshed', () => {
      if ($('assertions-page') && !$('assertions-page').hasAttribute('hidden')) {
        handleConnectionRefreshed();
      }
    });
  }

  // Ensure model is loaded
  if (!state.storeModel) {
    try {
      const { loadDSL } = await import('../dsl-page.js');
      await loadDSL();
    } catch (e) {
      console.warn('assertions: loadDSL failed', e);
    }
  }

  await loadAndRender();
  // Premier render : on mémorise l'id du modèle pour détecter les
  // changements futurs (switch de store ou application d'un nouveau modèle).
  _boundModelId = state.authorizationModelId || null;
  renderModelBadge();
  populateDatalists();
}

// Appelé quand `connection-refreshed` se déclenche pendant qu'on est sur
// la page assertions. Si l'id du modèle a changé, on avertit l'utilisateur
// et on invalide les assertions chargées.
function handleConnectionRefreshed() {
  const newId = state.authorizationModelId || null;
  if (newId && _boundModelId && newId !== _boundModelId) {
    toast("Modèle lié changé : nouvelle version appliquée.");
    _assertions = [];
    renderTable(_assertions);
  } else if (newId && !_boundModelId) {
    // Premier chargement (cas où l'utilisateur arrive sur assertions
    // avant que state.authorizationModelId ne soit défini).
    _boundModelId = newId;
  }
  renderModelBadge();
  populateDatalists();
  // Recharge les assertions pour le nouveau modèle.
  loadAndRender();
}

// Affiche l'id du authorization model lié aux assertions chargées.
// Format : 12 derniers caractères (style ULID tronqué), avec le full
// id en tooltip pour l'inspecter au survol.
function renderModelBadge() {
  const el = $('assertions-model-id');
  if (!el) return;
  const id = state.authorizationModelId;
  if (!id) {
    el.textContent = '—';
    el.setAttribute('title', '');
    return;
  }
  const short = id.length > 12 ? '…' + id.slice(-12) : id;
  el.textContent = short;
  el.setAttribute('title', id);
}

// Peuple les datalists d'autocompletion à partir de state.storeModel
// (qui peut être dans le format legacy {types:[...]} ou le format
// OpenFGA brut {type_definitions:[...]} — on accepte les deux).
function populateDatalists() {
  const typeList = $('assertions-type-list');
  const relList = $('assertions-rel-list');
  const objList = $('assertions-object-list');
  if (!typeList || !relList || !objList) return;
  const model = state.storeModel;
  if (!model) {
    typeList.innerHTML = '';
    relList.innerHTML = '';
    objList.innerHTML = '';
    return;
  }
  // Normalise les sources (legacy `types` vs OpenFGA `type_definitions`).
  const types = model.types || model.type_definitions || [];
  const typeNames = types.map(t => t.type || t.name).filter(Boolean);
  // Relations : union des noms de relations de tous les types.
  const relSet = new Set();
  for (const t of types) {
    const rels = t.relations || {};
    const relNames = Array.isArray(rels) ? rels.map(r => r.name) : Object.keys(rels);
    for (const r of relNames) if (r) relSet.add(r);
  }
  const relNames = [...relSet].sort();
  typeList.innerHTML = typeNames.map(n => `<option value="${esc(n)}">`).join('');
  relList.innerHTML = relNames.map(n => `<option value="${esc(n)}">`).join('');
  objList.innerHTML = typeNames.map(n => `<option value="${esc(n)}:">`).join('');
}

let _assertions = [];

async function loadAndRender() {
  const authorizationModelId = state.authorizationModelId;
  if (!authorizationModelId) {
    renderTable([]);
    return;
  }
  try {
    _assertions = await fetchAssertions(authorizationModelId);
  } catch (e) {
    toast('Erreur chargement assertions : ' + e.message, true);
    _assertions = [];
  }
  renderTable(_assertions);
}

function renderTable(assertions) {
  const tbody = $('assertions-table-body');
  if (!tbody) return;
  if (!assertions || assertions.length === 0) {
    tbody.innerHTML = '<tr class="assertions-empty"><td colspan="5">Aucune assertion. Ajoutez-en une ci-dessous.</td></tr>';
    return;
  }
  tbody.innerHTML = assertions.map((a, i) => {
    const expected = a.expectation !== false;
    const user = a.tuple_key ? a.tuple_key.user : a.user;
    const relation = a.tuple_key ? a.tuple_key.relation : a.relation;
    const object = a.tuple_key ? a.tuple_key.object : a.object;
    return `<tr data-idx="${i}">
      <td><code>${esc(user)}</code></td>
      <td><code>${esc(relation)}</code></td>
      <td><code>${esc(object)}</code></td>
      <td><span class="assertion-expectation ${expected ? 'allowed' : 'denied'}">${expected ? 'allowed' : 'denied'}</span></td>
      <td><button type="button" class="btn assertion-delete-btn" data-idx="${i}" title="Supprimer"><i class="ti ti-trash"></i></button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.assertion-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      _assertions.splice(idx, 1);
      renderTable(_assertions);
    });
  });
}

function addAssertionRow() {
  const user = $('assertion-new-user')?.value.trim();
  const relation = $('assertion-new-relation')?.value.trim();
  const object = $('assertion-new-object')?.value.trim();
  const allowed = $('assertion-new-allowed')?.checked;

  if (!user || !relation || !object) {
    toast('Remplissez user, relation et object.', true);
    return;
  }

  _assertions.push({
    tuple_key: { user, relation, object },
    expectation: allowed !== false,
  });

  // Clear form
  $('assertion-new-user').value = '';
  $('assertion-new-relation').value = '';
  $('assertion-new-object').value = '';
  $('assertion-new-allowed').checked = true;

  renderTable(_assertions);
}

async function saveAssertions() {
  const authorizationModelId = state.authorizationModelId;
  if (!authorizationModelId) {
    toast('Aucun authorization model sélectionné.', true);
    return;
  }
  const btn = $('btn-assertions-save');
  if (btn) btn.disabled = true;
  try {
    await writeAssertions(authorizationModelId, _assertions);
    toast(`Assertions sauvegardées (${_assertions.length})`);
  } catch (e) {
    toast('Erreur sauvegarde : ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runAllAssertions() {
  const container = $('assertions-results');
  if (!container) return;
  if (_assertions.length === 0) {
    container.innerHTML = '<p class="hint">Ajoutez des assertions avant de les exécuter.</p>';
    return;
  }
  container.innerHTML = '<p class="hint">Exécution en cours…</p>';

  let passed = 0, failed = 0;
  const results = [];

  for (let i = 0; i < _assertions.length; i++) {
    const a = _assertions[i];
    const user = a.tuple_key ? a.tuple_key.user : a.user;
    const relation = a.tuple_key ? a.tuple_key.relation : a.relation;
    const object = a.tuple_key ? a.tuple_key.object : a.object;
    const expected = a.expectation !== false;
    try {
      const data = await checkAssertion(user, relation, object, a.context);
      const actual = data.allowed === true;
      const ok = actual === expected;
      results.push({ user, relation, object, expected, actual, ok });
      if (ok) passed++; else failed++;
    } catch (e) {
      results.push({ user, relation, object, expected, actual: null, ok: false, error: e.message });
      failed++;
    }
    // Update progress
    container.innerHTML = `<p class="hint">Exécution… ${i + 1}/${_assertions.length}</p>`;
  }

  renderResults(container, results, passed, failed);
}

function renderResults(container, results, passed, failed) {
  const total = results.length;
  let html = `<div class="assertions-summary ${failed > 0 ? 'has-fails' : 'all-pass'}">
    <i class="ti ${failed > 0 ? 'ti-x' : 'ti-check'}" aria-hidden="true"></i>
    <span>${passed}/${total} passé${passed > 1 ? 's' : ''}${failed > 0 ? `, ${failed} échec${failed > 1 ? 's' : ''}` : ''}</span>
  </div>`;

  if (failed > 0 || total > 0) {
    html += '<table class="assertions-results-table"><thead><tr><th>User</th><th>Relation</th><th>Object</th><th>Attendu</th><th>Réel</th><th>Statut</th></tr></thead><tbody>';
    for (const r of results) {
      const statusCls = r.ok ? 'pass' : 'fail';
      const statusIcon = r.ok ? 'ti-check' : 'ti-x';
      const actualStr = r.actual === null ? 'err' : r.actual ? 'allowed' : 'denied';
      html += `<tr class="assertions-result-${statusCls}">
        <td><code>${esc(r.user)}</code></td>
        <td><code>${esc(r.relation)}</code></td>
        <td><code>${esc(r.object)}</code></td>
        <td>${r.expected ? 'allowed' : 'denied'}</td>
        <td>${actualStr}</td>
        <td><i class="ti ${statusIcon}" aria-hidden="true"></i></td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  container.innerHTML = html;
}

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
