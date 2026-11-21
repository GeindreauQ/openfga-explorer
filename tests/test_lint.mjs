// test_lint.mjs — linter sémantique du DSL OpenFGA (cycles, types
// orphelins, références cassées).
//
// Scénario :
//   1. POST /api/dsl/lint avec un modèle propre (pas de cycle, pas
//      d'orphelin) → 0 warnings.
//   2. POST /api/dsl/lint avec un cycle (parent ↔ child via computed
//      userset) → au moins 1 warning "cycle".
//   3. POST /api/dsl/lint avec une relation orpheline → au moins 1
//      warning "orphan_relation".
//   4. UI : ouvre la page DSL → panneau Lint visible avec les warnings
//      du modèle chargé.
//   5. Pas d'erreur JS pendant les manipulations.

import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne le store lakekeeper pour avoir un modèle non-trivial
// côté UI (11 types, 27+ relations → quelques warnings orphelins).
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

// ── 1. POST /api/dsl/lint : modèle propre → 0 warnings sévères ──────
// Le linter ne flag que les relations "orphelines" en `info`. Un
// modèle propre doit donc n'avoir aucun warning de sévérité `warn`
// (les `info` sont OK — les relations publiques assignables via
// tuple sont normales).
const cleanResult = await page.evaluate(async () => {
  const r = await fetch('/api/dsl/lint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: { type_definitions: [
      { type: 'user', relations: {} },
      { type: 'document', relations: {
        owner: { this: {} },
        // editor est référencé par viewer via computedUserset
        editor: { this: {} },
        viewer: { union: { child: [
          { this: {} },
          { computedUserset: { object: 'document', relation: 'owner' } },
          { computedUserset: { object: 'document', relation: 'editor' } },
        ]}},
      }},
    ]}}),
  });
  return r.json();
});
const cleanWarns = cleanResult.warnings.filter(w => w.severity === 'warn');
pass &= report('Lint modèle propre : 0 warning sévère',
  cleanWarns.length === 0,
  `warn=${cleanWarns.length} info=${cleanResult.warnings.length}`);

// ── 2. Cycle : foo.parent ↔ foo.child via computed userset ─────────
const cycleResult = await page.evaluate(async () => {
  const r = await fetch('/api/dsl/lint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: { type_definitions: [
      { type: 'foo', relations: {
        parent: { this: { computedUserset: { object: 'foo', relation: 'child' }}},
        child: { this: { computedUserset: { object: 'foo', relation: 'parent' }}},
      }},
    ]}}),
  });
  return r.json();
});
const cycleWarns = cycleResult.warnings.filter(w => w.code === 'cycle');
pass &= report('Lint cycle : au moins 1 warning "cycle"',
  cycleWarns.length >= 1,
  `count=${cycleWarns.length}`);
pass &= report('Lint cycle : cycle contient ≥ 2 relations',
  cycleWarns[0]?.cycle?.length >= 2,
  `cycle=${JSON.stringify(cycleWarns[0]?.cycle)}`);

// ── 3. Orphelin : relation définie mais jamais référencée ───────────
const orphanResult = await page.evaluate(async () => {
  const r = await fetch('/api/dsl/lint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: { type_definitions: [
      { type: 'user', relations: {} },
      { type: 'foo', relations: {
        admin: { this: {} },
        public_viewer: { this: {} },  // jamais référencée
      }},
    ]}}),
  });
  return r.json();
});
const orphanWarns = orphanResult.warnings.filter(w => w.code === 'orphan_relation');
pass &= report('Lint orphelin : au moins 1 warning "orphan_relation"',
  orphanWarns.length >= 1,
  `count=${orphanWarns.length}`);
pass &= report('Lint orphelin : warning contient "type" + "relation"',
  orphanWarns.some(w => w.type === 'foo' && w.relation === 'public_viewer'),
  `found=${JSON.stringify(orphanWarns.map(w => `${w.type}.${w.relation}`))}`);

// ── 4. UI : panneau Lint visible sur la page DSL ─────────────────────
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(500);
// Dismiss tour
const tour = await page.locator('#dsl-tour').isVisible().catch(() => false);
if (tour) {
  await page.click('#dsl-tour-close');
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1500);
const lintVisible = await page.locator('#dsl-lint-panel').isVisible();
pass &= report('UI : panneau Lint visible sur la page DSL', lintVisible);

const lintText = await page.locator('#dsl-lint-panel').textContent();
pass &= report('UI : panneau Lint affiche au moins une entrée (info/warn)',
  lintText.length > 20,
  `text="${lintText.slice(0, 100)}"`);

// ── 5. Pas d'erreur JS pendant tout le scénario ──────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== LINT: PASS ===' : '\n=== LINT: FAIL ===');
process.exit(pass ? 0 : 1);