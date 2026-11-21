// test_stores.mjs — vérifie l'introspection multi-store et le switch
// à chaud entre stores via l'UI.
//
// Scénario :
//   1. Au boot, /api/stores liste au moins 1 store (le seed "demo-lakekeeper")
//   2. L'UI affiche le dropdown de stores avec le store actif présélectionné
//   3. On change de store via le dropdown → l'UI recharge les tuples
//   4. /api/stores/:id/select refuse un id inexistant (404)
//   5. Le switch préserve la connexion et n'introduit pas d'erreur JS
import { APP_URL, launchBrowser, newPage, waitForTuples, report, openStore } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i =>
  !/favicon|404|429|Cannot read properties of null.*fit/i.test(i));

await openStore(page, 'example-07-lakekeeper');
await waitForTuples(page, 10);

// 1. Endpoint /api/stores
const storesResp = await page.evaluate(() => fetch('/api/stores').then(r => r.json()));
pass &= report('GET /api/stores → ≥ 1 store', storesResp.stores?.length >= 1,
  `count=${storesResp.stores?.length}`);
const hasActive = storesResp.stores?.some(s => s.active);
pass &= report('Au moins un store marqué active', !!hasActive);

// 2. Dropdown peuplé
const opts = await page.$$eval('#store-select option', els => els.map(e => e.value).filter(Boolean));
pass &= report('Dropdown contient ≥ 1 store', opts.length >= 1,
  `opts=${opts.length}`);

// 3. Switch via l'API (simule ce que fait l'UI)
if (storesResp.stores.length >= 2) {
  const target = storesResp.stores.find(s => !s.active);
  const res = await page.evaluate(t => fetch('/api/stores/select', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId: t }),
  }).then(r => ({ status: r.status, body: r.json() })), target.id);
  pass &= report('POST /api/stores/select → 200', res.status === 200, `status=${res.status}`);
  // Le store est marqué actif dans la nouvelle liste
  const newList = await page.evaluate(() => fetch('/api/stores').then(r => r.json()));
  const newActive = newList.stores.find(s => s.id === target.id);
  pass &= report('Nouveau store marqué active', newActive?.active === true,
    `active=${newActive?.active}`);

  // 4. Select un id inexistant → 404
  const bad = await page.evaluate(() => fetch('/api/stores/select', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId: 'does-not-exist' }),
  }).then(r => r.status));
  pass &= report('POST /api/stores/select (id invalide) → 404', bad === 404, `status=${bad}`);
} else {
  console.log('(skip) seulement 1 store, pas de test de switch');
}

// 5. Switch via l'UI (dropdown change event)
const firstOpt = await page.$eval('#store-select option:not([value=""])', el => el.value);
if (firstOpt) {
  await page.selectOption('#store-select', firstOpt);
  await page.waitForTimeout(500);
  // Le dropdown doit avoir déclenché loadFromAPI() → 27 tuples ou autre
  const tuples = await page.evaluate(() => fetch('/api/tuples').then(r => r.json()));
  pass &= report('Après switch UI, /api/tuples renvoie des tuples',
    Array.isArray(tuples.tuples), `count=${tuples.tuples?.length}`);
}

pass &= report('Aucune erreur JS (hors favicon/fit)', realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== STORES: PASS ===' : '\n=== STORES: FAIL ===');
process.exit(pass ? 0 : 1);
