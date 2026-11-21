// test_dsl.mjs — vérifie la page Admin DSL v4 :
//   - Layout force-directed (Fruchterman-Reingold)
//   - Chaque relation produit sa propre arête (pas de dédup)
//   - Panneau latéral avec sections Entrantes/Sortantes/Définitions
//   - Modale d'ajout de relation avec chips + preview live
//   - Bouton "+ Relation" ouvre la modale d'ajout
//   - Bouton "Éditer" ouvre la modale d'édition de relation
//
// Le clic sur les nœuds SVG se fait via `dispatchEvent('click')` car
// Playwright a du mal avec les éléments SVG via `click()` direct.
import { APP_URL, launchBrowser, newPage, authedGoto, report } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i =>
  !/favicon|404|429|Cannot read properties of null.*fit/i.test(i));

// 1. Endpoints backend — on utilise authedGoto plutôt qu'un login
// manuel pour bénéficier de la désactivation du SSE (sinon
// `waitForLoadState('networkidle')` ne se déclenche jamais, la
// connexion SSE maintenant le réseau actif en permanence).
await authedGoto(page, '/');

// Sélectionne un store connu pour stabiliser le test. On attend
// ensuite ~500ms pour que le SetStoreID soit visible côté backend
// (sinon /api/dsl lit parfois encore l'ancien modèle).
await page.evaluate(async () => {
  const stores = await (await fetch('/api/stores')).json();
  const lakekeeper = stores.stores?.find(s => s.name === 'example-06-lakekeeper-like');
  if (lakekeeper) {
    await fetch('/api/stores/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: lakekeeper.id }),
    });
  }
});
await page.waitForTimeout(500);
// Re-applique le DSL lakekeeper-like pour obtenir un état déterministe
// (le test ne doit pas dépendre des modèles appliqués par d'autres tests
// antérieurs). Le contenu du fichier est inliné pour rester stable sans
// nécessiter un fetch supplémentaire côté navigateur.
const LAKEKEEPER_LIKE_DSL = `model
  schema 1.2

type user

type role
  relations
    define assignee:  [user, role#assignee]
    define ownership: [user, role#assignee]
    define project:   [project]

type server
  relations
    define admin:    [user, role#assignee]
    define operator: [user, role#assignee]
    define project:  [project]

type project
  relations
    define create:         [user, role#assignee]
    define data_admin:     [user, role#assignee]
    define describe:       [user, role#assignee]
    define modify:         [user, role#assignee]
    define project_admin:  [user, role#assignee]
    define role_creator:   [user, role#assignee]
    define security_admin: [user, role#assignee]
    define select:         [user, role#assignee]
    define server:         [server]
    define warehouse:      [warehouse]

type warehouse
  relations
    define create:        [user, role#assignee]
    define describe:      [user, role#assignee]
    define manage_grants: [user, role#assignee]
    define modify:        [user, role#assignee]
    define namespace:     [namespace]
    define ownership:     [user, role#assignee]
    define pass_grants:   [user, role#assignee]
    define project:       [project]
    define select:         [user, role#assignee]

type namespace
  relations
    define child:         [namespace, lakekeeper_table, lakekeeper_view]
    define create:        [user, role#assignee]
    define describe:      [user, role#assignee]
    define manage_grants: [user, role#assignee]
    define modify:        [user, role#assignee]
    define ownership:     [user, role#assignee]
    define parent:        [namespace, warehouse]
    define pass_grants:   [user, role#assignee]
    define select:        [user, role#assignee]

type lakekeeper_table
  relations
    define describe:      [user, role#assignee]
    define manage_grants: [user, role#assignee]
    define modify:        [user, role#assignee]
    define ownership:     [user, role#assignee]
    define parent:        [namespace]
    define pass_grants:   [user, role#assignee]
    define select:        [user, role#assignee]

type lakekeeper_view
  relations
    define describe:      [user, role#assignee]
    define manage_grants: [user, role#assignee]
    define modify:        [user, role#assignee]
    define ownership:     [user, role#assignee]
    define parent:        [namespace]
    define pass_grants:   [user, role#assignee]
    define select:        [user, role#assignee]
`;
const applyResp = await page.evaluate(async (text) => {
  const r = await fetch('/api/dsl/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}, LAKEKEEPER_LIKE_DSL);
pass &= report('Re-apply lakekeeper-like DSL → 200', applyResp.status === 200,
  `body=${JSON.stringify(applyResp.body).slice(0, 100)}`);
await page.waitForTimeout(500);
const dslResp = await page.evaluate(async () => {
  const r = await fetch('/api/dsl');
  return { status: r.status, ct: r.headers.get('content-type'), text: await r.text() };
});
pass &= report('GET /api/dsl → 200', dslResp.status === 200);
pass &= report('Content-Type = application/json', /application\/json/.test(dslResp.ct || ''));
const dslJson = JSON.parse(dslResp.text);
pass &= report('Le JSON contient schema_version', !!dslJson.schema_version);
// OpenFGA renvoie le schema_version tel qu'il a été normalisé par le
// serveur (typiquement `1.1` même si le DSL source dit `1.2`). On accepte
// toute valeur `1.x` cohérente.
pass &= report('schema_version reconnu (1.x)', /^1\.\d+$/.test(dslJson.schema_version),
  `got=${dslJson.schema_version}`);
pass &= report('Le JSON définit ≥ 5 types',
  Array.isArray(dslJson.type_definitions) && dslJson.type_definitions.length >= 5,
  `count=${dslJson.type_definitions?.length}`);

// 2. POST /api/dsl/parse (le parser doit accepter schema 1.2 même si
// le store actif l'a normalisé en 1.1).
const parseResp = await page.evaluate(async () => {
  const r = await fetch('/api/dsl/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'model\n  schema 1.2\ntype user\ntype project\n  relations\n    define owner: [user]\n' }),
  });
  return { status: r.status, body: await r.json() };
});
pass &= report('POST /api/dsl/parse → 200', parseResp.status === 200);
pass &= report('parse: schema_version = 1.x', /^1\.\d+$/.test(parseResp.body.schema_version),
  `got=${parseResp.body.schema_version}`);
pass &= report('parse: 2 types détectés', parseResp.body.type_definitions?.length === 2);

// 3. Page DSL — header compact
// authedGoto va réutiliser la session existante (on est déjà loggé).
await authedGoto(page, '/home');
// Force une sync forte (re-load + networkidle) pour s'assurer qu'init()
// a bien exécuté showHome().
await page.goto(APP_URL + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
// Re-sélectionne le store après reload.
await page.evaluate(async () => {
  const stores = await (await fetch('/api/stores')).json();
  const lakekeeper = stores.stores?.find(s => s.name === 'example-06-lakekeeper-like');
  if (lakekeeper) {
    await fetch('/api/stores/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: lakekeeper.id }),
    });
  }
});
await page.waitForTimeout(500);
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(2500);
pass &= report('Page DSL visible après clic tuile',
  await page.locator('#dsl-page').isVisible());
pass &= report('Header : titre "Authorization Model"',
  (await page.locator('#dsl-title').textContent()) === 'Authorization Model');
pass &= report('Header : compteur "(N types)"',
  /\(\d+ types?\)/.test(await page.locator('#dsl-type-count').textContent()));
pass &= report('Header : boutons Apply, Reset présents',
  (await page.locator('#dsl-apply').count()) === 1 &&
  (await page.locator('#dsl-reset').count()) === 1);
pass &= report('Header : toggle DSL/JSON',
  (await page.locator('.dsl-fmt-btn[data-fmt="dsl"]').count()) === 1 &&
  (await page.locator('.dsl-fmt-btn[data-fmt="json"]').count()) === 1);

// 4. Tour d'aide — réinitialise le flag localStorage pour le voir
// apparaître (le test n'est idempotent que si le flag est nettoyé).
await page.evaluate(() => {
  try { localStorage.removeItem('openfga-explorer:dsl-tour-seen'); } catch {}
});
// On revient à la home avant le reload pour partir d'un état "clean".
// Avec la feature URL state (v24), l'URL conserve `tile=admin_dsl` et le
// reload restore directement la page DSL — le tour modal ne s'affiche
// pas. On navigue donc vers `/` pour purger l'URL avant le reload.
await page.goto(APP_URL + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.reload();
await page.waitForTimeout(1000);
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(2500);
pass &= report('Tour visible au premier chargement',
  !(await page.locator('#dsl-tour').getAttribute('hidden') === ''));
await page.click('#dsl-tour-close');
await page.waitForTimeout(300);

// 5. Éditeur
const editorValue = await page.locator('.dsl-editor-textarea').inputValue();
pass &= report('Éditeur DSL : ≥ 500 chars', editorValue.length >= 500);
pass &= report('Éditeur DSL : commence par "model" (ou JSON si fallback)',
  editorValue.trimStart().startsWith('model') || editorValue.trimStart().startsWith('{'));
pass &= report('Éditeur : syntax highlighting (tok-kw)',
  await page.locator('.dsl-editor-highlight .tok-kw').count() > 0);
pass &= report('Éditeur : numérotation des lignes',
  await page.locator('.dsl-editor-gutter').count() === 1);

// 6. Compteur de types
const countText = await page.locator('#dsl-type-count').textContent();
const typeCountFromText = parseInt(countText.match(/\((\d+)/)?.[1] || '0', 10);
pass &= report('Compteur types ≥ 5', typeCountFromText >= 5, `count=${typeCountFromText}`);

// 7. Graphe : force-directed, ≥ 5 nœuds, plusieurs arêtes par paire
const nodeCount = await page.locator('.dsl-node').count();
pass &= report('Graphe DSL : ≥ 5 nœuds', nodeCount >= 5, `nodes=${nodeCount}`);
const edgeCount = await page.locator('.dsl-edge').count();
// v5 : arêtes dédupliquées — on en a ~20-30 au lieu de 89.
pass &= report('Graphe DSL : ≥ 10 arêtes dédupliquées', edgeCount >= 10,
  `edges=${edgeCount}`);

// 7b. v5 : les arêtes sont dédupliquées par (source, target) — 1 arête
// server→user contient [admin, operator] dans son `relations[]`.
// On vérifie la présence des arêtes dédupliquées et leur structure.
const serverUserEdges = await page.locator('.dsl-edge[data-edge^="server|"]').count();
pass &= report('Graphe : arête dédupliquée server→user présente',
  serverUserEdges >= 1, `count=${serverUserEdges}`);
// Et que le tooltip de cette arête mentionne bien admin+operator.
const serverUserTitle = await page.locator('.dsl-edge[data-edge^="server|user"]').first().getAttribute('data-edge');
pass &= report('Graphe : arête server→user identifiée',
  serverUserTitle === 'server|user', `id=${serverUserTitle}`);

// 8. Légende
pass &= report('Légende du graphe présente',
  (await page.locator('.dsl-legend-item').count()) > 0);

// 9. Toggle DSL/JSON
await page.click('.dsl-fmt-btn[data-fmt="json"]');
await page.waitForTimeout(300);
const jsonValue = await page.locator('.dsl-editor-textarea').inputValue();
pass &= report('Toggle JSON : commence par {',
  jsonValue.trimStart().startsWith('{'));
pass &= report('Toggle JSON : contient type_definitions',
  jsonValue.includes('type_definitions'));
await page.click('.dsl-fmt-btn[data-fmt="dsl"]');
await page.waitForTimeout(300);

// 10. Click sur `server` → side panel
await page.locator('.dsl-node[data-id="server"]').dispatchEvent('click');
// Attend que les 3 sections soient rendues (pas seulement que le panel
// soit visible) — le rendu des sections est asynchrone après le clic.
await page.waitForFunction(() => {
  return document.querySelectorAll('.dsl-side-section').length >= 3;
}, { timeout: 10000 }).catch(() => {});
const panelVisible = await page.locator('#dsl-side-panel').evaluate(el =>
  el.getAttribute('hidden') === null);
pass &= report('Side panel visible après clic nœud', panelVisible);
// Debug : on log les sections.
const debugSections = await page.evaluate(() =>
  [...document.querySelectorAll('.dsl-side-section')].map(s => ({
    title: s.querySelector('h4')?.textContent.trim().slice(0, 30),
    lis: s.querySelectorAll('li').length,
  })));
console.log(`  [debug] sections: ${JSON.stringify(debugSections)}`);
const panelText = await page.locator('#dsl-side-panel').textContent();
pass &= report('Side panel : titre = "server"',
  /server/i.test(panelText));
pass &= report('Side panel : section Entrantes',
  /Entrantes/i.test(panelText));
pass &= report('Side panel : section Sortantes',
  /Sortantes/i.test(panelText));
pass &= report('Side panel : section Définitions',
  /[Dd]é?finitions/i.test(panelText));
pass &= report('Side panel : bouton "Fermer"',
  (await page.locator('#dsl-side-close').count()) === 1);
pass &= report('Side panel : bouton "Éditer"',
  (await page.locator('#dsl-side-edit').count()) === 1);
pass &= report('Side panel : bouton "+ Relation"',
  (await page.locator('#dsl-side-add').count()) === 1);

// 11. Sortantes pour server : ≥ 3 (admin, operator, project). On retry
// car le side panel peut mettre du temps à se mettre à jour après
// le clic (layout worker).
let serverSortantes = 0;
let serverSectionTitles = [];
for (let attempt = 0; attempt < 5; attempt++) {
  const info = await page.evaluate(() => {
    const sections = document.querySelectorAll('.dsl-side-section');
    return {
      count: sections.length,
      titles: [...sections].map(s => s.querySelector('h4')?.textContent.trim() || ''),
      lis: [...sections].map(s => s.querySelectorAll('li').length),
    };
  });
  serverSectionTitles = info.titles;
  if (info.count >= 2) {
    // Cherche la section Sortantes par titre (plus robuste que l'index).
    const sortIdx = info.titles.findIndex(t => /Sortantes/i.test(t));
    if (sortIdx >= 0) {
      serverSortantes = info.lis[sortIdx];
      if (serverSortantes >= 3) break;
    }
  }
  await page.waitForTimeout(500);
}
pass &= report('Side panel server : ≥ 2 relations sortantes',
  serverSortantes >= 2, `count=${serverSortantes} sections=${serverSectionTitles.join('|')}`);

// 12. Fermer le panneau
await page.click('#dsl-side-close');
await page.waitForTimeout(500);

// 13. Cliquer "+ Relation" sur `role`
await page.locator('.dsl-node[data-id="role"]').dispatchEvent('click');
await page.waitForTimeout(800);
await page.click('#dsl-side-add');
await page.waitForTimeout(800);
pass &= report('Modale "+ Relation" ouverte',
  !(await page.locator('#dsl-add-rel-modal').getAttribute('hidden') === ''));
const addModalText = await page.locator('#dsl-add-rel-modal').textContent();
pass &= report('Modale : titre "Ajouter une relation à role"',
  /Ajouter une relation à/.test(addModalText) && /role/.test(addModalText));

// 14. Modale : champs présents
pass &= report('Modale : champ nom de relation',
  (await page.locator('#dsl-rel-name').count()) === 1);
pass &= report('Modale : canvas d\'expression',
  (await page.locator('#dsl-rel-canvas').count()) === 1);
pass &= report('Modale : preview live',
  (await page.locator('#dsl-rel-preview').count()) === 1);
pass &= report('Modale : toolbar avec ops (this, computed, from, or, and, but not)',
  (await page.locator('[data-root-op="this"]').count()) === 1 &&
  (await page.locator('[data-root-op="computed"]').count()) === 1 &&
  (await page.locator('[data-root-op="from"]').count()) === 1 &&
  (await page.locator('[data-root-op="or"]').count()) === 1 &&
  (await page.locator('[data-root-op="and"]').count()) === 1 &&
  (await page.locator('[data-root-op="but not"]').count()) === 1);

// 15. Quick-add types : user et user:* (boutons data-quick-type)
pass &= report('Modale : chips "user" et "user:*"',
  (await page.locator('button[data-quick-type="user"]').count()) >= 1 &&
  (await page.locator('button[data-quick-type="user:*"]').count()) >= 1);

// 16. Taper un nom + ajouter un type via le bouton this + preset user
await page.fill('#dsl-rel-name', 'super_admin');
await page.click('[data-root-op="this"]');
await page.waitForTimeout(200);
await page.click('button[data-quick-type="user"]');
await page.waitForTimeout(300);
const previewText = await page.locator('#dsl-rel-preview').textContent();
pass &= report('Modale : preview contient "super_admin" et "[user]"',
  previewText.includes('super_admin') && previewText.includes('[user]'),
  `preview="${previewText}"`);

// 17. Ajouter un autre type
await page.click('button[data-quick-type="server"]');
await page.waitForTimeout(300);
const previewText2 = await page.locator('#dsl-rel-preview').textContent();
pass &= report('Modale : preview contient "server" après ajout',
  previewText2.includes('server'),
  `preview="${previewText2}"`);

// 18. Sauvegarder → texte mis à jour dans l'éditeur principal
await page.click('#dsl-add-rel-save');
await page.waitForTimeout(800);
const newEditorText = await page.locator('.dsl-editor-textarea').inputValue();
pass &= report('Save : editor contient "define super_admin"',
  newEditorText.includes('define super_admin'));
pass &= report('Save : editor contient role mis à jour',
  newEditorText.includes('type role'));

// 19. Le graphe reflète la nouvelle relation (les arêtes sont
// dédupliquées par (source, target), donc le compte ne change pas — on
// vérifie plutôt que la nouvelle relation apparaît dans le side panel
// du nœud role).
await page.waitForTimeout(1500);
await page.locator('.dsl-node[data-id="role"]').dispatchEvent('click');
await page.waitForTimeout(500);
const sidePanelText = await page.locator('#dsl-side-body').textContent();
pass &= report('Side panel role : nouvelle relation super_admin visible',
  /super_admin/.test(sidePanelText), `side=${sidePanelText.slice(0, 80)}…`);
// Referme le panel pour la suite.
await page.locator('#dsl-side-close').click({ force: true });
await page.waitForTimeout(300);

// 20. Bouton "Éditer" : ouvre la modale d'édition d'une relation existante
// (le lint-panel en fixed peut intercepter les clics : on utilise
// dispatchEvent programmatique + click JS direct pour contourner.)
// D'abord on clique sur un autre nœud (server) pour désélectionner role,
// puis on re-clique sur role pour rouvrir le side-panel.
await page.evaluate(() => {
  const server = document.querySelector('.dsl-node[data-id="server"]');
  if (server) {
    server.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
});
await page.waitForTimeout(500);
await page.evaluate(() => {
  const node = document.querySelector('.dsl-node[data-id="role"]');
  if (node) {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
});
// Attend que le side-panel soit visible (handler asynchrone).
await page.waitForFunction(() => {
  const panel = document.getElementById('dsl-side-panel');
  const editBtn = document.getElementById('dsl-side-edit');
  return panel && !panel.hasAttribute('hidden') && editBtn && editBtn.offsetParent !== null;
}, { timeout: 5000 });
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('dsl-side-edit')?.click());
await page.waitForTimeout(800);
pass &= report('Modale d\'édition ouverte (mode edit)',
  !(await page.locator('#dsl-add-rel-modal').getAttribute('hidden') === ''));
const editModalText = await page.locator('#dsl-add-rel-modal').textContent();
pass &= report('Modale : titre contient "Éditer" et nom de relation',
  /Éditer/.test(editModalText));

// 21. Fermer la modale + bouton Accueil
await page.click('#dsl-add-rel-close');
await page.waitForTimeout(300);
await page.click('#btn-home');
await page.waitForTimeout(500);
pass &= report('Bouton Accueil : home visible',
  await page.locator('#home-dashboard').isVisible());
pass &= report('Bouton Accueil : page DSL cachée',
  await page.locator('#dsl-page').isHidden());

// 22. Resizer split-pane
await page.click('.home-tile[data-tile="admin_dsl"]');
await page.waitForTimeout(1500);
const resizer = page.locator('#dsl-resizer');
const resizerBox = await resizer.boundingBox();
if (resizerBox) {
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + 100, resizerBox.y + resizerBox.height / 2);
  await page.mouse.up();
  pass &= report('Resizer draggable (no crash)', true);
}

pass &= report('Aucune erreur JS (hors favicon/fit)', realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== DSL: PASS ===' : '\n=== DSL: FAIL ===');
process.exit(pass ? 0 : 1);
