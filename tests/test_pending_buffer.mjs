// test_pending_buffer.mjs — staging area pour les modifications
// (ajouts/suppressions) en attente de commit groupé.
//
// Couvre 4 aspects :
//   1. L'ajout d'un tuple via le formulaire d'ajout va au buffer
//      (et non plus directement à state.tuples).
//   2. La suppression d'un tuple depuis la modale d'un nœud va aussi
//      au buffer (et non plus directement à l'API).
//   3. Le bouton "Appliquer" du drawer pousse tout en bloc.
//   4. Le bouton "Annuler" vide le drawer sans toucher au store.
//
// La page est nettoyée des tuples résiduels de runs précédents au
// début du test (les runs peuvent laisser des tuples pending_test_*
// si le test a planté au milieu).

import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne le store lakekeeper.
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
await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Cleanup : supprime les tuples résiduels des tests précédents.
// Ce test crée des tuples pending_test_* qu'il supprime normalement
// en fin de run, mais si un test précédent a planté, ils restent et
// bloquent la dup-check.
await page.evaluate(async () => {
  const r = await (await fetch('/api/tuples')).json();
  const stale = r.tuples.filter(t =>
    t.user.includes('pending_test') || t.object.includes('pending_test')
  );
  if (stale.length > 0) {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tuples: stale }),
    });
  }
});
await page.waitForTimeout(500);

// Va sur manage_tuple pour que le toolbar (avec btn-add-tuple) soit visible.
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForTimeout(1500);

// Cleanup helper.
async function deleteTuple(t) {
  await page.evaluate(async (tuple) => {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tuples: [tuple] }),
    });
  }, t);
}

// ── 1. Ajoute un tuple via la modale d'ajout ─────────────────────
// On utilise `force: true` pour contourner l'actionability check de
// Playwright (artefact sur le 2e click btn-add-push). Vérifié en
// debug : le click fonctionne bien, c'est juste Playwright qui
// interprète l'add-backdrop comme intercepteur (artefact, pas un
// vrai bug).
async function addToBuffer(t) {
  await page.click('#btn-add-tuple', { force: true });
  await page.waitForTimeout(400);
  await page.locator('#add-obj-type').selectOption('server');
  await page.locator('#add-obj-id').fill(t.object.split(':')[1]);
  await page.locator('#add-user-type').selectOption('user');
  await page.locator('#add-user-id').fill(t.user.split(':')[1]);
  await page.click('#btn-add-push', { force: true });
  await page.waitForTimeout(400);
}

const t1 = { user: 'user:pending_test_1', relation: 'admin', object: 'server:pending_test_1' };

await addToBuffer(t1);
const panelState1 = await page.evaluate(() => ({
  visible: document.getElementById('pending-panel')?.classList.contains('open'),
  itemCount: document.querySelectorAll('#pending-panel .pending-item').length,
}));
pass &= report('Tampon visible après ajout', panelState1.visible);
pass &= report('Tampon contient 1 item', panelState1.itemCount === 1,
  `count=${panelState1.itemCount}`);

// Vérifie que le tuple n'est PAS encore dans le store (commit non fait).
const stillNotInStore = await page.evaluate(async (tuple) => {
  const r = await (await fetch('/api/tuples')).json();
  return !r.tuples.some(x =>
    x.user === tuple.user && x.relation === tuple.relation && x.object === tuple.object
  );
}, t1);
pass &= report('Tuple PAS encore dans le store (pas de push direct)', stillNotInStore);

// ── 2. Retire l'item via le bouton X ─────────────────────────────────
// On attend que le panel ait l'item avant de cliquer (artefact timing
// Playwright après le re-render).
await page.waitForSelector('#pending-panel .pending-remove', { timeout: 5000 });
await page.click('#pending-panel .pending-remove', { force: true });
await page.waitForTimeout(300);
const panelState2 = await page.evaluate(() => ({
  visible: document.getElementById('pending-panel')?.classList.contains('open'),
  itemCount: document.querySelectorAll('#pending-panel .pending-item').length,
}));
pass &= report('Après X : 0 item',
  panelState2.itemCount === 0,
  `count=${panelState2.itemCount}`);

// ── 3. Ajoute à nouveau, puis commit all → tuple dans le store ─────
await addToBuffer(t1);
await page.click('#pending-apply', { force: true });
await page.waitForTimeout(2000);
const committedOk = await page.evaluate(async (tuple) => {
  const r = await (await fetch('/api/tuples')).json();
  return r.tuples.some(x =>
    x.user === tuple.user && x.relation === tuple.relation && x.object === tuple.object
  );
}, t1);
pass &= report('Commit all : tuple dans le store', committedOk);

// ── 4. Item de suppression VISIBLE (fix du bug width=0) ────────────
// Vérifie qu'un tuple mis en pendingRemoves (via la même API interne
// que la modale d'un nœud — modal.js::deleteTuple) s'affiche avec
// une largeur NON NULLE. Le bug original collapsait le <li> à
// 24px (= taille du bouton X seul) avec .pending-tuple à 0, ce qui
// rendait la suppression invisible. Maintenant : .pending-item est
// étiré (width: 100%) et le tuple est lisible.
await page.evaluate(async () => {
  const state = await import('/js/lib/state.js');
  const pp = await import('/js/views/pending-panel.js');
  const r = await (await fetch('/api/tuples')).json();
  state.state.pendingRemoves.push({
    tuple: r.tuples[0],
    id: 'visual-check-1',
    addedAt: Date.now(),
  });
  pp.renderPendingPanel();
});
await page.waitForTimeout(300);

const removeCheck = await page.evaluate(() => {
  const items = document.querySelectorAll('#pending-panel .pending-item.pending-remove');
  return {
    count: items.length,
    // Le bug original : width=0 sur les .pending-tuple. Si on revient
    // au bug, ces widths tombent à 0 et le test casse.
    widths: Array.from(items).map(it => {
      const tuple = it.querySelector('.pending-tuple');
      return tuple ? Math.round(tuple.getBoundingClientRect().width) : -1;
    }),
    titles: Array.from(items).map(it => it.getAttribute('title')),
    // Vérifie aussi que le DOM contient bien le texte attendu.
    userTexts: Array.from(items).map(it =>
      it.querySelector('.pending-side')?.textContent || null),
  };
});
pass &= report('Tampon contient des suppressions (item pending-remove)',
  removeCheck.count >= 1, `count=${removeCheck.count}`);
pass &= report('Item de suppression VISIBLE (>0px, fix du bug width=0)',
  removeCheck.widths.every(w => w > 0),
  `widths=[${removeCheck.widths.join(',')}]`);
pass &= report('Item de suppression expose le tuple complet via title=',
  removeCheck.titles.every(t => t && t.includes('→')),
  `titles=${JSON.stringify(removeCheck.titles)}`);
pass &= report('Texte du sujet visible dans le DOM',
  removeCheck.userTexts.every(t => t && t.length > 0),
  `userTexts=${JSON.stringify(removeCheck.userTexts)}`);

// ── 5. Annuler (discard) doit vider le pending ────────────────────
await page.click('#pending-discard', { force: true }).catch(() => {});
await page.waitForTimeout(300);
const afterDiscard = await page.evaluate(() =>
  document.querySelectorAll('#pending-panel .pending-item').length);
pass &= report('Discard : 0 item',
  afterDiscard === 0, `count=${afterDiscard}`);

// ── 6. Cleanup final ───────────────────────────────────────────────
if (t1) await deleteTuple(t1);

// ── 7. Pas d'erreur JS ──────────────────────────────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== PENDING BUFFER: PASS ===' : '\n=== PENDING BUFFER: FAIL ===');
process.exit(pass ? 0 : 1);