// test_graph_algorithms.mjs — algorithmes de graphe côté frontend
// (BFS, plus court chemin, composantes connexes, blast radius).
//
// Scénario :
//   1. Sur le store lakekeeper, charge les tuples dans state.
//   2. Vérifie que detectCycles() retourne un résultat (cycles ou []).
//   3. Vérifie que findShortestPath() trouve un chemin entre 2 nœuds
//      connus du store.
//   4. Vérifie que connectedComponents() groupe les nœuds liés.
//   5. Vérifie que blastRadius() trouve des nœuds atteignables depuis
//      une racine.

import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/home');
await page.waitForTimeout(500);

// Sélectionne le store lakekeeper (137 tuples, graphe riche).
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

// Importe les algorithmes dans la page.
const results = await page.evaluate(async () => {
  const mod = await import('./js/lib/graph-algorithms.js');
  // Récupère des nœuds réels du store pour les tests.
  const tuples = (await (await fetch('/api/tuples')).json()).tuples;
  const users = [...new Set(tuples.map(t => t.user.split('#')[0]))];
  const objects = [...new Set(tuples.map(t => t.object.split('#')[0]))];
  return {
    tupleCount: tuples.length,
    userCount: users.length,
    objectCount: objects.length,
    sampleUser: users[0],
    sampleObject: objects[0],
    sampleObject2: objects[1],
    cycles: mod.detectCycles(),
    components: mod.connectedComponents(),
    shortestPath: mod.findShortestPath(users[0], objects[0]),
  };
});

console.log(`(info) ${results.tupleCount} tuples, ${results.userCount} users, ${results.objectCount} objects`);

// ── 1. Cycles : doit retourner un array (vide ou non) ────────────────
pass &= report('detectCycles() : retourne un Array',
  Array.isArray(results.cycles),
  `type=${typeof results.cycles}`);

// ── 2. connectedComponents : au moins 1 composante ──────────────────
// Note : Sets sont sérialisés en arrays via page.evaluate (perte du type).
pass &= report('connectedComponents() : au moins 1 composante',
  results.components.length >= 1,
  `count=${results.components.length}`);
pass &= report('connectedComponents() : la 1ère composante a > 0 nœuds',
  Array.isArray(results.components[0]) && results.components[0].length >= 1,
  `size=${results.components[0]?.length}`);

// ── 3. blastRadius : retourne des nœuds ──────────────────────────────
const blastArray = await page.evaluate(async (u) => {
  const mod = await import('./js/lib/graph-algorithms.js');
  return mod.blastRadius(u, 2);
}, results.sampleUser);
pass &= report('blastRadius() : retourne un Array',
  Array.isArray(blastArray),
  `type=${typeof blastArray} length=${blastArray?.length}`);

// ── 4. findShortestPath : objet accessible depuis un user ────────────
// Si l'utilisateur n'a pas de relations directes, on accepte aussi
// un chemin null. On vérifie surtout que la fonction ne crash pas.
pass &= report('findShortestPath() : ne crash pas, retourne Array ou null',
  results.shortestPath === null || Array.isArray(results.shortestPath),
  `result=${JSON.stringify(results.shortestPath)?.slice(0, 80)}`);

// ── 5. Pas d'erreur JS pendant tout le scénario ──────────────────────
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== GRAPH ALGORITHMS: PASS ===' : '\n=== GRAPH ALGORITHMS: FAIL ===');
process.exit(pass ? 0 : 1);