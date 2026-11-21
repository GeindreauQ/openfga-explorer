#!/bin/sh
# Reporte un tag d'image dans le values du chart openfga du dépôt infra-as-code.
#   - clone superficiel d'INFRA_BRANCH via une deploy key SSH (droit d'écriture) ;
#   - remplace image.tag (seule ligne touchée : commentaires et mise en forme conservés) ;
#   - INFRA_UPDATE_MODE=merge_request (défaut) : push d'une branche dédiée, la MR
#     est ouverte par les push options GitLab (aucun jeton d'API nécessaire) ;
#     INFRA_UPDATE_MODE=commit : push direct sur INFRA_BRANCH.
# Si INFRA_BRANCH a avancé entre le clone et le push, git refuse (non fast-forward)
# au lieu d'écraser.
#
# Usage : INFRA_DEPLOY_KEY=<clé privée en base64> scripts/update-infra.sh <tag>
set -eu

TAG="${1:?usage: $0 <tag>}"
: "${INFRA_DEPLOY_KEY:?INFRA_DEPLOY_KEY requis (clé privée SSH encodée en base64)}"
: "${INFRA_REPO:?INFRA_REPO requis (URL SSH du dépôt infra-as-code)}"
INFRA_BRANCH="${INFRA_BRANCH:-main}"
INFRA_VALUES_FILE="${INFRA_VALUES_FILE:-openfga/Values.yaml}"
# Clé racine du values dont le premier "tag:" porte l'image de ce dépôt.
INFRA_IMAGE_KEY="${INFRA_IMAGE_KEY:-explorer}"
INFRA_UPDATE_MODE="${INFRA_UPDATE_MODE:-merge_request}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
umask 077
printf %s "$INFRA_DEPLOY_KEY" | base64 -d > "$tmp/key"
# Clé d'hôte de gitlab.com épinglée (empreinte publiée
# SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8) : pas de confiance au premier usage.
echo "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf" > "$tmp/known_hosts"
export GIT_SSH_COMMAND="ssh -i $tmp/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$tmp/known_hosts"

git clone -q --depth 1 --branch "$INFRA_BRANCH" "$INFRA_REPO" "$tmp/repo"
cd "$tmp/repo"

# Remplace le premier "tag:" du bloc racine INFRA_IMAGE_KEY (jusqu'à la clé racine suivante).
awk -v tag="$TAG" -v key="$INFRA_IMAGE_KEY" '
  /^[^[:space:]#]/ { in_image = (index($0, key ":") == 1) }
  in_image && !done && /^[[:space:]]+tag:/ { sub(/tag:.*/, "tag: \"" tag "\""); done = 1 }
  { print }
  END { if (!done) exit 3 }
' "$INFRA_VALUES_FILE" > "$tmp/after.yaml" || { echo "$INFRA_IMAGE_KEY.tag introuvable dans $INFRA_VALUES_FILE" >&2; exit 1; }
cp "$tmp/after.yaml" "$INFRA_VALUES_FILE"

if git diff --quiet; then
  echo "image.tag vaut déjà $TAG : rien à faire."
  exit 0
fi
git --no-pager diff

title="openfga-explorer : image $TAG"
git -c user.name="${GITLAB_USER_NAME:-openfga-explorer CI}" \
    -c user.email="${GITLAB_USER_EMAIL:-ci@openfga-explorer.invalid}" \
    commit -q -a -F - <<EOF
$title

Source : ${CI_PROJECT_URL:-openfga-explorer}/-/commit/${CI_COMMIT_SHA:-$TAG}
Pipeline : ${CI_PIPELINE_URL:-manuel}
EOF

if [ "$INFRA_UPDATE_MODE" = "commit" ]; then
  git push -q origin "HEAD:$INFRA_BRANCH"
  echo "poussé sur $INFRA_BRANCH"
else
  branch="deploy/openfga-explorer-$TAG"
  git push -q -f \
    -o merge_request.create \
    -o merge_request.target="$INFRA_BRANCH" \
    -o merge_request.title="$title" \
    -o merge_request.remove_source_branch \
    -o merge_request.label=deploy \
    origin "HEAD:refs/heads/$branch"
  echo "branche $branch poussée, merge request ouverte vers $INFRA_BRANCH"
fi
