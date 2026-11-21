// test_import_export.mjs — vérifie les endpoints /api/export/tuples et
// /api/import/tuples + la page dédiée #io-page (cf. tuile
// "Import / Export" du tableau de bord).
//
// Scénario :
//   1. Export : on vérifie que le format est application/jsonl, avec
//      un tuple par ligne.
//   2. Import (round-trip) : on supprime quelques tuples via DELETE,
//      on les ré-importe, et on vérifie qu'elles sont revenues.
//   3. UI : la tuile "Import / Export" du home ouvre la page dédiée,
//      les 2 onglets fonctionnent, les résultats s'affichent dans le
//      panneau de droite.

import { APP_URL, launchBrowser, newPage, report, authedGoto } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/');

// Sélectionne lakekeeper-like (le plus récent) pour stabiliser.
await page.evaluate(async () => {
  const stores = await (await fetch('/api/stores')).json();
  const candidates = (stores.stores || [])
    .filter(s => s.name === 'example-06-lakekeeper-like')
    .sort((a, b) => b.id.localeCompare(a.id));
  const lk = candidates[0];
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

// 1. API Export : format JSONL
const exportResp = await page.evaluate(async () => {
  const r = await fetch('/api/export/tuples', { credentials: 'include' });
  return {
    status: r.status,
    ct: r.headers.get('content-type'),
    cd: r.headers.get('content-disposition'),
    body: await r.text(),
  };
});
pass &= report('GET /api/export/tuples → 200', exportResp.status === 200);
pass &= report('Export : Content-Type = application/jsonl',
  (exportResp.ct || '').includes('application/jsonl'));
pass &= report('Export : Content-Disposition = attachment',
  (exportResp.cd || '').includes('attachment'));
const exportLines = exportResp.body.split('\n').filter(l => l.trim());
pass &= report('Export : ≥ 27 tuples',
  exportLines.length >= 27, `count=${exportLines.length}`);
// Vérifie qu'une ligne est bien du JSON valide
let allValid = true;
for (const line of exportLines) {
  try { JSON.parse(line); } catch { allValid = false; break; }
}
pass &= report('Export : chaque ligne est du JSON valide', allValid);

// 2. Tuile "Import / Export" + page dédiée
pass &= report('Tuile "Import / Export" présente sur la home',
  await page.locator('.home-tile[data-tile="import_export"]').count() === 1);

// Clic sur la tuile → ouverture de la page dédiée
await page.click('.home-tile[data-tile="import_export"]');
await page.waitForTimeout(800);
pass &= report('Page I/O visible après clic', await page.locator('#io-page').isVisible());
pass &= report('Page I/O est la seule page plein écran visible',
  await page.locator('#io-page').isVisible() &&
  await page.locator('#home-dashboard').isHidden());

// Onglets
const ioTabs = await page.locator('[data-io-mode]').count();
pass &= report('3 onglets I/O présents (export, import, model)', ioTabs === 3);

// L'onglet Export doit montrer le bouton de download
const exportBtn = await page.locator('#btn-download-tuples').count();
pass &= report('Bouton "Télécharger" présent (onglet Export)', exportBtn === 1);

// Click import tab → textarea visible
await page.click('[data-io-mode="import"]');
await page.waitForTimeout(400);
const importTextarea = await page.locator('#io-import-textarea').count();
pass &= report('Textarea d\'import présent (onglet Import)', importTextarea === 1);

// Click model tab → bouton .fga + textarea présents
await page.click('[data-io-mode="model"]');
await page.waitForTimeout(400);
const modelDownload = await page.locator('#btn-download-model').count();
const modelTextarea = await page.locator('#io-model-textarea').count();
const modelApply = await page.locator('#btn-apply-model').count();
pass &= report('Modèle : bouton "Télécharger .fga" présent', modelDownload === 1);
pass &= report('Modèle : textarea DSL présent', modelTextarea === 1);
pass &= report('Modèle : bouton "Appliquer" présent', modelApply === 1);

// Le panneau Export ne doit pas scroller : tous les éléments doivent
// être visibles sans scroll de la pane.
const exportActions = page.locator('.audit-pane-form .audit-actions');
const exportVisible = await exportActions.first().isVisible();
pass &= report('Export : actions visibles sans scroll', exportVisible);

// Retour à la home pour la suite (round-trip API)
await page.click('#btn-home');
await page.waitForTimeout(500);
pass &= report('Bouton Accueil I/O : retour au tableau de bord',
  await page.locator('#home-dashboard').isVisible());

// 3. Round-trip : on calcule un tuple valide dynamiquement depuis le
// authorization model actif, puis on l'utilise pour tout le cycle
// (DELETE → import → check présence). C'est crucial car le tuple doit
// satisfaire les `directly_related_user_types` de la relation ciblée.
const roundTripTuple = await page.evaluate(async () => {
  // Récupère le modèle actif.
  const dslResp = await fetch('/api/dsl');
  if (!dslResp.ok) return null;
  const dsl = await dslResp.json();
  const types = dsl.type_definitions || [];
  // Cherche un tuple qui sera valide pour la première relation acceptant
  // un user direct : on parcourt les types et relations, on s'arrête sur
  // le premier couple (type, relation) qui accepte `[user]` ou `[user, ...]`.
  for (const t of types) {
    const rels = t.relations || {};
    for (const [relName, relDef] of Object.entries(rels)) {
      // OpenFGA: relDef peut être { this: {} } (= [user]) ou { union: {...} }
      const acceptsUser = (() => {
        const t = relDef?.this;
        if (t && typeof t === 'object' && Object.keys(t).length === 0) return true;
        // Other shapes: skip (computed userset, tuple-to-userset, etc.)
        return false;
      })();
      if (acceptsUser) {
        return {
          user: `user:ie_roundtrip_${relName}_${t.type}`,
          relation: relName,
          object: `${t.type}:ie_roundtrip_${relName}_${t.type}`,
        };
      }
    }
  }
  return null;
});
if (!roundTripTuple) {
  pass &= report('Compute valid round-trip tuple from model', false, 'aucune relation acceptant user direct');
  await browser.close();
  console.log('\n=== IMPORT/EXPORT: FAIL ===');
  process.exit(1);
}
// D'abord on vérifie qu'il n'existe pas (sinon le test est biaisé)
const existsBefore = await page.evaluate(async (t) => {
  const r = await (await fetch('/api/tuples')).json();
  return r.tuples.some(x => x.user === t.user && x.relation === t.relation && x.object === t.object);
}, roundTripTuple);
if (!existsBefore) {
  // Insert via import
  const insertRes = await page.evaluate(async (t) => {
    const r = await fetch('/api/import/tuples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonl' },
      body: JSON.stringify(t),
    });
    return { status: r.status, body: await r.json() };
  }, roundTripTuple);
  pass &= report('Import : insert 1 tuple → 200', insertRes.status === 200);
  pass &= report('Import : imported = 1', insertRes.body.imported === 1,
    `body=${JSON.stringify(insertRes.body).slice(0, 200)}`);
  // Vérifie qu'il est là
  const existsAfter = await page.evaluate(async (t) => {
    const r = await (await fetch('/api/tuples')).json();
    return r.tuples.some(x => x.user === t.user && x.relation === t.relation && x.object === t.object);
  }, roundTripTuple);
  pass &= report('Round-trip : tuple présent après import', existsAfter);
  // Delete via l'API existante
  await page.evaluate(async (t) => {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tuples: [t] }),
    });
  }, roundTripTuple);
  // Import multi-lignes (3 lignes : 1 valide + 1 valide + 1 malformée).
  // On utilise le type de l'objet du tuple dynamique pour la 2e ligne.
  const objType = roundTripTuple.object.split(':')[0];
  const multiRes = await page.evaluate(async ({ t, objType }) => {
    const body = [
      JSON.stringify(t),
      JSON.stringify({...t, object: `${objType}:ie_roundtrip2`}),
      'malformed line that is not JSON',
    ].join('\n');
    const r = await fetch('/api/import/tuples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonl' },
      body,
    });
    return { status: r.status, body: await r.json() };
  }, { t: roundTripTuple, objType });
  pass &= report('Import multi-lignes : 2 OK + 1 échec',
    multiRes.body.imported === 2 && multiRes.body.failed.length === 1,
    `body=${JSON.stringify(multiRes.body).slice(0, 300)}`);
  // Cleanup
  const objType2 = roundTripTuple.object.split(':')[0];
  await page.evaluate(async ({ t, objType }) => {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/jsonl' },
      credentials: 'include',
      body: JSON.stringify({ tuples: [
        t,
        {...t, object: `${objType}:ie_roundtrip2`},
      ] }),
    });
  }, { t: roundTripTuple, objType: objType2 });
} else {
  // Cas où le tuple existe déjà : on l'utilise pour le round-trip
  // direct (DELETE puis import).
  await page.evaluate(async (t) => {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/jsonl' },
      credentials: 'include',
      body: JSON.stringify({ tuples: [t] }),
    });
  }, roundTripTuple);
  const reRes = await page.evaluate(async (t) => {
    const r = await fetch('/api/import/tuples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonl' },
      body: JSON.stringify(t),
    });
    return { status: r.status, body: await r.json() };
  }, roundTripTuple);
  pass &= report('Round-trip : import ré-insère', reRes.body.imported === 1);
  // Cleanup
  await page.evaluate(async (t) => {
    await fetch('/api/tuples', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/jsonl' },
      credentials: 'include',
      body: JSON.stringify({ tuples: [t] }),
    });
  }, roundTripTuple);
}

// 4. Pas d'erreur JS
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== IMPORT/EXPORT: PASS ===' : '\n=== IMPORT/EXPORT: FAIL ===');
process.exit(pass ? 0 : 1);