// test_rate_limit.mjs — vérifie le rate limiting sur POST /auth/local.
//
// Envoie N tentatives successives avec un mauvais mot de passe et
// s'attend à voir au moins une réponse HTTP 429 avec un header
// `Retry-After`. Le seuil exact (5/min par défaut) dépend du token
// bucket par IP, qui peut avoir été partiellement consommé par
// d'autres tests : on reste sur des assertions structurelles plutôt
// que de compter les 302 exacts.
import { APP_URL, launchBrowser, newPage, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;

// Sans navigation préalable, fetch('/auth/local') ne résout pas l'URL
// relative. On charge la racine (sans login — on enverra nous-mêmes
// les POST mauvais mot de passe).
await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});

async function tryLogin() {
  return page.evaluate(async () => {
    const fd = new FormData();
    fd.append('username', 'admin');
    fd.append('password', 'wrong-' + Math.random().toString(36).slice(2, 10));
    const r = await fetch('/auth/local', {
      method: 'POST',
      body: fd,
      redirect: 'manual',
      credentials: 'same-origin',
    });
    return {
      status: r.status,
      retryAfter: r.headers.get('retry-after'),
      body: await r.text().catch(() => ''),
    };
  });
}

// On lance N tentatives : le burst par défaut est 50 (cf.
// RATE_LIMIT_PER_MIN / config.yaml), donc il faut plus que 50 requêtes
// pour saturer le bucket. On en lance 55 pour avoir une marge, tout en
// restant rapide (≈ 1s end-to-end).
const ATTEMPTS = 55;
const results = [];
for (let i = 0; i < ATTEMPTS; i++) results.push(await tryLogin());

// NOTE : avec `redirect: 'manual'`, une 302 apparaît comme status=0
// (response opaque-redirect). On considère 0 OU 302 comme "passé".
const allowed = results.filter(r => r.status === 302 || r.status === 0).length;
const limited = results.filter(r => r.status === 429).length;
const withRetryAfter = results.filter(r => r.status === 429 && r.retryAfter).length;

pass &= report('Au moins 1 réponse 429 (rate-limited)', limited >= 1,
  `allowed=${allowed} limited=${limited} statuses=${results.map(r => r.status).join(',')}`);
pass &= report('Les réponses 429 exposent un header Retry-After', withRetryAfter >= 1,
  `with-retry-after=${withRetryAfter}`);
pass &= report('Réponse 429 en français', results.some(r => r.status === 429 && /trop de tentatives/i.test(r.body)),
  'message présent');

// Les 429 sont attendus : on les exclut du bruit console.
const realIssues = issues.filter(i => !/429|Failed to load resource/i.test(i));
pass &= report('Aucune erreur JS (hors 429 attendus)', realIssues.length === 0,
  realIssues.length ? realIssues.slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== RATE LIMIT: PASS ===' : '\n=== RATE LIMIT: FAIL ===');
process.exit(pass ? 0 : 1);
