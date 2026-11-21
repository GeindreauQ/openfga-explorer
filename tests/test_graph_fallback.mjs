// test_graph_fallback.mjs — Quand le moteur de graphe (Cytoscape) ne se
// charge pas, la vue graphe l'annonce au lieu de tourner indéfiniment, et
// propose de réessayer ou de revenir aux cartes.
import { launchBrowser, newPage, openStore, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page } = await newPage(browser);
let pass = true;

await openStore(page, 'example-07-lakekeeper');
await page.route('**/vendor/cytoscape.esm.mjs*', route => route.abort());

await page.click('#view-graph');
await page.waitForSelector('#cy-error:not([hidden])', { timeout: 10000 }).catch(() => {});
pass &= report('Erreur affichée', await page.locator('#cy-error').isVisible());
pass &= report('Pas de spinner restant', await page.locator('#cy-loader').isHidden());

// Le réseau revient : « Réessayer » dessine le graphe.
await page.unroute('**/vendor/cytoscape.esm.mjs*');
await page.click('#cy-error-retry');
const drawn = await page.waitForSelector('#graph-wrap canvas', { state: 'attached', timeout: 10000 }).then(() => true).catch(() => false);
pass &= report('« Réessayer » dessine le graphe', drawn && await page.locator('#cy-error').isHidden());

// Nouvel échec (page rechargée, moteur indisponible) : retour aux cartes.
await page.route('**/vendor/cytoscape.esm.mjs*', route => route.abort());
await page.reload();
await page.waitForSelector('#cy-error:not([hidden])', { timeout: 10000 }).catch(() => {});
await page.click('#cy-error-cards');
await page.waitForSelector('#grid .node-card');
pass &= report('« Afficher en cartes » revient aux cartes', await page.locator('#grid').isVisible() && await page.locator('#cy-error').isHidden());

await browser.close();
console.log(pass ? '\n=== GRAPH FALLBACK: PASS ===' : '\n=== GRAPH FALLBACK: FAIL ===');
process.exit(pass ? 0 : 1);
