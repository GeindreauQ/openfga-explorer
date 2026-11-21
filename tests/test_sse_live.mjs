// test_sse_live.mjs — Mises à jour en direct : un tuple écrit depuis un
// onglet apparaît dans un autre onglet ouvert sur le même store, sans
// rechargement (flux SSE /api/events).
import { APP_URL, getAdminPassword, launchBrowser, newPage, authedGoto, useStore, createScratchStore, report } from './_helpers.mjs';

const store = await createScratchStore('e2e-sse');
const browser = await launchBrowser();
let pass = true;
try {
  // Onglet qui observe : connexion à la main pour garder le SSE actif
  // (authedGoto le coupe pour pouvoir attendre networkidle).
  const watcher = await newPage(browser);
  const w = watcher.page;
  await w.goto(APP_URL + '/login');
  await w.fill('#username', 'admin');
  await w.fill('#password', getAdminPassword());
  await w.click('button[type=submit]');
  await w.waitForFunction(() => document.body.classList.contains('home-shown'));
  await useStore(w, store.name);
  await w.reload();
  await w.waitForFunction(() => document.body.classList.contains('home-shown'));
  await w.click('.home-tile[data-tile="manage_tuple"]');
  await w.waitForSelector('#grid .empty, #grid .node-card', { state: 'attached' }).catch(() => {});
  const before = await w.locator('.node-card').count();

  // Onglet qui écrit, avec sa propre session.
  const writer = await newPage(browser);
  await authedGoto(writer.page, '/home');
  await useStore(writer.page, store.name);
  const status = await writer.page.evaluate(() => fetch('/api/tuples', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tuples: [{ user: 'user:sse-alice', relation: 'viewer', object: 'document:sse-live' }] }),
  }).then(async r => `${r.status} ${await r.text()}`));
  pass &= report('Écriture acceptée', status.startsWith('200'), status);

  const seen = await w.waitForFunction(() => /par un autre client/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  pass &= report("L'autre onglet est prévenu", seen);
  const appeared = await w.waitForFunction(n => document.querySelectorAll('.node-card').length > n, before, { timeout: 10000 })
    .then(() => true).catch(() => false);
  pass &= report('Le tuple apparaît sans rechargement', appeared,
    `${before} → ${await w.locator('.node-card').count()} cartes`);
  pass &= report('Carte du nouvel objet', await w.locator('.node-card', { hasText: 'sse-live' }).count() > 0);
} finally {
  await browser.close();
  await store.remove();
}
console.log(pass ? '\n=== SSE LIVE: PASS ===' : '\n=== SSE LIVE: FAIL ===');
process.exit(pass ? 0 : 1);
