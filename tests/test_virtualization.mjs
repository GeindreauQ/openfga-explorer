// test_virtualization.mjs — virtualisation des listes de tuples
// (au-delà de VIRTUALIZE_THRESHOLD cards, on rend uniquement la fenêtre
// visible).
//
// Scénario :
//   1. Injecte 500 tuples dans le store via fetch (au-delà du seuil
//      VIRTUALIZE_THRESHOLD = 200, le mode virtualisé doit s'activer).
//   2. Vérifie que le grid a la classe `.virtualized`.
//   3. Vérifie que le DOM contient < 200 nodes (au lieu de 500).
//   4. Scroll → la fenêtre de nodes visibles change.
//   5. Cleanup : supprime les 500 tuples.

import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne le store lakekeeper (qui a 11 types, donc on peut générer
// 500 tuples valides en répétant des users/relations/objects existants).
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

// Lit les relations valides depuis le modèle pour générer des tuples
// qui passent la validation côté OpenFGA.
const validTypes = await page.evaluate(async () => {
  const r = await (await fetch('/api/dsl')).json();
  const out = [];
  for (const t of (r.type_definitions || [])) {
    const rels = t.relations || {};
    const meta = t.metadata?.relations || {};
    for (const [rname, m] of Object.entries(meta)) {
      const directTypes = m.directly_related_user_types || [];
      if (directTypes.some(d => d.type === 'user' && !d.relation && !d.wildcard)) {
        out.push({ objectType: t.type, relation: rname });
      }
    }
  }
  return out;
});

if (validTypes.length === 0) {
  console.log('✗ Pas de types valides trouvés pour générer des tuples de test');
  process.exit(1);
}

// Génère 500 tuples uniques (user unique par tuple pour ne pas créer
// de duplicates). Object id varie pour avoir ~500 cards distinctes.
const tuples = [];
for (let i = 0; i < 500; i++) {
  const t = validTypes[i % validTypes.length];
  tuples.push({
    user: `user:virt_${i}`,
    relation: t.relation,
    object: `${t.objectType}:virt_${i}`,
  });
}

console.log(`(info) Injection de ${tuples.length} tuples de test…`);

// Écrit par lots de 100 pour éviter une seule requête trop grosse.
let written = 0;
for (let i = 0; i < tuples.length; i += 100) {
  const batch = tuples.slice(i, i + 100);
  const ok = await page.evaluate(async (batch) => {
    const r = await fetch('/api/tuples', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tuples: batch }),
    });
    return r.ok;
  }, batch);
  if (ok) written += batch.length;
}
console.log(`(info) ${written}/${tuples.length} tuples écrits`);

// ── 1. Refresh UI + aller sur manage_tuple ───────────────────────────
await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForTimeout(1500);

// ── 2. Mode virtualisé activé ? ──────────────────────────────────────
const state1 = await page.evaluate(() => ({
  virtualizedClass: document.getElementById('grid')?.classList.contains('virtualized'),
  cardCount: document.querySelectorAll('.node-card').length,
  vrowCount: document.querySelectorAll('.vrow').length,
}));
pass &= report('500 tuples → grid.virtualized actif', state1.virtualizedClass === true);
pass &= report('500 tuples → < 100 nodes DOM (virtualisé)',
  state1.cardCount < 100,
  `cardCount=${state1.cardCount} vrows=${state1.vrowCount}`);

// ── 3. Le scroll déclenche un re-render de la fenêtre ───────────────
// Scroll à mi-liste : on s'attend à ce que les premières cards ne
// soient plus dans le DOM (et les nouvelles le soient).
const initialCards = await page.evaluate(() =>
  [...document.querySelectorAll('.node-card .node-id')].slice(0, 5).map(e => e.textContent)
);
await page.evaluate(() => (document.getElementById('content') || window).scrollTo({ top: 3000, behavior: 'instant' }));
await page.waitForTimeout(500);
const afterScrollCards = await page.evaluate(() =>
  [...document.querySelectorAll('.node-card .node-id')].slice(0, 5).map(e => e.textContent)
);
pass &= report('Scroll : la fenêtre de cards change',
  JSON.stringify(initialCards) !== JSON.stringify(afterScrollCards),
  `before=${JSON.stringify(initialCards)} after=${JSON.stringify(afterScrollCards)}`);

// ── 4. Pas d'erreur JS pendant le scroll ────────────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

// ── 5. Cleanup ───────────────────────────────────────────────────────
console.log('(info) Cleanup des tuples de test…');
for (let i = 0; i < tuples.length; i += 100) {
  const batch = tuples.slice(i, i + 100);
  await page.evaluate(async (batch) => {
    await fetch('/api/tuples', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tuples: batch }),
    });
  }, batch);
}

await browser.close();
console.log(pass ? '\n=== VIRTUALIZATION: PASS ===' : '\n=== VIRTUALIZATION: FAIL ===');
process.exit(pass ? 0 : 1);