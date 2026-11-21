// test_import_preview.mjs — dry-run / preview de l'import tuples
// avant écriture effective (rapport d'erreurs + détection de doublons).
//
// Scénario :
//   1. Tuile "Import / Export" → page dédiée → onglet Import.
//   2. Bouton "Prévisualiser" présent (à côté de "Importer").
//   3. Preview d'un JSONL valide de 3 lignes → modal "3 ajoutés, 0 doublons, 0 erreurs"
//      + boutons "Confirmer l'import" / "Annuler".
//   4. Preview d'un JSONL avec 2 doublons + 1 invalide → modal détaille les 3 problèmes.
//   5. Preview puis "Confirmer" → le store est mis à jour avec exactement
//      les tuples valides, le textarea se vide, le store contient les tuples.
//   6. Preview puis "Annuler" → le store n'est pas touché.
//   7. Garde-fou double-clic : Confirmer se désactive immédiatement après clic
//      (pas de double-écriture possible).
//   8. Bouton "Importer" direct (sans preview) reste fonctionnel pour rétro-compat.

import { APP_URL, launchBrowser, newPage, authedGoto, report, getAdminPassword } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne le store lakekeeper (27 tuples) pour stabiliser.
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
await page.waitForTimeout(1000);

// ── 1. Page I/O + onglet Import + bouton Prévisualiser ───────────────
await page.click('.home-tile[data-tile="import_export"]');
await page.waitForTimeout(500);
await page.click('[data-io-mode="import"]');
await page.waitForTimeout(400);
pass &= report('Tuile + onglet Import : page visible',
  await page.locator('#io-import-textarea').isVisible());
pass &= report('Bouton "Prévisualiser" présent',
  await page.locator('#btn-run-preview').count() === 1);
pass &= report('Bouton "Importer" toujours présent (rétro-compat)',
  await page.locator('#btn-run-import').count() === 1);

// Cleanup helper : supprime un tuple via l'API.
async function deleteTuple(t) {
  await page.evaluate(async (tuple) => {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tuples: [tuple] }),
    });
  }, t);
}

// ── 2. Preview d'un JSONL valide : 3 lignes uniques ──────────────────
const validTuples = [
  { user: 'user:preview_t1', relation: 'admin', object: 'server:preview_t1' },
  { user: 'user:preview_t2', relation: 'admin', object: 'server:preview_t2' },
  { user: 'user:preview_t3', relation: 'admin', object: 'server:preview_t3' },
];
await page.locator('#io-import-textarea').fill(
  validTuples.map(t => JSON.stringify(t)).join('\n')
);
await page.click('#btn-run-preview');
await page.waitForTimeout(800);
const preview1 = await page.evaluate(() => ({
  willImportText: document.getElementById('io-results')?.textContent || '',
  confirmBtn: document.getElementById('btn-preview-confirm') !== null,
  discardBtn: document.getElementById('btn-preview-discard') !== null,
}));
pass &= report('Preview valide : "3 tuples ajoutés" affiché',
  /3\s*tuples?\s+ajout/i.test(preview1.willImportText),
  `text="${preview1.willImportText.slice(0, 100)}"`);
pass &= report('Preview valide : bouton "Confirmer l\'import" affiché',
  preview1.confirmBtn);
pass &= report('Preview valide : bouton "Annuler" affiché',
  preview1.discardBtn);

// ── 3. Preview avec doublons + invalides ─────────────────────────────
const mixedText = [
  JSON.stringify({ user: 'user:dup_a', relation: 'admin', object: 'server:dup' }),
  JSON.stringify({ user: 'user:dup_a', relation: 'admin', object: 'server:dup' }), // dup intra-batch
  JSON.stringify({ user: 'user:dup_a', relation: 'admin', object: 'server:dup' }), // dup intra-batch (encore)
  'this is not JSON at all',
  '{"user":"user:","relation":"","object":""}', // tuple incomplet
].join('\n');
await page.locator('#io-import-textarea').fill(mixedText);
await page.click('#btn-run-preview');
await page.waitForTimeout(800);
const preview2 = await page.evaluate(() => ({
  text: document.getElementById('io-results')?.textContent || '',
}));
pass &= report('Preview mixte : "1 tuple ajouté" affiché',
  /1\s*tuple\s+ajouté/i.test(preview2.text),
  `text="${preview2.text.slice(0, 200)}"`);
pass &= report('Preview mixte : "2 doublons" affiché',
  /2\s*doublons?/i.test(preview2.text),
  `text="${preview2.text.slice(0, 200)}"`);
pass &= report('Preview mixte : "2 erreurs" affiché',
  /2\s*erreurs?/i.test(preview2.text),
  `text="${preview2.text.slice(0, 200)}"`);
pass &= report('Preview mixte : ligne 4 listée dans les échecs',
  /Ligne 4/i.test(preview2.text));
pass &= report('Preview mixte : ligne 5 listée dans les échecs',
  /Ligne 5/i.test(preview2.text));

// ── 4. Bouton Annuler : le store n'est pas touché ─────────────────────
// On était sur le preview mixte (1 + 2 + 2). Avant d'annuler, on
// récupère le nombre actuel de tuples dans le store.
const beforeCancel = await page.evaluate(async () =>
  (await (await fetch('/api/tuples')).json()).tuples.length
);
await page.click('#btn-preview-discard');
await page.waitForTimeout(300);
const afterCancel = await page.evaluate(async () =>
  (await (await fetch('/api/tuples')).json()).tuples.length
);
pass &= report('Annuler : nombre de tuples inchangé',
  beforeCancel === afterCancel,
  `before=${beforeCancel} after=${afterCancel}`);
const emptyPanel = await page.evaluate(() =>
  document.getElementById('io-results')?.textContent || ''
);
pass &= report('Annuler : panneau affiche l\'état vide',
  /Preview annulé/i.test(emptyPanel) || /lance un import/i.test(emptyPanel),
  `text="${emptyPanel.slice(0, 100)}"`);

// ── 5. Preview → Confirmer : le store est mis à jour ──────────────────
// On remet le JSONL des 3 tuples valides et on confirme.
await page.locator('#io-import-textarea').fill(
  validTuples.map(t => JSON.stringify(t)).join('\n')
);
await page.click('#btn-run-preview');
await page.waitForTimeout(800);
await page.click('#btn-preview-confirm');
await page.waitForTimeout(1500);

// Vérifie que les 3 tuples sont bien dans le store.
const afterImport = await page.evaluate(async (tuples) => {
  const r = await (await fetch('/api/tuples')).json();
  return tuples.every(t =>
    r.tuples.some(x =>
      x.user === t.user && x.relation === t.relation && x.object === t.object
    )
  );
}, validTuples);
pass &= report('Confirmer : les 3 tuples sont dans le store', afterImport);

// Garde-fou double-clic : si on re-clique immédiatement sur Confirmer,
// il ne devrait pas y avoir de double-import (le bouton est disabled
// pendant l'import). On ne peut pas re-tester ici car le preview est
// déjà effacé, mais on peut vérifier qu'au moins 1 fois le bouton est
// passé par l'état disabled pendant l'import via le DOM (cf. test 6).

// ── 6. Garde-fou double-clic : on simule un double-clic rapide ───────
await page.locator('#io-import-textarea').fill(JSON.stringify({
  user: 'user:dblclick_test', relation: 'admin', object: 'server:dblclick_test',
}));
// Lance le preview, puis clique 2x très vite sur Confirmer.
await page.click('#btn-run-preview');
await page.waitForTimeout(500);
const beforeDbl = await page.evaluate(async () =>
  (await (await fetch('/api/tuples')).json()).tuples.length
);
const dblClickPromise = page.evaluate(async () => {
  const btn = document.getElementById('btn-preview-confirm');
  if (!btn) return false;
  btn.click();
  btn.click();
  btn.click();
  return true;
});
await page.waitForTimeout(1500);
await dblClickPromise;
const afterDbl = await page.evaluate(async () =>
  (await (await fetch('/api/tuples')).json()).tuples.length
);
// Attendu : 1 tuple ajouté (avant +1). Si pas de garde-fou, +3 tuples.
pass &= report('Garde-fou double-clic : exactement +1 tuple (pas 3)',
  afterDbl === beforeDbl + 1,
  `before=${beforeDbl} after=${afterDbl}`);

// Cleanup des tuples de test.
for (const t of validTuples) await deleteTuple(t);
await deleteTuple({ user: 'user:dblclick_test', relation: 'admin', object: 'server:dblclick_test' });

// ── 7. Bouton Importer direct (sans preview) reste fonctionnel ────────
await page.locator('#io-import-textarea').fill(JSON.stringify({
  user: 'user:direct_import', relation: 'admin', object: 'server:direct_import',
}));
await page.click('#btn-run-import');
await page.waitForTimeout(800);
const directOk = await page.evaluate(async () => {
  const r = await (await fetch('/api/tuples')).json();
  return r.tuples.some(t =>
    t.user === 'user:direct_import' && t.object === 'server:direct_import'
  );
});
pass &= report('Bouton Importer direct (sans preview) : fonctionnel', directOk);
await deleteTuple({ user: 'user:direct_import', relation: 'admin', object: 'server:direct_import' });

// ── 8. Pas d'erreur JS pendant tout le scénario ──────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== IMPORT PREVIEW: PASS ===' : '\n=== IMPORT PREVIEW: FAIL ===');
process.exit(pass ? 0 : 1);