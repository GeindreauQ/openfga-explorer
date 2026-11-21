import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Le front importe '@openfga/syntax-transformer' via l'import map du
// navigateur, qui pointe vers le bundle ESM vendorisé (export par défaut
// seulement). Les modules de src/web/ reçoivent ce même bundle ; les tests
// gardent le paquet npm.
const vendored = fileURLToPath(new URL('../src/web/vendor/openfga-syntax-transformer.mjs', import.meta.url));

export default defineConfig({
  plugins: [{
    name: 'browser-import-map',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@openfga/syntax-transformer' && importer?.includes('/src/web/')) return vendored;
      return null;
    },
  }],
  test: {
    include: ['dsl/**/*.test.mjs'],
    environment: 'node',
    testTimeout: 10000,
  },
});
