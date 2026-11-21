// lib/codegen/curl.js — Script bash autour de l'API HTTP d'OpenFGA :
// check, grant, revoke, list-objects, list-users et read, avec le store et
// le modèle courants par défaut.

import { headerLines } from './spec.js';

export function generateCurl(spec) {
  const ex = spec.example;
  const relations = spec.types
    .filter(t => t.relations.length)
    .map(t => `#   ${t.name}: ${t.relations.map(r => r.name).join(', ')}`);
  const lines = [
    '#!/usr/bin/env bash',
    ...headerLines(spec, '#', 'API HTTP (curl)'),
    '#',
    '# Usage :',
    '#   ./openfga.sh check        <user> <relation> <object>',
    '#   ./openfga.sh grant        <user> <relation> <object>',
    '#   ./openfga.sh revoke       <user> <relation> <object>',
    '#   ./openfga.sh list-objects <user> <relation> <type>',
    '#   ./openfga.sh list-users   <object> <relation> <user-type>',
    '#   ./openfga.sh read         [object]',
  ];
  if (ex) {
    lines.push(
      '#',
      '# Exemple :',
      `#   ./openfga.sh grant ${ex.user} ${ex.writeRelation} ${ex.object}`,
      `#   ./openfga.sh check ${ex.user} ${ex.checkRelation} ${ex.object}`,
    );
  }
  if (relations.length) lines.push('#', '# Relations du modèle :', ...relations);
  lines.push(
    'set -euo pipefail',
    '',
    `FGA_API_URL="\${FGA_API_URL:-${spec.apiUrl}}"`,
    `FGA_STORE_ID="\${FGA_STORE_ID:-${spec.storeId}}"`,
    `FGA_MODEL_ID="\${FGA_MODEL_ID:-${spec.modelId}}"`,
    ': "${FGA_STORE_ID:?FGA_STORE_ID requis}"',
    '',
    '# Échappe une valeur pour une chaîne JSON.',
    'json() { local s=${1//\\\\/\\\\\\\\}; s=${s//\\"/\\\\\\"}; printf \'"%s"\' "$s"; }',
    '',
    '# Champ authorization_model_id, si un modèle est fixé.',
    'model() { [ -n "$FGA_MODEL_ID" ] && printf \',"authorization_model_id":%s\' "$(json "$FGA_MODEL_ID")" || true; }',
    '',
    'call() {',
    '  local auth=()',
    '  [ -n "${FGA_API_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $FGA_API_TOKEN")',
    '  curl -sS --fail-with-body -X POST "$FGA_API_URL/stores/$FGA_STORE_ID/$1" \\',
    '    -H "Content-Type: application/json" "${auth[@]}" -d "$2"',
    '  echo',
    '}',
    '',
    'tuple() { printf \'{"user":%s,"relation":%s,"object":%s}\' "$(json "$1")" "$(json "$2")" "$(json "$3")"; }',
    '',
    'case "${1:-}" in',
    '  check)',
    '    call check "$(printf \'{"tuple_key":%s%s}\' "$(tuple "$2" "$3" "$4")" "$(model)")" ;;',
    '  grant)',
    '    call write "$(printf \'{"writes":{"tuple_keys":[%s]}%s}\' "$(tuple "$2" "$3" "$4")" "$(model)")" ;;',
    '  revoke)',
    '    call write "$(printf \'{"deletes":{"tuple_keys":[%s]}%s}\' "$(tuple "$2" "$3" "$4")" "$(model)")" ;;',
    '  list-objects)',
    '    call list-objects "$(printf \'{"user":%s,"relation":%s,"type":%s%s}\' "$(json "$2")" "$(json "$3")" "$(json "$4")" "$(model)")" ;;',
    '  list-users)',
    '    call list-users "$(printf \'{"object":{"type":%s,"id":%s},"relation":%s,"user_filters":[{"type":%s}]%s}\' \\',
    '      "$(json "${2%%:*}")" "$(json "${2#*:}")" "$(json "$3")" "$(json "$4")" "$(model)")" ;;',
    '  read)',
    '    if [ -n "${2:-}" ]; then',
    '      call read "$(printf \'{"tuple_key":{"object":%s}}\' "$(json "$2")")"',
    '    else',
    '      call read \'{}\'',
    '    fi ;;',
    '  *)',
    '    sed -n \'2,/^set -euo/p\' "$0" | sed \'$d\' | sed \'s/^# \\{0,1\\}//\'',
    '    exit 1 ;;',
    'esac',
  );
  return lines.join('\n') + '\n';
}
