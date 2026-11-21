// run_all.mjs — lance tous les tests en série et résume les résultats.
// Exit code 0 si tous passent, 1 sinon.
//
// Contre la stack docker compose locale (APP_URL non fourni), on redémarre
// le container pour repartir d'un rate limiter vide : sans ça, les tests
// qui suivent test_rate_limit attendent la recharge des jetons. Quand
// APP_URL est fourni (tests/e2e.sh, CI), l'instance est neuve.
import { spawn, execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.APP_URL) {
  console.log('[run_all] redémarrage du container openfga-explorer (reset du rate limiter)...');
  try {
    execSync('docker compose -f ../docker-compose.yml restart explorer 2>&1', { stdio: 'inherit' });
    for (let i = 0; i < 30; i++) {
      try {
        const r = execSync('curl -fsS http://localhost:8000/api/health', { encoding: 'utf8' });
        if (r.includes('"status":"ok"')) break;
      } catch {}
      await new Promise(res => setTimeout(res, 1000));
    }
  } catch (e) {
    console.error('[run_all] échec du restart du container :', e.message);
  }
}

const tests = readdirSync(__dirname)
  .filter(f => /^test_.*\.mjs$/.test(f))
  .sort();

let failed = 0;
for (const f of tests) {
  console.log(`\n--- ${f} ---`);
  const start = Date.now();
  const ok = await new Promise(resolve => {
    const p = spawn(process.execPath, [join(__dirname, f)], { stdio: 'inherit' });
    p.on('exit', code => resolve(code === 0));
  });
  const dt = ((Date.now() - start) / 1000).toFixed(1);
  if (!ok) failed++;
  console.log(`>>> ${f}: ${ok ? 'OK' : 'FAIL'} (${dt}s)`);
}

console.log(`\n========= ${tests.length - failed}/${tests.length} tests passés =========`);
process.exit(failed > 0 ? 1 : 0);
