#!/usr/bin/env node

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
const REPO_ROOT = findRepoRoot(__dirname);
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples', 'multi-store', 'store-data');

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => {
    const i = a.indexOf('=');
    return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
  }));
const OPENFGA = args['openfga-url'] || process.env.OPENFGA_URL || 'http://localhost:8080';

async function http(method, urlPath, body) {
  const r = await fetch(`${OPENFGA}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${method} ${urlPath}: ${text.slice(0, 200)}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function waitForOpenFGA() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${OPENFGA}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`OpenFGA at ${OPENFGA} not ready after 30s`);
}

async function countTuples(storeId) {
  try {
    const r = await http('POST', `/stores/${storeId}/read`, { page_size: 200 });
    return (r.tuples || r.objects || []).length;
  } catch {
    return 0;
  }
}

function parseDSLOrThrow(text) {
  const { listener, errorListener } = transformer.parseDSL(text);
  if (errorListener.errors && errorListener.errors.length) {
    throw new Error(errorListener.errors.map(e => e.message).join('; '));
  }
  return listener.authorizationModel;
}

async function seedOne(file) {
  const baseName = file.replace(/\.fga$/, '');
  const storeName = `example-${baseName}`;
  const fgaPath = path.join(EXAMPLES_DIR, file);
  console.log(`\n━━━ ${file} ━━━`);

  const dslText = readFileSync(fgaPath, 'utf8');
  let parsed;
  try {
    parsed = parseDSLOrThrow(dslText);
  } catch (e) {
    console.log(`  ✗ parse: ${e.message}`);
    return { file, ok: false, error: e.message };
  }

  const created = await http('POST', '/stores', { name: storeName });
  const storeId = created.id;
  console.log(`  ✓ store "${storeName}" → ${storeId}`);

  const body = transformer.transformDSLToJSONObject(dslText);
  try {
    const out = await http('POST', `/stores/${storeId}/authorization-models`, body);
    const typeCount = (body.type_definitions || []).length;
    const condCount = body.conditions ? Object.keys(body.conditions).length : 0;
    console.log(`  ✓ modèle: ${typeCount} types / ${condCount} conditions → ${out.authorization_model_id?.slice(-8) || '?'}`);
  } catch (e) {
    if (e.status === 400 && /entrypoints|no entrypoints/.test(JSON.stringify(e.body))) {
      console.log(`  ⚠ modèle rejeté (entrypoint manquant), on continue`);
      return { file, ok: true, storeId, tupleCount: 0 };
    }
    console.log(`  ✗ push model: ${e.message}`);
    return { file, ok: false, error: e.message };
  }

  const tuplesPath = path.join(EXAMPLES_DIR, `${baseName}.tuples.json`);
  let tupleCount = 0;
  if (existsSync(tuplesPath)) {
    const tuplesFile = JSON.parse(readFileSync(tuplesPath, 'utf8'));
    const wanted = tuplesFile.tuple_keys || [];
    if (wanted.length > 0) {
      const current = await countTuples(storeId);
      if (current >= wanted.length) {
        console.log(`  ✓ tuples déjà présents (${current}/${wanted.length}) — skip`);
        tupleCount = current;
      } else {
        const models = await http('GET', `/stores/${storeId}/authorization-models`);
        const lastModelId = models.authorization_models?.[0]?.id;
        if (!lastModelId) throw new Error('aucun model_id pour écrire les tuples');
        // OpenFGA limite à 100 writes par requête : on batche par
        // chunks de 80 pour rester confortablement sous la limite.
        const CHUNK = 80;
        let written = 0;
        for (let i = 0; i < wanted.length; i += CHUNK) {
          const slice = wanted.slice(i, i + CHUNK);
          await http('POST', `/stores/${storeId}/write`, {
            authorization_model_id: lastModelId,
            writes: { tuple_keys: slice },
          });
          written += slice.length;
        }
        tupleCount = written;
        console.log(`  ✓ tuples écrits: ${tupleCount} (${Math.ceil(wanted.length / CHUNK)} requêtes)`);
      }
    }
  }

  return { file, ok: true, storeId, tupleCount };
}

async function main() {
  console.log(`[seed-examples] OpenFGA: ${OPENFGA}`);
  console.log(`[seed-examples] Examples dir: ${EXAMPLES_DIR}`);
  await waitForOpenFGA();
  console.log(`[seed-examples] OpenFGA ready`);

  let files = readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.fga')).sort();
  // --only=08 : ne charge que les exemples dont le nom commence ainsi.
  if (args.only) files = files.filter(f => f.startsWith(args.only));
  if (files.length === 0) {
    console.log('[seed-examples] Aucun .fga dans examples/ — rien à faire');
    return;
  }

  const results = [];
  for (const f of files) {
    results.push(await seedOne(f));
  }

  const ok = results.filter(r => r.ok).length;
  const ko = results.filter(r => !r.ok).length;
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`[seed-examples] ${ok} OK / ${ko} KO sur ${results.length} exemples`);
  console.log(`[seed-examples] Stores créés : ${results.filter(r => r.ok).map(r => `"example-${r.file.replace('.fga', '')}"`).join(', ')}`);
  console.log(`[seed-examples] Sélecteur dans l'UI : ${OPENFGA.replace(/:\d+$/, '')}:${OPENFGA.match(/:(\d+)$/)?.[1] || '8080'}`);
  if (ko > 0) process.exit(1);
}

main().catch(e => {
  console.error('[seed-examples] FATAL:', e.message);
  process.exit(1);
});