// scripts/take-screenshots.mjs — Regenerates docs/screenshots/.
//
// Needs a running Explorer with auth disabled and the demo stores
// (docker compose -f docker-compose.yml -f examples/seeder.yml up), plus
// Playwright: `cd tests && npm install`, then `node ../scripts/take-screenshots.mjs`.
//
//   BASE       Explorer URL                    (default http://localhost:8000)
//   STORE      demo store name                 (default example-07-lakekeeper)
//   OBJECT     object for the "who has access" capture (default warehouse:warehouse_1_2)
//   K8S_STORE  store with the Kubernetes webhook model (default example-08-kubernetes)

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8000';
const STORE = process.env.STORE || 'example-07-lakekeeper';
const OBJECT = process.env.OBJECT || 'warehouse:warehouse_1_2';
const K8S_STORE = process.env.K8S_STORE || 'example-08-kubernetes';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'screenshots');

const browser = await chromium.launch();
// bypassCSP : le script injecte son propre CSS (masquer les toasts), ce que
// la CSP de l'application interdit à juste titre.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
const page = await ctx.newPage();

const stores = await (await fetch(`${BASE}/api/stores`)).json();
const storeId = name => (stores.stores || []).find(s => s.name === name)?.id;

async function shot(name) {
  await page.addStyleTag({ content: '#toast { display: none !important; }' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

async function open(id, theme = 'light') {
  await page.addInitScript(t => {
    localStorage.setItem('openfga-explorer.theme', t);
  }, theme);
  await page.goto(`${BASE}/?store=${id}`);
  await page.waitForFunction(() => document.querySelector('#home-types li'), null, { timeout: 15000 });
}

async function nav(tile, selector) {
  await page.click(`.nav-item[data-nav="${tile}"]`);
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.waitForTimeout(800);
}

await mkdir(OUT, { recursive: true });
const demo = storeId(STORE);
if (!demo) throw new Error(`store ${STORE} not found on ${BASE}`);

await open(demo, 'dark');
await shot('dashboard-dark');
await open(demo);
await shot('dashboard');

await nav('manage_tuple', '#grid .card');
await shot('tuples-cards');
await page.click('#view-graph');
await page.waitForTimeout(2500);
await shot('tuples-graph');

await nav('access', '#access-form');
const [type, id] = OBJECT.split(':');
await page.selectOption('#access-form select[name="type"]', type);
await page.fill('#access-form input[name="id"]', id);
await page.click('#access-form button[type="submit"]');
await page.waitForSelector('#access-results table, #access-results .access-empty', { timeout: 15000 });
await shot('access-object');

await nav('audit', '#audit-page:not([hidden])');
await shot('audit');
await nav('assertions', '#assertions-page:not([hidden])');
await shot('assertions');
await nav('import_export', '#io-page:not([hidden])');
await shot('io');
await nav('admin_dsl', '#dsl-page:not([hidden])');
// Première visite : la page présente ses commandes, on la referme.
await page.click('#dsl-tour-close');
await shot('dsl');
await page.click('#btn-generate-sdk');
await page.waitForSelector('#codegen-backdrop:not([hidden])', { timeout: 10000 });
await shot('codegen');

const k8s = storeId(K8S_STORE);
if (k8s) {
  await open(k8s);
  await nav('access', '#access-form');
  await page.click('#access-tabs [data-access-tab="kubectl"]');
  await page.fill('#access-form input[name="user"]', 'alice');
  await page.fill('#access-form input[name="groups"]', 'billing-team');
  await page.selectOption('#access-form select[name="verb"]', 'create');
  await page.fill('#access-form input[name="subresource"]', 'exec');
  await page.fill('#access-form input[name="namespace"]', 'billing');
  await page.click('#access-form button[type="submit"]');
  await page.waitForSelector('#access-results > *', { timeout: 15000 });
  await shot('access-kubectl');
} else {
  console.log(`  - access-kubectl skipped (no store named ${K8S_STORE})`);
}

await browser.close();
