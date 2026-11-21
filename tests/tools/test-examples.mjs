// tools/test-examples.mjs — Test d'interop avec le serveur OpenFGA.
//
// Pour chaque fichier `examples/multi-store/store-data/*.fga`, on :
//   1. Le parse via `@openfga/syntax-transformer` (ANTLR officiel).
//   2. Crée un store OpenFGA dédié à cet exemple.
//   3. Pousse le modèle via POST /stores/{id}/authorization-models.
//   4. Lit le modèle via l'API publique OpenFGA et vérifie qu'il
//      contient bien tous les types et conditions.
//
// Usage :
//   OPENFGA_URL=http://localhost:18080 node tools/test-examples.mjs
//
// C'est un outil de validation d'interop : il prouve que les fichiers
// .fga parsés par la lib officielle sont acceptés tels quels par le
// serveur OpenFGA, sans aucun pré-processing spécifique.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { transformer } from '@openfga/syntax-transformer';

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

const examplesDir = path.join(ROOT, 'examples/multi-store/store-data');
const files = readdirSync(examplesDir).filter(f => f.endsWith('.fga')).sort();

let allOk = true;
const results = [];

for (const file of files) {
  const text = readFileSync(path.join(examplesDir, file), 'utf8');
  const name = file.replace(/\.fga$/, '');

  console.log(`\n━━━ ${file} ━━━`);

  // 1. Parse via la lib officielle.
  const { listener, errorListener } = transformer.parseDSL(text);
  if (errorListener.errors && errorListener.errors.length) {
    console.log(`  ✗ parse: ${errorListener.errors.length} erreur(s)`);
    for (const e of errorListener.errors.slice(0, 3)) console.log(`    ${e.message}`);
    allOk = false;
    results.push({ file, ok: false, step: 'parse' });
    continue;
  }
  const parsed = listener.authorizationModel;
  console.log(`  ✓ parse (${parsed.type_definitions?.length || 0} types, ${Object.keys(parsed.conditions || {}).length} conditions)`);

  // 2. Create store.
  const storeName = `ex-${name}-${Date.now()}`.slice(0, 50);
  let storeId;
  try {
    const r = await fetch(`${OPENFGA}/stores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: storeName }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    storeId = data.id;
    console.log(`  ✓ store créé: ${storeName} (${storeId})`);
  } catch (e) {
    console.log(`  ✗ create store: ${e.message}`);
    allOk = false;
    results.push({ file, ok: false, step: 'create-store' });
    continue;
  }

  // 3. Push model via /authorization-models (format OpenFGA officiel).
  let modelId;
  try {
    const r = await fetch(`${OPENFGA}/stores/${storeId}/authorization-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    modelId = data.authorization_model_id;
    console.log(`  ✓ modèle push: ${modelId}`);
  } catch (e) {
    console.log(`  ✗ push model: ${e.message}`);
    allOk = false;
    results.push({ file, ok: false, step: 'push-model' });
    continue;
  }

  // 4. Read-back via l'API publique OpenFGA.
  try {
    const r = await fetch(`${OPENFGA}/stores/${storeId}/authorization-models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const models = data.authorization_models || [];
    if (models.length === 0) throw new Error('aucun modèle');
    const m = models.find(x => x.id === modelId) || models[0];
    const tdefs = m.type_definitions || [];
    const conds = m.conditions || {};
    console.log(`  ✓ read-back: ${tdefs.length} types, ${Object.keys(conds).length} conditions`);

    const typeNames = new Set(tdefs.map(t => t.type));
    for (const t of parsed.type_definitions || []) {
      if (!typeNames.has(t.type)) {
        throw new Error(`type "${t.type}" manquant dans le modèle pushé`);
      }
    }
    for (const cname of Object.keys(parsed.conditions || {})) {
      if (!conds[cname]) {
        throw new Error(`condition "${cname}" manquante dans le modèle pushé`);
      }
    }
    results.push({ file, ok: true, storeId, modelId });
  } catch (e) {
    console.log(`  ✗ read-back: ${e.message}`);
    allOk = false;
    results.push({ file, ok: false, step: 'read-back' });
  }
}

console.log(`\n${'━'.repeat(60)}`);
console.log(allOk ? '=== TOUS LES EXEMPLES SONT ACCEPTÉS PAR OPENFGA ===' : '=== CERTAINS EXEMPLES ONT ÉCHOUÉ ===');
for (const r of results) {
  const status = r.ok ? '✓' : '✗';
  console.log(`  ${status} ${r.file}${r.ok ? ` → ${r.modelId?.slice(-8) || ''}` : ` (${r.step})`}`);
}
process.exit(allOk ? 0 : 1);