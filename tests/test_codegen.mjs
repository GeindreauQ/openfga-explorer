// test_codegen.mjs — modale "Generate SDK" : génère du code client
// TypeScript, Go, Python, curl à partir du modèle actif.
//
// Scénario :
//   1. Sur le store lakekeeper, ouvre la page Admin DSL.
//   2. Clique "Generate SDK" → modal s'ouvre avec 4 onglets.
//   3. Onglet TypeScript : relations du store, surcouche Authz, méta et nom de fichier.
//   4. Onglet Go : code contient "package client" + structs.
//   5. Onglet Python : code contient "@dataclass" + classes.
//   6. Onglet curl : code contient "curl" + endpoint.
//   7. Bouton Copy : copie dans le presse-papier.
//   8. Pas d'erreur JS.

import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, ctx, issues } = await newPage(browser);
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

// Va sur la page Admin DSL.
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(500);
// Dismiss tour
const tour = await page.locator('#dsl-tour').isVisible().catch(() => false);
if (tour) {
  await page.click('#dsl-tour-close');
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1500);

// ── 1. Bouton "Generate SDK" présent ─────────────────────────────────
pass &= report('Bouton "Generate SDK" présent sur la page DSL',
  await page.locator('#btn-generate-sdk').count() === 1);

// Debug : vérifie que state.storeModel est chargé
const modelState = await page.evaluate(async () => {
  const mod = await import('./js/lib/state.js');
  return {
    hasModel: !!mod.state.storeModel,
    typeCount: mod.state.storeModel?.type_definitions?.length || 0,
    sampleTypes: mod.state.storeModel?.type_definitions?.slice(0, 3).map(t => t.type) || [],
  };
});
console.log('(debug) state.storeModel:', JSON.stringify(modelState));

// ── 2. Click → modal s'ouvre ─────────────────────────────────────────
await page.click('#btn-generate-sdk');
await page.waitForTimeout(500);
const modalVisible = await page.evaluate(() =>
  document.getElementById('codegen-backdrop')?.classList.contains('open')
);
pass &= report('Modal Generate SDK ouvert', modalVisible);

// ── 3. 4 onglets présents ────────────────────────────────────────────
const tabs = await page.locator('.codegen-tab').count();
pass &= report('4 onglets langages (TS, Go, Python, curl)',
  tabs === 4, `count=${tabs}`);

// ── 4. Onglet TypeScript actif par défaut ────────────────────────────
const fullTsCode = await page.evaluate(() => document.getElementById('codegen-code').textContent);
pass &= report('TypeScript : importe "@openfga/sdk"',
  fullTsCode.includes("from '@openfga/sdk'"),
  `snippet="${fullTsCode.slice(0, 80)}"`);
pass &= report('TypeScript : relations du modèle par type (Relations)',
  /export const Relations = \{/.test(fullTsCode) && /^ {2}[\w"-]+: \[/m.test(fullTsCode));
pass &= report('TypeScript : relation typée par type d\'objet (RelationOf<T>)',
  fullTsCode.includes('relation: RelationOf<T>, object: ObjectRef<T>'));
pass &= report('TypeScript : surcouche Authz (check, grant, listObjects, listUsers)',
  ['async check<', 'async grant<', 'async listObjects<', 'async listUsers<'].every(m => fullTsCode.includes(m)));
pass &= report('TypeScript : store courant par défaut',
  /storeId: process\.env\.FGA_STORE_ID \?\? "\w+"/.test(fullTsCode));
const meta = await page.locator('#codegen-meta').textContent();
pass &= report('Méta : store et modèle affichés', /Store .+ modèle/.test(meta), `meta="${meta.slice(0, 80)}"`);
const filename = await page.locator('#codegen-filename').textContent();
pass &= report('Téléchargement : authz.ts', filename.trim() === 'authz.ts', `filename=${filename}`);

// ── 5. Onglet Go ─────────────────────────────────────────────────────
await page.click('.codegen-tab[data-lang="go"]');
await page.waitForTimeout(300);
const goCode = await page.locator('#codegen-code').textContent();
const goActive = await page.evaluate(() =>
  document.querySelector('.codegen-tab.active')?.getAttribute('data-lang')
);
pass &= report('Go : onglet "go" actif après clic',
  goActive === 'go', `active=${goActive}`);
pass &= report('Go : package authz + go-sdk',
  goCode.includes('package authz') && goCode.includes('"github.com/openfga/go-sdk/client"'));
pass &= report('Go : constantes de types',
  /\tType\w+ += "[^"]+"/.test(goCode));
pass &= report('Go : Check via le SDK fluide',
  goCode.includes('a.FGA.Check(ctx).Body(client.ClientCheckRequest{'));
pass &= report('Téléchargement : authz.go',
  (await page.locator('#codegen-filename').textContent()).trim() === 'authz.go');

// ── 6. Onglet Python ────────────────────────────────────────────────
await page.click('.codegen-tab[data-lang="python"]');
await page.waitForTimeout(300);
const pyCode = await page.locator('#codegen-code').textContent();
pass &= report('Python : OpenFgaClient + requêtes typées',
  pyCode.includes('OpenFgaClient') && pyCode.includes('ClientCheckRequest(user=user'));
pass &= report('Python : classe ObjectType et surcouche Authz',
  pyCode.includes('class ObjectType:') && pyCode.includes('class Authz:'));

// ── 7. Onglet curl ──────────────────────────────────────────────────
await page.click('.codegen-tab[data-lang="curl"]');
await page.waitForTimeout(300);
const curlCode = await page.locator('#codegen-code').textContent();
pass &= report('curl : script bash exécutable',
  curlCode.startsWith('#!/usr/bin/env bash') && curlCode.includes('set -euo pipefail'));
pass &= report('curl : sous-commandes check / grant / list-objects',
  ['  check)', '  grant)', '  list-objects)'].every(c => curlCode.includes(c)));
pass &= report('curl : FGA_STORE_ID et FGA_API_URL',
  curlCode.includes('FGA_STORE_ID=') && curlCode.includes('FGA_API_URL='));

// ── 8. Bouton Copy ──────────────────────────────────────────────────
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });
await page.click('.codegen-tab[data-lang="typescript"]');
await page.waitForTimeout(300);
await page.click('#btn-codegen-copy');
await page.waitForTimeout(500);
const clipboard = await page.evaluate(() => navigator.clipboard.readText());
pass &= report('Copy : clipboard contient du code TS',
  clipboard.includes("from '@openfga/sdk'"),
  `clipboard="${clipboard.slice(0, 100)}"`);

// ── 9. Pas d'erreur JS ──────────────────────────────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== CODEGEN: PASS ===' : '\n=== CODEGEN: FAIL ===');
process.exit(pass ? 0 : 1);