// test_graph_focus.mjs — Focus de voisinage dans la vue graphe : le choix
// d'une racine et le curseur de profondeur se reflètent dans la légende et
// dans l'URL, et « Réinitialiser » les retire.
import { launchBrowser, newPage, openStore, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;

await openStore(page, 'example-07-lakekeeper');
await page.click('#view-graph');
await page.waitForSelector('#graph-legend .legend-item');

const focusText = () => page.locator('#graph-legend .legend-focus').textContent().catch(() => '');
const size = text => Number((text.match(/(\d+) nœud/) || [])[1] || 0);

// Une racine avec des voisins : le premier warehouse proposé.
const root = await page.$$eval('#focus-root option', opts =>
  opts.map(o => o.value).find(v => v.startsWith('warehouse:')));
pass &= report('Une racine warehouse est proposée', !!root, root);
await page.selectOption('#focus-root', root);
await page.waitForSelector('#graph-legend .legend-focus');
const d1 = await focusText();
pass &= report('Focus affiché à 1 hop', /d=1/.test(d1) && size(d1) > 1, d1.trim().replace(/\s+/g, ' '));
pass &= report('URL porte la racine', new URL(page.url()).searchParams.get('focus') === root);

// Le curseur élargit le voisinage.
await page.locator('#tree-depth').fill('3');
await page.waitForFunction(() => /d=3/.test(document.querySelector('#graph-legend .legend-focus')?.textContent || ''));
const d3 = await focusText();
pass &= report('Profondeur 3 : voisinage plus large', size(d3) > size(d1), `${size(d1)} → ${size(d3)} nœuds`);
pass &= report('Libellé du curseur à jour', (await page.textContent('#tree-depth-val')).trim() === '3');
pass &= report('URL porte la profondeur', new URL(page.url()).searchParams.get('depth') === '3');

await page.click('#btn-focus-clear');
await page.waitForFunction(() => !document.querySelector('#graph-legend .legend-focus'));
pass &= report('Réinitialiser retire le focus', (await page.inputValue('#focus-root')) === '');

const errors = issues.filter(i => !/favicon/i.test(i));
pass &= report('Aucune erreur JS', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(pass ? '\n=== GRAPH FOCUS: PASS ===' : '\n=== GRAPH FOCUS: FAIL ===');
process.exit(pass ? 0 : 1);
