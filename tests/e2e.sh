#!/bin/sh
# tests/e2e.sh — Suite Playwright complète contre un OpenFGA déjà démarré.
#
# Charge les stores de démonstration, démarre le binaire (authentification
# locale active) et lance run_all.mjs. Utilisé par la CI ; marche aussi en
# local :  OPENFGA_URL=http://localhost:8080 sh tests/e2e.sh
#
#   OPENFGA_URL   API OpenFGA (défaut http://localhost:8080)
#   EXPLORER_BIN  binaire déjà compilé (sinon go build)
#   PORT          port d'écoute de l'Explorer (défaut 18000)
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
OPENFGA_URL=${OPENFGA_URL:-http://localhost:8080}
PORT=${PORT:-18000}
WORK=$(mktemp -d)
PID=
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$WORK"' EXIT

# wait_ok URL SECONDES : attend une réponse 2xx (node plutôt que curl,
# absent de certaines images).
wait_ok() {
  node -e '
    const [url, n] = process.argv.slice(1);
    (async () => {
      for (let i = 0; i < n; i++) {
        try { if ((await fetch(url)).ok) return; } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
      process.exit(1);
    })();' "$1" "$2"
}
random_hex() { node -e "console.log(require('node:crypto').randomBytes($1).toString('hex'))"; }

wait_ok "$OPENFGA_URL/healthz" 60 || { echo "OpenFGA injoignable sur $OPENFGA_URL" >&2; exit 1; }
(cd tests && node tools/seed-examples.mjs --openfga-url="$OPENFGA_URL")

BIN=${EXPLORER_BIN:-}
if [ -z "$BIN" ]; then
  BIN=$WORK/explorer
  (cd src/server && go build -o "$BIN" .)
fi

ADMIN_PASSWORD=$(random_hex 12)
export ADMIN_PASSWORD
ADDR=127.0.0.1:$PORT OPENFGA_URL=$OPENFGA_URL SESSION_SECRET=$(random_hex 32) \
  WEB_DIR=$ROOT/src/web VIEWS_DIR=$ROOT/src/server/views \
  "$BIN" > "$WORK/explorer.log" 2>&1 &
PID=$!
wait_ok "http://127.0.0.1:$PORT/api/health" 30 || { cat "$WORK/explorer.log" >&2; exit 1; }

cd tests
if ! APP_URL=http://127.0.0.1:$PORT OPENFGA_URL=$OPENFGA_URL node run_all.mjs; then
  echo '--- explorer.log (fin) ---'
  tail -50 "$WORK/explorer.log"
  exit 1
fi
