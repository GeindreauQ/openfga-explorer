// tools/test-checks.mjs — Tests de check end-to-end sur les exemples.
//
// Stratégie : pour chaque exemple, on crée un store dédié, on pousse
// le modèle + les tuples de démo officiels (lus depuis
// `examples/multi-store/store-data/<name>.tuples.json`), puis on lance
// une batterie de checks couvrant les cas nominaux + les cas d'erreur.
//
// C'est volontairement un test d'interop, pas un test unitaire : on
// parle à un vrai OpenFGA, on dépend de son comportement réel.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'examples', 'multi-store', 'store-data'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Impossible de trouver examples/multi-store/store-data/ depuis ${start}`);
}
const ROOT = findRepoRoot(__dirname);
const OPENFGA = process.env.OPENFGA_URL || 'http://localhost:18080';

const { parseDSL, validateDSL, toOpenFGAJSON } = await import(
  path.join(ROOT, 'src/web/js/models/dsl.js')
);

async function http(method, urlPath, body) {
  const r = await fetch(`${OPENFGA}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status} ${method} ${urlPath}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function setupExample(fgaFile) {
  const baseName = fgaFile.replace(/\.fga$/, '');
  const text = readFileSync(path.join(ROOT, 'examples/multi-store/store-data', fgaFile), 'utf8');
  const parsed = parseDSL(text);
  if (parsed.errors.length) throw new Error(`parse: ${parsed.errors[0].message}`);
  if (validateDSL(parsed).length) throw new Error(`validate: ${validateDSL(parsed)[0]}`);
  const storeName = `test-${baseName}-${Date.now()}`.slice(0, 50);
  const created = await http('POST', '/stores', { name: storeName });
  const storeId = created.id;
  const model = await http('POST', `/stores/${storeId}/authorization-models`, toOpenFGAJSON(parsed));
  // Pousse les tuples de démo officiels si présents.
  const tuplesPath = path.join(ROOT, 'examples/multi-store/store-data', `${baseName}.tuples.json`);
  let tuples = [];
  if (existsSync(tuplesPath)) {
    tuples = JSON.parse(readFileSync(tuplesPath, 'utf8')).tuple_keys || [];
    if (tuples.length > 0) {
      await http('POST', `/stores/${storeId}/write`, {
        authorization_model_id: model.authorization_model_id,
        writes: { tuple_keys: tuples },
      });
    }
  }
  return { storeId, modelId: model.authorization_model_id, tuples };
}

async function check(storeId, modelId, user, relation, object, context) {
  const body = {
    authorization_model_id: modelId,
    tuple_key: { user, relation, object },
  };
  if (context) body.context = context;
  const r = await http('POST', `/stores/${storeId}/check`, body);
  return r.allowed;
}

function expect(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${label} → ${actual} (attendu: ${expected})`);
  return ok;
}

let allOk = true;

// ── 02-expired-grants ────────────────────────────────────────────────────────
console.log('\n━━━ 02-expired-grants : tests end-to-end ━━━');
try {
  const { storeId, modelId } = await setupExample('02-expired-grants.fga');
  console.log('  store + modèle + 3 tuples seedés');

  // anne a un grant de 720h à partir de 2026-06-25 → actif 30 jours.
  // On test avec current_time dans la fenêtre et hors.
  allOk &= expect(
    'anne active (current_time = 2026-06-26)',
    await check(storeId, modelId, 'user:anne', 'viewer', 'document:active-report',
      { current_time: '2026-06-26T00:00:00Z' }),
    true,
  );
  allOk &= expect(
    'anne expirée (current_time = 2026-08-01, > 720h après grant)',
    await check(storeId, modelId, 'user:anne', 'viewer', 'document:active-report',
      { current_time: '2026-08-01T00:00:00Z' }),
    false,
  );
  // bob a un grant de 1h à partir de 2026-06-25 → déjà expiré.
  allOk &= expect(
    'bob expirée (current_time = 2026-06-26, > 1h après grant)',
    await check(storeId, modelId, 'user:bob', 'viewer', 'document:active-report',
      { current_time: '2026-06-26T00:00:00Z' }),
    false,
  );
  // carol a un grant de 1h en janvier 2026 → expiré depuis longtemps.
  allOk &= expect(
    'carol expirée (current_time = 2026-06-26)',
    await check(storeId, modelId, 'user:carol', 'viewer', 'document:old-archive',
      { current_time: '2026-06-26T00:00:00Z' }),
    false,
  );
  // user sans tuple → false.
  allOk &= expect(
    'eve (aucun tuple) → false',
    await check(storeId, modelId, 'user:eve', 'viewer', 'document:active-report',
      { current_time: '2026-06-26T00:00:00Z' }),
    false,
  );
} catch (e) {
  console.log(`  ✗ FAIL: ${e.message}`);
  allOk = false;
}

// ── 03-ip-allowlist ──────────────────────────────────────────────────────────
console.log('\n━━━ 03-ip-allowlist : tests end-to-end ━━━');
try {
  const { storeId, modelId } = await setupExample('03-ip-allowlist.fga');
  console.log('  store + modèle + 4 tuples seedés');

  // alice : CIDR 10.0.0.0/8
  allOk &= expect(
    'alice 10.5.0.1 (in 10.0.0.0/8)',
    await check(storeId, modelId, 'user:alice', 'viewer', 'document:internal-roadmap',
      { client_ip_address: '10.5.0.1' }),
    true,
  );
  allOk &= expect(
    'alice 192.168.0.1 (hors 10.0.0.0/8)',
    await check(storeId, modelId, 'user:alice', 'viewer', 'document:internal-roadmap',
      { client_ip_address: '192.168.0.1' }),
    false,
  );
  // bob : CIDR 192.168.1.0/24
  allOk &= expect(
    'bob 192.168.1.50 (in 192.168.1.0/24)',
    await check(storeId, modelId, 'user:bob', 'viewer', 'document:internal-roadmap',
      { client_ip_address: '192.168.1.50' }),
    true,
  );
  allOk &= expect(
    'bob 10.0.0.1 (hors 192.168.1.0/24)',
    await check(storeId, modelId, 'user:bob', 'viewer', 'document:internal-roadmap',
      { client_ip_address: '10.0.0.1' }),
    false,
  );
  // charlie est member de network:vpn, et le viewer via userset a CIDR 0.0.0.0/0.
  allOk &= expect(
    'charlie via network:vpn (any IP, CIDR 0.0.0.0/0)',
    await check(storeId, modelId, 'user:charlie', 'viewer', 'document:internal-roadmap',
      { client_ip_address: '203.0.113.5' }),
    true,
  );
} catch (e) {
  console.log(`  ✗ FAIL: ${e.message}`);
  allOk = false;
}

// ── 04-gdrive ────────────────────────────────────────────────────────────────
console.log('\n━━━ 04-gdrive : tests end-to-end ━━━');
try {
  const { storeId, modelId } = await setupExample('04-gdrive.fga');
  console.log('  store + modèle + 11 tuples seedés');

  // can_view = viewer AND member from organization
  // alice : viewer de readme + member de acme → can_view = true
  allOk &= expect(
    'alice can_view readme (viewer + member acme)',
    await check(storeId, modelId, 'user:alice', 'can_view', 'document:readme'),
    true,
  );
  // bob : viewer de readme + member de acme → can_view = true
  allOk &= expect(
    'bob can_view readme (viewer + member acme)',
    await check(storeId, modelId, 'user:bob', 'can_view', 'document:readme'),
    true,
  );
  // eve : reader de readme mais PAS member de acme → can_view = false
  allOk &= expect(
    'eve can_view readme (reader only, pas member)',
    await check(storeId, modelId, 'user:eve', 'can_view', 'document:readme'),
    false,
  );
  // frank : member de globex mais pas viewer de readme → can_view = false
  allOk &= expect(
    'frank can_view readme (member globex, pas viewer)',
    await check(storeId, modelId, 'user:frank', 'can_view', 'document:readme'),
    false,
  );
  // alice can_view design-doc : viewer=NO → can_view = false
  allOk &= expect(
    'alice can_view design-doc (pas de tuple viewer)',
    await check(storeId, modelId, 'user:alice', 'can_view', 'document:design-doc'),
    false,
  );
  // carol can_view readme : viewer=NO + member acme → false (carol n'a pas de tuple viewer)
  allOk &= expect(
    'carol can_view readme (member acme mais pas viewer)',
    await check(storeId, modelId, 'user:carol', 'can_view', 'document:readme'),
    false,
  );
  // alice can_write readme : writer + member acme → true
  allOk &= expect(
    'alice can_write readme',
    await check(storeId, modelId, 'user:alice', 'can_write', 'document:readme'),
    true,
  );
} catch (e) {
  console.log(`  ✗ FAIL: ${e.message}`);
  allOk = false;
}

// ── 01-github-like ───────────────────────────────────────────────────────────
console.log('\n━━━ 01-github-like : tests end-to-end ━━━');
try {
  const { storeId, modelId } = await setupExample('01-github-like.fga');
  console.log('  store + modèle + 9 tuples seedés');

  // admin = direct OR repo_admin from owner
  // alice : direct admin → true
  allOk &= expect(
    'alice admin backend (direct)',
    await check(storeId, modelId, 'user:alice', 'admin', 'repo:backend'),
    true,
  );
  // bob : writer → admin? non (writer/maintainer/admin cascading, admin requires admin)
  allOk &= expect(
    'bob admin backend (writer, pas admin)',
    await check(storeId, modelId, 'user:bob', 'admin', 'repo:backend'),
    false,
  );
  // frank : member de team:platform ; team:platform#member writer → writer direct
  allOk &= expect(
    'frank writer backend (via team:platform#member writer)',
    await check(storeId, modelId, 'user:frank', 'writer', 'repo:backend'),
    true,
  );
  // GitHub model : maintainer n'est PAS un cascading de writer
  // (seul admin cascading vers maintainer). Donc frank n'est pas maintainer.
  allOk &= expect(
    'frank maintainer backend (writer seul, pas maintainer)',
    await check(storeId, modelId, 'user:frank', 'maintainer', 'repo:backend'),
    false,
  );
  // frank admin : NON car le `this` de admin exige un tuple admin direct
  // (pas de cascade transitive sur admin).
  allOk &= expect(
    'frank admin backend (writer seul, pas admin)',
    await check(storeId, modelId, 'user:frank', 'admin', 'repo:backend'),
    false,
  );
  // eve : repo_admin de organization:acme ; organization:acme owner de repo:backend → admin via from
  allOk &= expect(
    'eve admin backend (via repo_admin from owner)',
    await check(storeId, modelId, 'user:eve', 'admin', 'repo:backend'),
    true,
  );
  // reader test
  allOk &= expect(
    'carol reader backend (direct)',
    await check(storeId, modelId, 'user:carol', 'reader', 'repo:backend'),
    true,
  );
  // eve reader via from (carol est reader direct, mais on teste eve via cascading)
  allOk &= expect(
    'eve reader backend (admin → writer → maintainer → triager → reader via cascading)',
    await check(storeId, modelId, 'user:eve', 'reader', 'repo:backend'),
    true,
  );
} catch (e) {
  console.log(`  ✗ FAIL: ${e.message}`);
  allOk = false;
}

// ── 05-entitlements ──────────────────────────────────────────────────────────
console.log('\n━━━ 05-entitlements : tests end-to-end ━━━');
try {
  const { storeId, modelId } = await setupExample('05-entitlements.fga');
  console.log('  store + modèle + 13 tuples seedés');

  // alice (member acme, plan free) : can-invite-collaborator sous condition
  // collaborator_limit = 10, count = 5 → true
  allOk &= expect(
    'alice can-invite-collaborator (5 ≤ 10)',
    await check(storeId, modelId, 'user:alice', 'has_feature', 'feature:can-invite-collaborator',
      { collaborator_count: 5 }),
    true,
  );
  // alice : 15 > 10 → false
  allOk &= expect(
    'alice can-invite-collaborator (15 > 10)',
    await check(storeId, modelId, 'user:alice', 'has_feature', 'feature:can-invite-collaborator',
      { collaborator_count: 15 }),
    false,
  );
  // bob (member globex, plan pro) : collaborator_limit = 100, count = 50 → true
  allOk &= expect(
    'bob can-invite-collaborator (50 ≤ 100)',
    await check(storeId, modelId, 'user:bob', 'has_feature', 'feature:can-invite-collaborator',
      { collaborator_count: 50 }),
    true,
  );
  // alice : basic-page-analytics (sans condition, gratuit pour tous)
  allOk &= expect(
    'alice basic-page-analytics (no condition)',
    await check(storeId, modelId, 'user:alice', 'has_feature', 'feature:basic-page-analytics'),
    true,
  );
  // alice : priority-support (réservé au plan pro)
  allOk &= expect(
    'alice priority-support (plan free seulement)',
    await check(storeId, modelId, 'user:alice', 'has_feature', 'feature:priority-support'),
    false,
  );
  // bob : advanced-page-analytics (sans condition, plan pro)
  allOk &= expect(
    'bob advanced-page-analytics (plan pro, no condition)',
    await check(storeId, modelId, 'user:bob', 'has_feature', 'feature:advanced-page-analytics'),
    true,
  );
} catch (e) {
  console.log(`  ✗ FAIL: ${e.message}`);
  allOk = false;
}

console.log(`\n${'━'.repeat(60)}`);
console.log(allOk ? '=== TOUS LES CHECKS END-TO-END PASSENT ===' : '=== CERTAINS CHECKS ONT ÉCHOUÉ ===');
process.exit(allOk ? 0 : 1);