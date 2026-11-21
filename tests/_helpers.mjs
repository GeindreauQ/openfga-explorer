// tests/_helpers.mjs — Utilitaires communs pour les tests Playwright.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

export const APP_URL    = process.env.APP_URL    || 'http://localhost:8000';
export const OPENFGA_URL = process.env.OPENFGA_URL || 'http://localhost:8080';

// Cache du mot de passe admin récupéré depuis les logs du container.
// On prend la DERNIÈRE occurrence car le seed est idempotent : à chaque
// `docker compose restart` (sans -v), le seed peut réimprimer le bloc
// SECURITY si le user admin n'existe pas encore, ou pas du tout. Mais
// si on cumule plusieurs logs, on veut la dernière impression (= le
// mot de passe le plus récent, qui correspond à l'admin actuellement
// en mémoire).
let _adminPassword = null;
export function getAdminPassword() {
  if (_adminPassword !== null) return _adminPassword;
  // Instance hors docker : mot de passe fourni par l'environnement.
  if (process.env.ADMIN_PASSWORD) return (_adminPassword = process.env.ADMIN_PASSWORD);
  try {
    _adminPassword = execSync(
      'docker logs openfga-explorer 2>&1 | grep "password :" | tail -1 | awk "{print \\$NF}"',
      { encoding: 'utf8' }
    ).trim();
  } catch {
    _adminPassword = '';
  }
  return _adminPassword;
}

export async function launchBrowser() {
  // PLAYWRIGHT_CHROMIUM_PATH : navigateur à utiliser à la place de celui de Playwright.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  return chromium.launch({ headless: true, executablePath });
}

// Installé sur chaque page avant tout script : expose une variable
// `window.__csrfToken` et wrap `fetch` pour l'ajouter en
// `X-CSRF-Token` sur les méthodes mutatrices. Sans ça, les
// POST/DELETE/PUT des tests se font jeter en 403 par CSRFRequired
// (cf. src/server/controllers/csrf.go). Le token est peuplé paresseusement
// au premier fetch mutating via un GET /api/me — pas besoin de le
// re-peupler manuellement après chaque login.
const csrfInitScript = () => {
  window.__csrfToken = '';
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    init.headers = init.headers || {};
    const m = (init.method || 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(m)) {
      return origFetch(input, init);
    }
    if (!window.__csrfToken) {
      try {
        const r = await origFetch('/api/me');
        const j = await r.json();
        window.__csrfToken = j.csrf_token || '';
      } catch {
        // Pas de session : on laisse passer sans token, le serveur
        // répondra 401 via auth.Middleware.
      }
    }
    if (window.__csrfToken) {
      init.headers['X-CSRF-Token'] = window.__csrfToken;
    }
    return origFetch(input, init);
  };
};

export async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(csrfInitScript);
  const issues = [];
  page.on('pageerror', e => issues.push(e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') issues.push('console: ' + msg.text());
  });
  return { page, ctx, issues };
}

/**
 * Login local (admin / mot de passe seedé). À appeler au début de chaque
 * test qui veut accéder à l'UI. Idempotent : si on est déjà sur /, no-op.
 *
 * Comportement par défaut : après login, navigue vers la tuile
 * `manage_tuple` (la vue cartes) pour la compatibilité avec les tests
 * existants qui s'attendent à voir les tuples / cartes / graphes
 * directement. Les tests du tableau de bord lui-même appellent
 * `authedGoto(page, '/home')` pour rester sur le home.
 */
export async function authedGoto(page, url) {
  // Désactive le SSE qui maintient la connexion réseau active et
  // empêche `waitUntil: 'networkidle'` de se déclencher. En prod, SSE
  // est toujours actif (default = true).
  await page.addInitScript(() => { window.__sseDisabled = true; });
  // Le wrapper CSRF est installé par newPage(); ici on s'assure juste
  // qu'il l'est aussi si authedGoto est appelé sans newPage préalable.
  await page.addInitScript(csrfInitScript);
  await page.goto(APP_URL + '/login', { waitUntil: 'networkidle' });
  const pwd = getAdminPassword();
  if (pwd) {
    // Tente le login seulement si on est sur la page de login.
    if (page.url().includes('/login')) {
      // Tolère un bucket de rate limit vidé par un test précédent.
      // On vérifie via le contexte navigateur (cookies) que la session
      // est bien établie — pas juste l'URL (un 429 redirige vers
      // /auth/local, qui ne contient pas /login mais ne nous a pas
      // loggés pour autant).
      let logged = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.fill('#username', 'admin');
        await page.fill('#password', pwd);
        await page.click('button[type=submit]');
        // Attend la redirection vers / (post-login) ou détecte un 429.
        const redirected = await page
          .waitForURL(url => !url.toString().includes('/login') && !url.toString().includes('/auth/'),
                      { timeout: 5000 })
          .then(() => true).catch(() => false);
        if (redirected) {
          // Vérifie qu'on a un cookie de session (pas juste que l'URL a changé).
          const cookies = await page.context().cookies();
          logged = cookies.some(c => c.name === 'openfga_explorer_session');
          if (logged) break;
        }
        // Rate limit probable : on attend ~13s avant de retry.
        await page.waitForTimeout(13_000);
        await page.goto(APP_URL + '/login', { waitUntil: 'domcontentloaded' });
      }
      if (!logged) {
        console.warn('[authedGoto] login failed after 6 attempts (rate limit?)');
      }
    }
  }
  // Si l'URL demandée est explicitement '/home' (ou vide et qu'on veut
  // rester sur le home), on s'arrête ici.
  if (url === '/home') {
    return;
  }
  // Comportement par défaut (url = '/' | undefined | autre chose) : on
  // ouvre la tuile "manage_tuple" pour exposer la vue cartes. Les
  // tests existants s'attendent à voir directement la vue cartes après
  // login.
  // Attendre que la home soit vraiment rendue : après login, la
  // navigation vers / déclenche init() qui appelle showHome() au
  // bout de la chaîne refreshConnection + getMe + auto-select.
  // Si init() est encore en cours, le tile existe dans le DOM mais
  // est "not visible" (parent encore hidden). On attend la classe
  // `home-shown` sur <body> comme signal de readiness.
  await page.waitForFunction(
    () => document.body.classList.contains('home-shown'),
    { timeout: 10000 }
  ).catch(() => {});
  if (await page.locator('.home-tile[data-tile="manage_tuple"]').count() > 0) {
    await page.click('.home-tile[data-tile="manage_tuple"]');
    await page.waitForTimeout(400);
  }
  // Si l'URL demandée est explicite (autre que / ou /home), naviguer.
  if (url && url !== '/' && url !== '/login') {
    await page.goto(APP_URL + url, { waitUntil: 'networkidle' });
  }
}

export async function waitForTuples(page, min = 10) {
  // On utilise 'attached' plutôt que 'visible' : les cards sont attachées
  // au DOM même quand on est sur la home (où le main est masqué via
  // .home-shown). L'état des tuples est ainsi consultable depuis n'importe
  // quelle vue.
  await page.waitForSelector('.node-card', { state: 'attached', timeout: 15000 });
  await page.waitForFunction(min => document.querySelectorAll('.node-card').length >= min, min);
}

export async function countTuples(page) {
  return page.evaluate(() => {
    const stat = document.querySelector('#stats');
    if (!stat) return 0;
    for (const l of stat.querySelectorAll('.stat')) {
      const lab = l.querySelector('.label')?.textContent;
      const val = l.querySelector('.value')?.textContent;
      if (lab === 'Tuples') return parseInt(val, 10) || 0;
    }
    return 0;
  });
}

export function report(name, ok, details) {
  const tag = ok ? '\u2713' : '\u2717';
  console.log(`${tag} ${name}${details ? ' \u2014 ' + details : ''}`);
  return ok;
}

const homeShown = page => page.waitForFunction(() => document.body.classList.contains('home-shown'), null, { timeout: 15000 });

/** Choisit un store (par nom) pour la session de la page. Attend la fin
 *  de l'initialisation pour ne pas couper ses requêtes en cours. Ne
 *  recharge pas : voir openStore. */
export async function useStore(page, name) {
  if (!page.url().includes('/login')) await homeShown(page).catch(() => {});
  const id = await page.evaluate(async name => {
    const { stores } = await fetch('/api/stores').then(r => r.json());
    const s = stores.find(s => s.name === name);
    if (!s) return null;
    await fetch('/api/stores/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: s.id }) });
    return s.id;
  }, name);
  if (!id) throw new Error(`store ${name} introuvable`);
  return id;
}

/** Connexion, choix du store, puis vue cartes chargée (ou l'accueil avec
 *  view = 'home'). Les tests ne dépendent ainsi pas du store par défaut. */
export async function openStore(page, name, view = 'cards') {
  await authedGoto(page, '/home');
  await useStore(page, name);
  await page.reload();
  await homeShown(page);
  if (view === 'home') return;
  await page.click('.home-tile[data-tile="manage_tuple"]');
  await page.waitForSelector('#grid .node-card');
}

/** Crée directement dans OpenFGA un store jetable avec un modèle minimal
 *  (user, document#viewer). Renvoie { id, name, remove() }. */
export async function createScratchStore(prefix) {
  const name = `${prefix}-${Date.now()}`;
  const store = await fetch(`${OPENFGA_URL}/stores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(r => r.json());
  await fetch(`${OPENFGA_URL}/stores/${store.id}/authorization-models`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        { type: 'document', relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
      ],
    }),
  });
  return { id: store.id, name, remove: () => fetch(`${OPENFGA_URL}/stores/${store.id}`, { method: 'DELETE' }) };
}
