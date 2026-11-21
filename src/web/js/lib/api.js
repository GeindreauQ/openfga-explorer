// Client de l'API backend. Toutes les requêtes ciblent le serveur Go local
// (et non OpenFGA directement) : le serveur relaie vers OpenFGA, ce qui évite
// les problèmes de CORS et garde le token hors du navigateur.

import { state } from './state.js';

const BASE = '/api';

/**
 * Header transporté par le frontend sur chaque méthode mutatrice.
 * Validé côté serveur par CSRFRequired (cf. controllers/csrf.go).
 */
export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * Liste blanche des méthodes considérées comme « safe » — aucun
 * en-tête CSRF envoyé pour celles-ci.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let csrfToken = '';

/** Pose le token CSRF (renvoyé par /api/me). À appeler au boot après login. */
export function setCsrfToken(t) {
  csrfToken = t || '';
}

/** Renvoie le token CSRF courant (pour debug / tests). */
export function getCsrfToken() { return csrfToken; }

/**
 * Helper pour les fetches directs (non encapsulés dans `request`) :
 * renvoie un objet `{[CSRF_HEADER]: token}` à merger dans les headers.
 * Vide si pas de token en cache (ex: avant /api/me).
 */
export function csrfHeader() {
  return csrfToken ? { [CSRF_HEADER]: csrfToken } : {};
}

/** Effectue une requête JSON et lève une Error lisible en cas d'échec. */
async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!SAFE_METHODS.has(method) && csrfToken) {
    headers[CSRF_HEADER] = csrfToken;
  }
  const res = await fetch(BASE + path, { ...options, headers, method });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // réponse vide ou non-JSON
  }

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `HTTP ${res.status} — ${res.statusText}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * État de configuration de la connexion OpenFGA côté serveur.
 *
 * On tape `/api/health/detail` (auth-gated) parce que c'est le seul
 * endpoint qui retourne les champs utilisés par `connection` dans
 * config.js : `configured`, `storeId`, `openfgaUrl`, `authDisabled`.
 * Le `/api/health` public (retourné depuis le commit 5bf0665) ne
 * expose plus que `{status, openfga}` — suffisant pour les liveness
 * probes K8s mais pas pour bootstraper l'UI.
 *
 * Si l'appel à `/detail` renvoie 401 (utilisateur pas encore
 * authentifié, ex: au boot avant login), on retombe sur `/health`
 * avec une projection minimale pour que la page de login s'affiche
 * correctement (configured=false → pas de dropdown, pas de toast
 * d'erreur).
 */
export async function getHealth() {
  const r = await fetch(BASE + '/health/detail', {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.ok) {
    try { return await r.json(); } catch { /* fallthrough */ }
  }
  // 401 (ou autre non-OK) : fallback sur l'endpoint public minimal.
  // Ne propage pas l'erreur : on est probablement juste non
  // authentifié, ce n'est pas un échec fonctionnel.
  return request('/health').catch(() => ({ status: 'unknown', openfga: 'unknown' }));
}

/**
 * Récupère la liste des versions (authorization models) du store actif.
 */
export async function fetchModelVersions() {
  const data = await request('/dsl/versions');
  return (data && data.versions) || [];
}

/**
 * Récupère une version spécifique du modèle par son ID.
 */
export async function fetchModelVersion(id) {
  return request('/dsl/versions/' + encodeURIComponent(id));
}

/**
 * Récupère les assertions du modèle actif (ou d'un modèle spécifique).
 */
export async function fetchAssertions(authorizationModelId) {
  const qs = authorizationModelId ? '?authorization_model_id=' + encodeURIComponent(authorizationModelId) : '';
  const data = await request('/assertions' + qs);
  return (data && data.assertions) || [];
}

/**
 * Écrit (remplace) les assertions pour un modèle.
 */
export function writeAssertions(authorizationModelId, assertions) {
  return request('/assertions', {
    method: 'POST',
    body: JSON.stringify({ authorization_model_id: authorizationModelId, assertions }),
  });
}

/**
 * Évalue une assertion unique via Check (sans l'écrire).
 */
export function checkAssertion(user, relation, object, context) {
  return request('/assertions/check', {
    method: 'POST',
    body: JSON.stringify({ user, relation, object, context }),
  });
}

/** Récupère tous les tuples du store configuré. Renvoie un tableau de tuples. */
export async function fetchTuples() {
  const data = await request('/tuples');
  return (data && data.tuples) || [];
}

/** Écrit un tuple dans OpenFGA via le backend. */
export function writeTuple(t) {
  const p = request('/tuples', {
    method: 'POST',
    body: JSON.stringify({ tuples: [{ user: t.user, relation: t.relation, object: t.object }] }),
  });
  // Stamp le timestamp pour le dédupe SSE : si l'event revient avant
  // 500ms, on sait que c'est le nôtre (round-trip) et on ne refetch pas.
  p.then(() => { state.lastLocalWriteAt = Date.now(); });
  return p;
}

/** Supprime une liste de tuples dans OpenFGA via le backend (un seul appel). */
export function deleteTuples(list) {
  const p = request('/tuples', {
    method: 'DELETE',
    body: JSON.stringify({
      tuples: list.map(t => ({ user: t.user, relation: t.relation, object: t.object })),
    }),
  });
  p.then(() => { state.lastLocalWriteAt = Date.now(); });
  return p;
}

/**
 * Liste les stores disponibles sur l'instance OpenFGA. Renvoie un
 * tableau `{id, name, active}` où `active: true` marque le store
 * actuellement sélectionné côté backend.
 */
export async function listStores() {
  const data = await request('/stores');
  return (data && data.stores) || [];
}

/**
 * Récupère les infos de session courante : user + csrf_token. Appelé
 * au boot pour amorcer le cache CSRF (cf. CSRF_HEADER).
 */
export async function getMe() {
  return request('/me');
}

/**
 * Change le store actif côté backend. Le frontend doit ensuite
 * recharger les tuples via `fetchTuples()`.
 */
/** Ferme la session côté serveur (hors /api, d'où le fetch direct). */
export async function logout() {
  const res = await fetch('/auth/logout', { method: 'POST', headers: csrfHeader() });
  if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
}

export function selectStore(storeId) {
  return request('/stores/select', {
    method: 'POST',
    body: JSON.stringify({ storeId }),
  });
}

// ── DSL ──────────────────────────────────────────────────────────

export function fetchDSL() {
  return request('/dsl');
}

export function parseDSL(text) {
  return request('/dsl/parse', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function applyDSL(text) {
  return request('/dsl/apply', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function lintDSL(model) {
  return request('/dsl/lint', {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}

// ── Audit ───────────────────────────────────────────────────────

export function auditCheck(body) {
  return request('/audit/check', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function auditListObjects(body) {
  return request('/audit/list-objects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function auditListUsers(body) {
  return request('/audit/list-users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function auditExpand(body) {
  return request('/audit/expand', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Import / Export ────────────────────────────────────────────

export function previewImport(payload) {
  return request('/import/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: payload,
  });
}

export function importTuples(payload) {
  return request('/import/tuples', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: payload,
  });
}

export async function exportTuples() {
  const r = await fetch(BASE + '/export/tuples', {
    headers: csrfToken ? { [CSRF_HEADER]: csrfToken } : {},
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const data = await r.json();
      if (data && data.error) msg = data.error;
    } catch {
      // réponse non-JSON
    }
    throw new Error(msg);
  }
  return r.text();
}
