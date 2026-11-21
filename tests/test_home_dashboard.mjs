// test_home_dashboard.mjs — vérifie le tableau de bord /home et la
// navigation entre tuiles (admin_dsl, audit, manage_tuple, import_export, assertions).
// Les vues (graph, tree, model, connection) sont accessibles via la
// toolbar (`#view-graph`, `#btn-open-model`, `#btn-toggle-config`) une
// fois la tuile manage_tuple sélectionnée — la grille de tuiles elle-même
// n'expose plus ces modes.
import { APP_URL, launchBrowser, newPage, openStore, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i =>
  !/favicon|404|429|Cannot read properties of null.*fit/i.test(i));

// 1. Au login, l'utilisateur arrive directement sur le tableau de bord.
await openStore(page, 'example-07-lakekeeper', 'home');
await page.waitForTimeout(500);
const homeVisible = await page.locator('#home-dashboard').isVisible();
pass &= report('Tableau de bord visible après login', homeVisible);

// 2. Les raccourcis de l'accueil couvrent au moins les 5 pages
// historiques (la page Accès en ajoute) — l'ordre n'est pas figé.
const tileCount = await page.locator('.home-tile').count();
pass &= report('≥ 5 raccourcis présents', tileCount >= 5, `count=${tileCount}`);

// 3. Les 5 tuiles attendues sont présentes (sans ordre strict).
const tiles = await page.$$eval('.home-tile', els => els.map(e => ({
  tile: e.getAttribute('data-tile'),
  title: e.querySelector('.home-tile-title')?.textContent,
  disabled: e.hasAttribute('disabled'),
})));
const expectedTiles = ['admin_dsl', 'audit', 'manage_tuple', 'import_export', 'assertions'];
const actualTileSet = new Set(tiles.map(t => t.tile));
const missingTiles = expectedTiles.filter(t => !actualTileSet.has(t));
pass &= report('Tuiles attendues présentes',
  missingTiles.length === 0,
  missingTiles.length ? `manque=${missingTiles.join(',')}` : 'all present');

// 4. Cliquer sur "manage_tuple" ouvre la vue cartes
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForTimeout(500);
const homeHiddenAfter = await page.locator('#home-dashboard').isHidden();
const cardsVisible = await page.locator('#grid').isVisible();
const cardsActive = await page.locator('#view-cards').evaluate(btn => btn.classList.contains('active'));
pass &= report('Tuile manage_tuple : home caché', homeHiddenAfter);
pass &= report('Tuile manage_tuple : grille de cartes visible', cardsVisible);
pass &= report('Tuile manage_tuple : bouton Cartes actif', cardsActive);

// 5. Au moins 10 cartes rendues (manage_tuple montre les tuples)
const cardCount = await page.locator('.node-card').count();
pass &= report('Tuile manage_tuple : ≥ 10 cartes', cardCount >= 10,
  `count=${cardCount}`);

// 6. Le bouton "Accueil" permet de revenir au tableau de bord
await page.click('#btn-home');
await page.waitForTimeout(500);
const homeBack = await page.locator('#home-dashboard').isVisible();
pass &= report('Bouton Accueil : retour au tableau de bord', homeBack);

// 7. Toolbar : la bascule vers la vue graphe est accessible via #view-graph
// (l'ancienne tuile "graph_svg" a été déclassée en bouton de toolbar).
// La vue graphe est désormais rendue via Cytoscape (cf. src/web/index.html
// :484 et src/web/js/views/graph.js:64-86 : `#cy-mount` est inséré dans
// `#graph-wrap`). L'ancien rendu SVG natif n'existe plus.
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForTimeout(800);
// Attend que les tuples soient chargés avant de basculer vers le graphe.
await page.waitForFunction(() => document.querySelectorAll('.node-card').length >= 5,
  { timeout: 10000 }).catch(() => {});
await page.click('#view-graph');
// Attend que le mount Cytoscape soit créé (ou que le graphe soit actif).
await page.waitForFunction(() => {
  const btn = document.getElementById('view-graph');
  return btn && btn.classList.contains('active') && (
    document.querySelector('#graph-wrap #cy-mount') ||
    document.querySelector('#cy-loader:not([hidden])')
  );
}, { timeout: 10000 });
await page.waitForTimeout(500);
const graphActive = await page.locator('#view-graph').evaluate(btn => btn.classList.contains('active'));
const cytoMounted = await page.locator('#graph-wrap #cy-mount').count();
pass &= report('Toolbar view-graph : bouton Graphe actif', graphActive);
pass &= report('Toolbar view-graph : mount Cytoscape créé', cytoMounted >= 1,
  `cy_count=${cytoMounted}`);

// 8. Retour à la home
await page.click('#btn-home');
await page.waitForTimeout(300);
pass &= report('Retour à home après view-graph', await page.locator('#home-dashboard').isVisible());

// 9. Modale d'aperçu du modèle d'autorisation (l'ancienne tuile "model"
// a été déclassée en bouton #btn-open-model dans le header).
await page.click('#btn-open-model');
await page.waitForTimeout(500);
const modelVisible = await page.locator('#model-backdrop').isVisible();
pass &= report('Toolbar btn-open-model : modale ouverte', modelVisible);
await page.click('#btn-close-model');
await page.waitForTimeout(300);

// 10. Panneau de configuration (l'ancienne tuile "connection" a été
// déclassée en bouton #btn-toggle-config dans le header).
await page.click('#btn-toggle-config');
await page.waitForTimeout(500);
const configOpen = await page.locator('#config-panel').evaluate(panel =>
  panel.classList.contains('open'));
pass &= report('Toolbar btn-toggle-config : panneau ouvert', configOpen);
await page.click('#btn-toggle-config'); // ferme
await page.waitForTimeout(300);

// 11. Tuile "audit" → page audit
await page.click('.home-tile[data-tile="audit"]');
await page.waitForTimeout(800);
const auditVisible = await page.locator('#audit-page').isVisible();
pass &= report('Tuile audit : page ouverte', auditVisible);
await page.click('#btn-home');
await page.waitForTimeout(500);

// 12. Tuile "import_export" → page I/O
await page.click('.home-tile[data-tile="import_export"]');
await page.waitForTimeout(800);
const ioVisible = await page.locator('#io-page').isVisible();
pass &= report('Tuile import_export : page ouverte', ioVisible);
await page.click('#btn-home');
await page.waitForTimeout(500);

// 13. Tuile "assertions" → page assertions
await page.click('.home-tile[data-tile="assertions"]');
await page.waitForTimeout(800);
const assertionsVisible = await page.locator('#assertions-page').isVisible();
pass &= report('Tuile assertions : page ouverte', assertionsVisible);
await page.click('#btn-home');
await page.waitForTimeout(500);

// 14. Tuile "admin_dsl" → page DSL (referme le tour modal s'il apparaît)
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(1500);
const tourVisible = await page.locator('#dsl-tour').isVisible().catch(() => false);
if (tourVisible) {
  await page.click('#dsl-tour-close').catch(() => {});
  await page.waitForTimeout(300);
}
const dslVisible = await page.locator('#dsl-page').isVisible();
pass &= report('Tuile admin_dsl : page ouverte', dslVisible);
await page.click('#btn-home');
await page.waitForTimeout(500);

// 15. Tuile "tree" : la navigation vers l'arbre est déclenchée via
// le focus voisinage (la tuile d'origine a été déclassée). On vérifie
// que l'arbre est bien désactivé tant qu'aucun focus n'est actif.
const treeDisabledInitial = await page.evaluate(() => {
  // Si la tuile tree existe encore, elle est désactivée.
  const treeTile = document.querySelector('.home-tile[data-tile="tree"]');
  return treeTile ? treeTile.hasAttribute('disabled') : true;
});
pass &= report('Tuile "tree" désactivée sans focus (ou absente)',
  treeDisabledInitial, `disabled=${treeDisabledInitial}`);

pass &= report('Aucune erreur JS (hors favicon/fit)', realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== HOME DASHBOARD: PASS ===' : '\n=== HOME DASHBOARD: FAIL ===');
process.exit(pass ? 0 : 1);