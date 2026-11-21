// test_store_diff.mjs — diff structurel entre 2 stores (added / removed /
// changed tuples).
//
// Scénario :
//   1. Sélectionne lakekeeper comme store A.
//   2. Ouvre le picker "Compare" → choisit gdrive comme store B.
//   3. Le modal affiche les compteurs (added/removed/common).
//   4. Pas d'erreur JS.

import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne le store lakekeeper comme A.
await page.evaluate(async () => {
  const stores = await (await fetch('/api/stores')).json();
  const lk = (stores.stores || []).find(s => s.name === 'example-07-lakekeeper');
  if (lk) {
    await fetch('/api/stores/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: lk.id }),
    });
  }
});
await page.waitForTimeout(1500);
await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Va sur manage_tuple pour que le bouton Compare soit visible.
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForTimeout(1000);

// ── 1. Bouton "Compare" présent dans le view-switch ───────────────────
pass &= report('Bouton "Compare" présent dans le view-switch',
  await page.locator('#btn-compare-store').count() === 1);

// ── 2. Click → picker s'ouvre avec ≥ 1 store dans le select ──────────
await page.click('#btn-compare-store');
await page.waitForTimeout(500);
const pickerOpen = await page.evaluate(() =>
  document.getElementById('store-diff-picker')?.classList.contains('open')
);
pass &= report('Picker "Compare avec…" ouvert', pickerOpen);
const bOptions = await page.locator('#store-diff-pick-b option').count();
pass &= report('Picker : ≥ 1 store disponible',
  bOptions >= 1, `count=${bOptions}`);

// ── 3. Choisit gdrive comme B et lance le diff ────────────────────────
await page.locator('#store-diff-pick-b').selectOption({ label: 'example-04-gdrive' });
await page.click('#btn-store-diff-run');
await page.waitForTimeout(3000);

// ── 4. Modal de rapport ouvert avec compteurs ─────────────────────────
const reportState = await page.evaluate(() => ({
  open: document.getElementById('store-diff-backdrop')?.classList.contains('open'),
  stats: document.querySelectorAll('.store-diff-stat').length,
  summary: document.querySelector('.store-diff-summary') !== null,
}));
pass &= report('Modal rapport ouvert', reportState.open);
pass &= report('3 tuiles stats (added/removed/common)', reportState.stats === 3);
pass &= report('Résumé des 2 stores', reportState.summary);

// ── 5. Compteurs accessibles ─────────────────────────────────────────
const counters = await page.evaluate(() => ({
  added: document.querySelector('.store-diff-stat.added strong')?.textContent,
  removed: document.querySelector('.store-diff-stat.removed strong')?.textContent,
  common: document.querySelector('.store-diff-stat.common strong')?.textContent,
}));
console.log('(info) Compteurs:', JSON.stringify(counters));
pass &= report('Compteurs sont des nombres',
  [counters.added, counters.removed, counters.common].every(c => /^\d+$/.test(c || '')));

// ── 6. Bouton X (close) ne doit PAS effacer le diff ─────────────────
// L'utilisateur veut pouvoir fermer le modal tout en gardant la
// coloration des cards (pour voir le graph). Le bouton X ne doit
// que cacher le modal ; le badge "Diff actif" permet de le rouvrir.
await page.click('#btn-store-diff-close');
await page.waitForTimeout(300);
const closeKeptDiff = await page.evaluate(() => {
  // Le modal est fermé mais le badge "Diff actif" est visible.
  const modalClosed = !document.getElementById('store-diff-backdrop')?.classList.contains('open');
  const badge = document.getElementById('diff-active-badge');
  return { modalClosed, badgeVisible: badge !== null };
});
pass &= report('Close X : modal fermé mais badge "Diff actif" visible',
  closeKeptDiff.modalClosed && closeKeptDiff.badgeVisible,
  JSON.stringify(closeKeptDiff));

// ── 6b. Click sur le badge rouvre le modal rapport ──────────────────
await page.click('#diff-active-badge');
await page.waitForTimeout(300);
const reopened = await page.evaluate(() =>
  document.getElementById('store-diff-backdrop')?.classList.contains('open')
);
pass &= report('Badge "Diff actif" : re-ouvre le modal rapport', reopened);

// ── 7. Bouton "Effacer le diff" efface tout (modal + badge) ────────
await page.click('#btn-store-diff-clear');
await page.waitForTimeout(300);
const cleared = await page.evaluate(() => ({
  modalClosed: !document.getElementById('store-diff-backdrop')?.classList.contains('open'),
  badgeGone: document.getElementById('diff-active-badge') === null,
}));
pass &= report('Effacer le diff : modal fermé + badge disparu',
  cleared.modalClosed && cleared.badgeGone,
  JSON.stringify(cleared));

// ── 7. Pas d'erreur JS ──────────────────────────────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== STORE DIFF: PASS ===' : '\n=== STORE DIFF: FAIL ===');
process.exit(pass ? 0 : 1);