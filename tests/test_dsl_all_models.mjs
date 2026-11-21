// test_dsl_all_models.mjs — la page Admin DSL affiche le graphe
// correctement pour chaque modèle seed (le validateur doit recevoir
// les conditions en paramètre).

import { APP_URL, launchBrowser, newPage, getAdminPassword, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await page.goto(APP_URL + '/login', { waitUntil: 'domcontentloaded' });
const pwd = getAdminPassword();
await page.fill('#username', 'admin');
await page.fill('#password', pwd);
await page.click('button[type=submit]');
await page.waitForTimeout(3000);

const models = [
  'example-01-github-like',
  'example-02-expired-grants',
  'example-03-ip-allowlist',
  'example-04-gdrive',
  'example-05-entitlements',
  'example-06-lakekeeper-like',
  'example-07-lakekeeper',
];

for (const modelName of models) {
  await page.evaluate(async (name) => {
    const stores = await (await fetch('/api/stores')).json();
    const s = stores.stores.find(x => x.name === name);
    if (s) await fetch('/api/stores/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({storeId: s.id}) });
  }, modelName);
  await page.waitForTimeout(1000);
  await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.click('.home-tile[data-tile="admin_dsl"]');
  await page.waitForTimeout(800);
  const tour = await page.locator('#dsl-tour').isVisible().catch(() => false);
  if (tour) { await page.click('#dsl-tour-close'); await page.waitForTimeout(300); }
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => ({
    types: document.querySelector('#dsl-type-count')?.textContent,
    status: document.querySelector('#dsl-status-text')?.textContent,
    graphNodes: document.querySelectorAll('.dsl-node').length,
  }));

  // Le status "0 erreur" est OK. On flag une vraie erreur si le
  // status contient "N erreur(s)" avec N > 0.
  const errMatch = (info.status || '').match(/(\d+)\s+erreur/i);
  const errCount = errMatch ? parseInt(errMatch[1], 10) : 0;
  const hasGraph = info.graphNodes > 0;
  pass &= report(`${modelName} : graphe rendu (>0 nodes)`,
    hasGraph, `nodes=${info.graphNodes}`);
  pass &= report(`${modelName} : status sans erreur`,
    errCount === 0, `status="${info.status}"`);
}

pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== DSL ALL MODELS: PASS ===' : '\n=== DSL ALL MODELS: FAIL ===');
process.exit(pass ? 0 : 1);