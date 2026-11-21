// test_url_state.mjs — sérialisation de l'état UI dans l'URL.
//
// Scénario :
//   1. Au login, l'URL est "clean" (pas de query params).
//   2. Cliquer une tuile (manage_tuple, admin_dsl, audit, import_export)
//      sérialise la tile dans l'URL.
//   3. Le bouton Accueil efface l'URL.
//   4. Changer de vue (cards → graph → graph-cy) ajoute view=… à l'URL.
//   5. Sélectionner une racine de focus ajoute focus=…&depth=… à l'URL.
//   6. Taper une recherche ajoute search=… à l'URL.
//   7. Le bouton Share copie l'URL courante dans le presse-papier
//      et déclenche un toast "Lien copié".
//   8. Recharger la page (F5 / nouvelle navigation) sur une URL avec
//      state restaure l'état UI complet.

import { APP_URL, launchBrowser, newPage, authedGoto, report, getAdminPassword } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, ctx, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne un store connu (lakekeeper) pour stabiliser le test.
await page.evaluate(async () => {
  const stores = await (await fetch('/api/stores')).json();
  const lk = (stores.stores || []).find(s => s.name === 'example-07-lakekeeper');
  if (lk) {
    await fetch('/api/stores/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: lk.id }),
    });
  }
});
await page.waitForTimeout(1500);
await page.goto(APP_URL + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ── 1. URL clean au boot sur la home ───────────────────────────────────
const urlOnHome = await page.evaluate(() => window.location.search);
pass &= report('URL clean au boot sur la home', urlOnHome === '',
  `url.search="${urlOnHome}"`);

// ── 2. Clic tuile → URL contient tile=… ────────────────────────────────
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForTimeout(500);
const urlAfterManage = await page.evaluate(() => window.location.search);
pass &= report('Tuile manage_tuple → URL contient tile=manage_tuple',
  urlAfterManage.includes('tile=manage_tuple'),
  `url="${urlAfterManage}"`);

// ── 3. Vue graphe ajoute view=graph ────────────────────────────────────
await page.click('#view-graph');
await page.waitForTimeout(500);
const urlAfterGraph = await page.evaluate(() => window.location.search);
pass &= report('Vue graph → URL contient view=graph',
  urlAfterGraph.includes('view=graph'),
  `url="${urlAfterGraph}"`);

// ── 4. Retour à la home : URL clean ───────────────────────────────────
await page.click('#btn-home');
await page.waitForTimeout(500);
const urlAfterHome = await page.evaluate(() => window.location.search);
pass &= report('Bouton Accueil → URL clean (pas de query params)',
  urlAfterHome === '', `url.search="${urlAfterHome}"`);

// ── 5. Tile admin_dsl sérialise tile=admin_dsl ────────────────────────
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(500);
// Le tour modal s'affiche à la 1ère visite — on le ferme.
const dslTour = await page.locator('#dsl-tour').isVisible().catch(() => false);
if (dslTour) {
  await page.click('#dsl-tour-close');
  await page.waitForTimeout(300);
}
const urlAfterDsl = await page.evaluate(() => window.location.search);
pass &= report('Tuile admin_dsl → URL contient tile=admin_dsl',
  urlAfterDsl.includes('tile=admin_dsl'),
  `url="${urlAfterDsl}"`);

// ── 6. Bouton Share présent + copie l'URL + toast ─────────────────────
const shareBtnCount = await page.locator('#btn-share').count();
pass &= report('Bouton Share présent dans le header', shareBtnCount === 1);

// Prépare un listener sur le clipboard via le contexte navigateur.
// Playwright permet d'accorder la permission clipboard-write par origin.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });
await page.click('#btn-share');
await page.waitForTimeout(500);
const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
pass &= report('Bouton Share → URL copiée dans le presse-papier',
  clipboardContent.includes('tile=admin_dsl'),
  `clipboard="${clipboardContent.slice(0, 100)}"`);
const toastVisible = await page.locator('#toast.show').count();
pass &= report('Bouton Share → toast "Lien copié" affiché', toastVisible === 1);

// ── 7. Restore : URL avec state → reload → même état UI ───────────────
// Retour à la home pour partir d'un état propre.
await page.click('#btn-home');
await page.waitForTimeout(300);
// Construit une URL riche : store + tile + view + focus + search + depth.
const richUrl = await page.evaluate(async () => {
  const stores = await (await fetch('/api/stores')).json();
  const lk = (stores.stores || []).find(s => s.name === 'example-07-lakekeeper');
  // Récupère un raw node existant pour le focus
  const tuples = await (await fetch('/api/tuples')).json();
  const userRaw = tuples.tuples?.map(t => t.user)?.find(u => u.startsWith('user:')) || '';
  const sp = new URLSearchParams();
  if (lk) sp.set('store', lk.id);
  sp.set('tile', 'manage_tuple');
  sp.set('view', 'graph');
  sp.set('focus', userRaw);
  sp.set('depth', '3');
  sp.set('search', 'lake');
  return window.location.pathname + '?' + sp.toString();
});
await page.goto(APP_URL + richUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Vérifie que l'état UI a été restauré.
const restored = await page.evaluate(() => ({
  url: window.location.search,
  tile: window.location.search.includes('tile=manage_tuple'),
  view: window.location.search.includes('view=graph'),
  focus: window.location.search.includes('focus=user:'),
  depth: window.location.search.includes('depth=3'),
  search: window.location.search.includes('search=lake'),
  graphViewActive: document.getElementById('view-graph')?.classList.contains('active'),
  searchValue: document.getElementById('search')?.value,
  focusRootValue: document.getElementById('focus-root')?.value,
  depthValue: document.getElementById('tree-depth')?.value,
}));
pass &= report('Restore : URL conserve les params (focus encodé OK)',
  /focus=user%3A/.test(restored.url) && /depth=3/.test(restored.url)
    && /search=lake/.test(restored.url) && /view=graph/.test(restored.url),
  `url="${restored.url.slice(0, 100)}"`);
pass &= report('Restore : vue graph active', restored.graphViewActive === true);
pass &= report('Restore : champ search rempli', restored.searchValue === 'lake',
  `got="${restored.searchValue}"`);
pass &= report('Restore : focus-root select rempli',
  (restored.focusRootValue || '').startsWith('user:'),
  `got="${restored.focusRootValue}"`);
pass &= report('Restore : slider depth à 3', restored.depthValue === '3',
  `got="${restored.depthValue}"`);

// ── 8. Pas d'erreur JS pendant tout le scénario ───────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== URL STATE: PASS ===' : '\n=== URL STATE: FAIL ===');
process.exit(pass ? 0 : 1);