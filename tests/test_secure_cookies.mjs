// test_secure_cookies.mjs — vérifie l'attribut `Secure` du cookie de
// session posé par /auth/local. Le comportement dépend de la variable
// d'env `SECURE_COOKIES` du serveur :
//   - SECURE_COOKIES=0 (défaut dev) → pas d'attribut Secure
//   - SECURE_COOKIES=1 (HTTPS prod) → attribut Secure présent
//
// On lit la config via `docker exec` (le endpoint /api/health ne
// l'expose pas) et on inspecte la réponse brute de /auth/local.
//
// Note technique : on utilise `playwright.request` (APIRequestContext)
// plutôt que `fetch` côté navigateur car Chromium masque les headers
// (dont Set-Cookie) sur les redirects manuels. L'APIRequestContext
// est construite sur la même pile HTTP que le navigateur et expose
// tous les headers.
//
// Tolérance : si un test précédent (rate_limit) a vidé le token
// bucket de notre IP, on attend ~12s par token à recharger.
import { APP_URL, launchBrowser, newPage, report, getAdminPassword } from './_helpers.mjs';
import { request as pwRequest } from 'playwright';
import { execSync } from 'node:child_process';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;

// 1. Config serveur (env du container).
let secureEnabled = false;
try {
  const env = execSync(
    'docker exec openfga-explorer printenv SECURE_COOKIES 2>/dev/null',
    { encoding: 'utf8' }
  ).trim();
  secureEnabled = env === '1';
} catch {
  secureEnabled = false;
}

// 2. POST /auth/local via l'API HTTP de Playwright (qui expose
//    Set-Cookie même sur les redirects). Tolère un bucket vide.
await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});

const pwd = getAdminPassword();
const api = await pwRequest.newContext({ baseURL: APP_URL });

let resp = null, setCookieHeaders = [], attempts = 0;
for (let i = 0; i < 12; i++) {
  attempts++;
  resp = await api.post('/auth/local', {
    form: { username: 'admin', password: pwd },
    maxRedirects: 0,
  });
  setCookieHeaders = resp.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie');
  if (resp.status() === 302 && setCookieHeaders.length > 0) break;
  if (resp.status() === 429) { await new Promise(r => setTimeout(r, 13_000)); continue; }
  break; // autre cas
}

pass &= report(`POST /auth/local avec bons identifiants → 302 (tentatives=${attempts})`,
  resp && resp.status() === 302, `status=${resp ? resp.status() : 'null'}`);
pass &= report('Réponse contient un Set-Cookie de session',
  setCookieHeaders.length > 0,
  setCookieHeaders[0]?.value?.slice(0, 80) + '...');

// 3. Assertion sur l'attribut Secure.
const setCookieValue = setCookieHeaders[0]?.value || '';
const cookieAttrs = setCookieValue.split(';').map(s => s.trim());
const hasSecureAttr = cookieAttrs.some(s => /^Secure$/i.test(s));

if (secureEnabled) {
  pass &= report('SECURE_COOKIES=1 → cookie porte Secure', hasSecureAttr,
    `cookie=${setCookieValue.slice(0, 100)}`);
} else {
  pass &= report('SECURE_COOKIES=0 (dev) → cookie sans Secure', !hasSecureAttr,
    `cookie=${setCookieValue.slice(0, 100)}`);
}

await api.dispose();
const realIssues = issues.filter(i => !/favicon|404|429/i.test(i));
pass &= report('Aucune erreur JS (hors 429)', realIssues.length === 0,
  realIssues.length ? realIssues.slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== SECURE COOKIES: PASS ===' : '\n=== SECURE COOKIES: FAIL ===');
process.exit(pass ? 0 : 1);

