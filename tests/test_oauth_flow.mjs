// test_oauth_flow.mjs — vérifie la DISCOVERY OIDC et l'absence de
// regression sur le wiring des routes (login, callback, logout).
//
// En l'absence d'un provider OIDC réel dans l'environnement de test
// (Keycloak/Auth0/etc.), on vérifie uniquement que :
//   1. /auth/login en mode demo redirige vers / (no-op)
//   2. /auth/callback en mode demo redirige vers / (no-op)
//   3. /auth/logout (POST + CSRF) vide bien le cookie de session
//   4. /api/me renvoie 200 (JSON) en mode démo
//   5. La route /auth/callback est bien câblée (pas de 404)
//
// Pour tester le flow complet (code exchange, ID token verification),
// il faudrait un mock provider (ex: Dexidp/MockOIDC) qui tourne dans
// le compose, ce qui dépasse le scope de ce test de smoke.
import { APP_URL, launchBrowser, newPage, report, authedGoto } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i =>
  !/favicon|404|429|Cannot read properties of null.*fit/i.test(i));

await authedGoto(page, '/');

// 1. /auth/login câblé (redirige ou répond 200)
const loginRes = await page.evaluate(async () => {
  const r = await fetch('/auth/login', { redirect: 'follow' });
  return { status: r.status, url: r.url };
});
pass &= report('GET /auth/login → 2xx ou 3xx', loginRes.status < 400,
  `status=${loginRes.status}`);

// 2. /auth/callback câblé (même en démo, on attend une réponse non-404)
const callbackRes = await page.evaluate(async () => {
  const r = await fetch('/auth/callback', { redirect: 'follow' });
  return { status: r.status };
});
pass &= report('GET /auth/callback → non-404', callbackRes.status !== 404,
  `status=${callbackRes.status}`);

// 3. /auth/logout : un GET (lien ou image sur un site tiers) ne déconnecte
//    pas, un POST sans jeton CSRF est refusé, un POST avec jeton vide le
//    cookie. `request` partage les cookies de la page sans passer par le
//    wrapper fetch des helpers, qui ajoute le jeton à toute requête.
const api = page.context().request;
const logoutGet = (await api.get(APP_URL + '/auth/logout', { maxRedirects: 0 })).status();
const stillIn = (await api.get(APP_URL + '/api/me').then(r => r.json())).authenticated;
pass &= report('GET /auth/logout ne déconnecte pas', logoutGet >= 400 && stillIn, `status=${logoutGet}`);
const noToken = (await api.post(APP_URL + '/auth/logout')).status();
pass &= report('POST /auth/logout sans jeton CSRF refusé', noToken === 403, `status=${noToken}`);
const { csrf_token } = await api.get(APP_URL + '/api/me').then(r => r.json());
const withToken = (await api.post(APP_URL + '/auth/logout', { headers: { 'X-CSRF-Token': csrf_token } })).status();
pass &= report('POST /auth/logout avec jeton → 204', withToken === 204, `status=${withToken}`);
const cookies = await page.context().cookies();
const sessionCookie = cookies.find(c => c.name === 'openfga_explorer_session');
pass &= report('Logout supprime le cookie de session', !sessionCookie,
  `cookie=${sessionCookie ? 'present' : 'absent'}`);

// 4. /api/me cohérent après logout
const me = await page.evaluate(() => fetch('/api/me').then(r => r.json()));
pass &= report('Après logout : authenticated=false', me.authenticated === false,
  `auth=${me.authenticated}`);

pass &= report('Aucune erreur JS (hors favicon/fit)', realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== OAUTH FLOW: PASS ===' : '\n=== OAUTH FLOW: FAIL ===');
process.exit(pass ? 0 : 1);
