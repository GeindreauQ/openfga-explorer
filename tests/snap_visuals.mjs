// tests/snap_visuals.mjs — Capture des screenshots des vues Admin DSL et Cyto.
// À lancer APRÈS avoir rechargé la page : ce script navigue et capture.
// Utilisation : node tests/snap_visuals.mjs
import { APP_URL, launchBrowser, newPage, waitForTuples, authedGoto } from './_helpers.mjs';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/openfga-snaps';
mkdirSync(OUT, { recursive: true });

const browser = await launchBrowser();
const { page } = await newPage(browser);
const issues = [];

const log = (...a) => console.log('[snap]', ...a);

log('Auth + nav home');
await authedGoto(page, '/home');
await waitForTuples(page, 10);

// ── Capture 1 : tuile Admin DSL (dashboard home) ──
await page.screenshot({ path: `${OUT}/01-home-dashboard.png`, fullPage: false });
log('01-home-dashboard.png');

// ── Capture 2 : page Admin DSL (panneau droit graphe visible) ──
log('Navigate Admin DSL');
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForSelector('#dsl-page:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(1500); // stabilisation rendu graphe
// Ferme le tour si visible
const tourVisible = await page.locator('#dsl-tour').isVisible().catch(() => false);
if (tourVisible) {
  await page.click('#dsl-tour-close');
  await page.waitForTimeout(500);
}
await page.screenshot({ path: `${OUT}/02-admin-dsl-default.png`, fullPage: false });
log('02-admin-dsl-default.png');

// ── Capture 3 : panneau droit zoomé (juste le .dsl-pane-graph) ──
const graphPane = page.locator('#dsl-pane-graph');
const graphBox = await graphPane.boundingBox();
if (graphBox) {
  await page.screenshot({
    path: `${OUT}/03-dsl-graph-pane.png`,
    clip: { x: graphBox.x, y: graphBox.y, width: graphBox.width, height: graphBox.height },
  });
  log('03-dsl-graph-pane.png');
}

// ── Capture 4 : hover sur une arête (le label apparaît) ──
const edges = await page.locator('.dsl-edge-hit').all();
log(`Arêtes détectées : ${edges.length}`);
if (edges.length > 0) {
  // Centre le graphe d'abord
  const fitBtn = page.locator('#dsl-graph-fit');
  if (await fitBtn.count()) await fitBtn.click();
  await page.waitForTimeout(800);
  // Force le hover via dispatchEvent (les paths courbes ont une bbox
  // qui peut ne pas intersecter le path au centre).
  await edges[0].dispatchEvent('mouseenter');
  await edges[0].dispatchEvent('mousemove');
  await page.waitForTimeout(400);
  if (graphBox) {
    await page.screenshot({
      path: `${OUT}/04-dsl-edge-hover.png`,
      clip: { x: graphBox.x, y: graphBox.y, width: graphBox.width, height: graphBox.height },
    });
    log('04-dsl-edge-hover.png');
  }
  // Click via dispatchEvent pour épingler (le bounding box d'une courbe
  // ne contient pas forcément le path au centre).
  await edges[0].dispatchEvent('click');
  await page.waitForTimeout(500);
  if (graphBox) {
    await page.screenshot({
      path: `${OUT}/05-dsl-edge-pinned.png`,
      clip: { x: graphBox.x, y: graphBox.y, width: graphBox.width, height: graphBox.height },
    });
    log('05-dsl-edge-pinned.png');
  }
  // Ferme le panel d'arête pour la suite.
  await page.click('#dsl-edge-panel-close', { force: true }).catch(() => {});
  await page.waitForTimeout(300);
}

// ── Capture 6 : clic sur un nœud (panneau d'info nœud) ──
try {
  const nodes = await page.locator('.dsl-node').all();
  log(`Nœuds détectés : ${nodes.length}`);
  if (nodes.length > 0) {
    // Ferme d'abord le panel d'arête s'il est visible
    const edgePanel = page.locator('#dsl-edge-panel');
    const isPanelVisible = await edgePanel.isVisible().catch(() => false);
    if (isPanelVisible) {
      await page.locator('#dsl-edge-panel-close').click({ force: true });
      await page.waitForTimeout(300);
    }
    // dispatchEvent pour être robuste (le bounding box d'un cercle est OK
    // mais on évite les aléas de hit-test).
    await nodes[0].dispatchEvent('click');
    await page.waitForTimeout(500);
    if (graphBox) {
      await page.screenshot({
        path: `${OUT}/06-dsl-node-clicked.png`,
        clip: { x: graphBox.x, y: graphBox.y, width: graphBox.width, height: graphBox.height },
      });
      log('06-dsl-node-clicked.png');
    }
  }
} catch (e) {
  log('Skip node click:', e.message);
}

// ── Capture 7 : vue Cyto ──
log('Switch to Cyto view');
// Retour au home d'abord (on est sur Admin DSL)
await page.click('#btn-home');
await page.waitForSelector('.home-tile[data-tile="manage_tuple"]', { timeout: 5000 });
await page.waitForTimeout(500);
// Navigue vers la tuile manage_tuple (où se trouve le bouton Cyto)
await page.click('.home-tile[data-tile="manage_tuple"]');
await page.waitForSelector('#view-graph-cy', { timeout: 5000 });
await page.waitForTimeout(800);
// Click forcé pour bypass les overlays potentiels (graph-focus etc.)
await page.locator('button[data-view="graph-cy"]').click({ force: true });
// Attente que l'instance Cytoscape soit prête
try {
  await page.waitForFunction(() => !!window.__cyReady?.(), null, { timeout: 30000 });
} catch (e) {
  log('Cytoscape timeout — peut être hors ligne');
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/07-cyto-view.png`, fullPage: false });
log('07-cyto-view.png');

// ── Capture 8 : zoom + fit boutons dans le header Cyto ──
// Test des boutons : zoom-in, fit
const cyZoomIn = page.locator('#cy-zoom-in');
if (await cyZoomIn.count()) {
  await cyZoomIn.click();
  await page.waitForTimeout(400);
  await cyZoomIn.click();
  await page.waitForTimeout(400);
}
const cyFit = page.locator('#cy-fit');
if (await cyFit.count()) {
  await cyFit.click();
  await page.waitForTimeout(800);
}
await page.screenshot({ path: `${OUT}/08-cyto-after-zoom-fit.png`, fullPage: false });
log('08-cyto-after-zoom-fit.png');

// ── Capture 9 : focus sur un nœud dans Cyto ──
// (La sélection de focus passe par le main.js ; on simule via __cyInfo / window event)
const focusResult = await page.evaluate(() => {
  if (window.__cyInfo && window.__cyInfo()) {
    const info = window.__cyInfo();
    return { ok: true, info };
  }
  return { ok: false };
});
log('Cyto info:', JSON.stringify(focusResult));
await page.screenshot({ path: `${OUT}/09-cyto-with-info.png`, fullPage: false });

await browser.close();
console.log('\n=== Screenshots written to', OUT, '===');
console.log('Issues:', issues);
process.exit(0);
