#!/usr/bin/env bash
# scripts/vendor.sh — Re-télécharge les dépendances tierces du frontend
# dans src/web/vendor/. À lancer quand une des deps est mise à jour.
#
# Pourquoi : le projet ne dépend d'aucun CDN au runtime (politique
# air-gap + CSP stricte). Les versions sont pinned pour reproductibilité.
#
# Prérequis : npm + esbuild (npm install --no-save esbuild dans un
# répertoire jetable). On évite un devDep dans le projet lui-même
# puisque le bundle est commit tel quel.

set -euo pipefail

VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/web/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Versions pinned — bump ici quand une mise à jour est validée.
SYNTAX_TRANSFORMER_VERSION="0.2.1"
SYNTAX_TRANSFORMER_PEERS=("@openfga/sdk@0.9.6" "yaml@2" "ajv@8" "antlr4@4")
CYTOSCAPE_VERSION="3.30.4"
TABLER_VERSION="3.34.0"

mkdir -p "$VENDOR_DIR/tabler-icons/fonts"

echo "==> Bundling @openfga/syntax-transformer@$SYNTAX_TRANSFORMER_VERSION (CJS → ESM)…"
mkdir -p "$TMP/st" && cd "$TMP/st"
npm pack --silent "@openfga/syntax-transformer@$SYNTAX_TRANSFORMER_VERSION" \
  | tar -xz --strip-components=1
# Installe esbuild + les peer deps locales pour le bundling.
npm install --silent --no-audit --no-fund esbuild "${SYNTAX_TRANSFORMER_PEERS[@]}"
# Bundle le CJS en un seul ESM minifié pour le navigateur.
# `crypto` est aliasé vers globalThis.crypto (Web Crypto API dispo
# dans tous les browsers modernes).
cat > "$TMP/crypto-shim.mjs" <<'SHIM'
const c = globalThis.crypto;
export const randomUUID = (...a) => c.randomUUID(...a);
export const randomBytes = (...a) => {
  const n = (a[0] || 0) | 0;
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return { toString: enc => Array.from(out, b => b.toString(16).padStart(2, '0')).join('') };
};
export default { randomUUID, randomBytes };
SHIM
./node_modules/.bin/esbuild dist/index.js \
  --bundle --format=esm --target=es2020 --minify \
  --platform=browser --legal-comments=none \
  --alias:crypto="$TMP/crypto-shim.mjs" \
  --outfile="$VENDOR_DIR/openfga-syntax-transformer.mjs"

echo "==> Downloading cytoscape@$CYTOSCAPE_VERSION ESM…"
curl -fsSL "https://cdn.jsdelivr.net/npm/cytoscape@$CYTOSCAPE_VERSION/dist/cytoscape.esm.mjs" \
  -o "$VENDOR_DIR/cytoscape.esm.mjs"

echo "==> Downloading @tabler/icons-webfont@$TABLER_VERSION CSS + WOFF2…"
cd "$TMP"
npm pack --silent "@tabler/icons-webfont@$TABLER_VERSION" | tar -xz --strip-components=1
cp dist/tabler-icons.min.css "$VENDOR_DIR/tabler-icons/tabler-icons.min.css"
cp dist/fonts/tabler-icons.woff2 "$VENDOR_DIR/tabler-icons/fonts/"
# Strip les fallbacks woff/ttf du CSS (on ne ship que WOFF2) pour
# éviter des 404 silencieux dans la console.
python3 - "$VENDOR_DIR/tabler-icons/tabler-icons.min.css" <<'PY'
import re, sys
p = sys.argv[1]
with open(p) as f: css = f.read()
css = re.sub(r',url\("\./fonts/tabler-icons\.woff[^)]*\) format\("woff"\)', '', css)
css = re.sub(r',url\("\./fonts/tabler-icons\.ttf[^)]*\) format\("truetype"\)', '', css)
with open(p, 'w') as f: f.write(css)
PY

echo "==> Vendor contents:"
find "$VENDOR_DIR" -maxdepth 3 -type f -printf '  %p (%s bytes)\n'
echo
echo "Done. N'oublie pas de mettre à jour l'importmap dans index.html si tu as bumpé les versions."