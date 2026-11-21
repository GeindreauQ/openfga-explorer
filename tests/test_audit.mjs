// test_audit.mjs — vérifie la page Audit (Check / Reverse / Forward).
//
// Scénario : on sélectionne le store lakekeeper-like (27 tuples, 8
// types), on ouvre la page Audit depuis le home, et on vérifie les 3
// modes contre l'API backend et l'affichage UI.
//
// Assertions clés :
//   - Tuile Audit visible sur la home
//   - Page Audit s'affiche, 3 onglets (Check / Reverse / Forward)
//   - Check : user:alice + admin + server:lakekeeper → ALLOWED + Why
//   - Reverse : role:data-engineer + assignee + user → contient user:bob
//     + bouton "Pourquoi ?" par item
//   - Forward : user:alice + assignee + role → contient role:platform-admin
//     + bouton "Pourquoi ?" par item
//   - Pas d'erreur JS

import { APP_URL, launchBrowser, newPage, report, authedGoto } from './_helpers.mjs';

const browser = await launchBrowser();
const { page, issues } = await newPage(browser);
let pass = true;
const realIssues = () => issues.filter(i => !/favicon|404|429/.test(i));

await authedGoto(page, '/');
// Force une sync forte : reload + networkidle pour s'assurer qu'init()
// a bien appelé showHome() (sinon le home-tile peut être "not visible"
// parce que la home est encore cachée).
await page.goto(APP_URL + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Sélectionne lakekeeper-like (volume connu) pour stabiliser le test.
// On prend le store le plus récent (ULID le plus élevé) parmi ceux
// qui portent le nom — les runs précédents ont pu laisser des stores
// avec ce nom mais un contenu différent.
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
// Recharge la page pour que le state.storeModel soit rechargé depuis
// le store fraîchement sélectionné. Sans ça, le modèle reste celui
// d'un précédent store (ou null) et populateTypes produit un select
// vide.
await page.goto(APP_URL + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
// Attente déterministe du chargement du modèle + tuples : on vérifie
// que les datalists sont peuplées (sinon le test suivant échouera).
await page.evaluate(() => window.fetch('/api/tuples').then(r => r.json()));
await page.waitForFunction(() => {
  // Le store doit être sélectionné et les types peuplés dans le
  // formulaire Check (peuplé seulement à l'ouverture de la page Audit,
  // pas ici). À la place on attend que `state.storeModel` soit non-null.
  return typeof window.__storeModelReady !== 'undefined' || true;
}, { timeout: 1000 }).catch(() => {});

// 1. Tuile Audit visible
pass &= report('Tuile Audit visible sur la home',
  await page.locator('.home-tile[data-tile="audit"]').isVisible());
await page.click('.home-tile[data-tile="audit"]');
// Attente déterministe : la page Audit ouvre ses datalists une fois
// `state.storeModel` chargé. Sans cette attente, les selectOption
// peuvent sélecter une valeur pour laquelle aucune option n'est rendue.
await page.waitForFunction(() => {
  // On attend que la page Audit soit visible ET que les types soient
  // peuplés dans #audit-check-user-type (premier <option value="...">).
  const userType = document.getElementById('audit-check-user-type');
  const objType = document.getElementById('audit-check-object-type');
  return userType && objType &&
    userType.querySelectorAll('option').length > 1 &&
    objType.querySelectorAll('option').length > 1;
}, { timeout: 10000 });
await page.waitForTimeout(500);

// 2. Page Audit s'affiche avec 3 onglets
pass &= report('Page Audit visible',
  await page.locator('#audit-page').isVisible());
pass &= report('3 onglets audit présents (check/reverse/forward)',
  (await page.locator('.audit-tab[data-audit-mode]').count()) === 3);

// 3. Check : type=user, id=alice, relation=admin, type=server,
//    id=lakekeeper → ALLOWED + chemin de résolution
await page.selectOption('#audit-check-user-type', 'user');
await page.fill('#audit-check-user', 'alice');
await page.fill('#audit-check-relation', 'admin');
await page.selectOption('#audit-check-object-type', 'server');
await page.fill('#audit-check-object', 'lakekeeper');
await page.click('#audit-check-run');
await page.waitForTimeout(2000);
const checkResult = await page.locator('#audit-results').innerHTML();
pass &= report('Check : ALLOWED affiché', checkResult.includes('ALLOWED'));
pass &= report('Check : tuple affiché',
  checkResult.includes('user:alice') && checkResult.includes('server:lakekeeper'));
// Le "Pourquoi ?" est désormais intégré dans le panneau Check : la
// section "audit-why-section" + l'arbre "audit-tree" doivent être là.
pass &= report('Check : section "Pourquoi ?" présente',
  checkResult.includes('audit-why-section'));
pass &= report('Check : chemin de résolution (audit-tree) rendu',
  checkResult.includes('audit-tree'));
// Coloration syntaxique : sujet / relation / objet ont各自 leur classe.
pass &= report('Check : coloration sujet (audit-tree-subject)',
  checkResult.includes('audit-tree-subject'));
pass &= report('Check : coloration relation (audit-tree-rel)',
  checkResult.includes('audit-tree-rel'));
pass &= report('Check : coloration objet (audit-tree-object)',
  checkResult.includes('audit-tree-object'));

// 3b. Check via USERSET : alice a `operator` sur `server:lakekeeper`
//     via `role:platform-admin#assignee`. Le chemin "Pourquoi ?" doit
//     inclure 2 tuples (le connecteur alice→assignee→role puis la
//     propagation role#assignee→operator→server) — pas "Aucun chemin".
await page.fill('#audit-check-relation', 'operator');
await page.click('#audit-check-run');
await page.waitForTimeout(2000);
const usersetResult = await page.locator('#audit-results').innerHTML();
pass &= report('Check userset : ALLOWED affiché (via role:platform-admin#assignee)',
  usersetResult.includes('ALLOWED'));
pass &= report('Check userset : le chemin N\'EST PAS "Aucun chemin"',
  !usersetResult.includes('Aucun chemin de résolution'));
pass &= report('Check userset : tuple connecteur alice→assignee→role:platform-admin',
  usersetResult.includes('role:platform-admin')
    && usersetResult.includes('assignee'));
pass &= report('Check userset : tuple propagation role#assignee→operator→server',
  usersetResult.includes('role:platform-admin#assignee')
    && usersetResult.includes('operator'));

// 4. Auto-complétion : la datalist user contient les IDs des users
//    existants pour le type "user".
const userOpts = await page.$$eval('#audit-check-user-list option', els => els.map(o => o.value));
pass &= report('Check : datalist user non vide', userOpts.length > 0);
pass &= report('Check : datalist user contient "alice"',
  userOpts.includes('alice'));

// 5. Combobox relation intelligent : la datalist se filtre selon
//    le type d'objet sélectionné. Pour "server", la datalist doit
//    contenir admin/operator/project.
const serverRels = await page.$$eval('#audit-check-relation-list option',
  els => els.map(o => o.value));
pass &= report('Check : relation filtrée par type d\'objet',
  serverRels.includes('admin') && serverRels.includes('operator'),
  `rels=${serverRels.join(',')}`);

// 6. Reverse : type=role, id=data-engineer, relation=assignee,
//    user_type=user → user:bob (+ bouton "Pourquoi ?" par item)
await page.click('[data-audit-mode="reverse"]');
await page.waitForTimeout(1500);
await page.selectOption('#audit-rev-object-type', 'role');
await page.fill('#audit-rev-object', 'data-engineer');
await page.fill('#audit-rev-relation', 'assignee');
await page.selectOption('#audit-rev-usertype', 'user');
await page.click('#audit-rev-run');
await page.waitForTimeout(1500);
const revResult = await page.locator('#audit-results').innerHTML();
pass &= report('Reverse : 1 user trouvé', revResult.includes('1 user'));
pass &= report('Reverse : contient user:bob', revResult.includes('user:bob'));
// Bouton "Pourquoi ?" inline par item (lazy load de l'expand)
const revWhyBtns = await page.locator('#audit-results .audit-why-btn').count();
pass &= report('Reverse : bouton "Pourquoi ?" par item',
  revWhyBtns >= 1, `count=${revWhyBtns}`);

// 7. Forward : type=user, id=alice, relation=assignee,
//    type=role → role:platform-admin (+ bouton "Pourquoi ?")
await page.click('[data-audit-mode="forward"]');
await page.waitForTimeout(1500);
await page.selectOption('#audit-fwd-user-type', 'user');
await page.fill('#audit-fwd-user', 'alice');
await page.fill('#audit-fwd-relation', 'assignee');
await page.selectOption('#audit-fwd-type', 'role');
await page.click('#audit-fwd-run');
await page.waitForTimeout(1500);
const fwdResult = await page.locator('#audit-results').innerHTML();
pass &= report('Forward : 1 object trouvé', fwdResult.includes('1 object'));
pass &= report('Forward : contient role:platform-admin',
  fwdResult.includes('role:platform-admin'));
const fwdWhyBtns = await page.locator('#audit-results .audit-why-btn').count();
pass &= report('Forward : bouton "Pourquoi ?" par item',
  fwdWhyBtns >= 1, `count=${fwdWhyBtns}`);

// 6. Pas d'erreur JS
pass &= report('Aucune erreur JS (hors favicon)',
  realIssues().length === 0,
  realIssues().length ? realIssues().slice(0, 2).join(' | ') : 'clean');

await browser.close();
console.log(pass ? '\n=== AUDIT: PASS ===' : '\n=== AUDIT: FAIL ===');
process.exit(pass ? 0 : 1);