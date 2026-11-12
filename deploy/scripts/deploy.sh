#!/usr/bin/env bash
# Runs on the droplet as the deploy user. Called by .github/workflows/deploy.yml after the compose file was copied
# to /opt/firstmic/.compose.yml.<github run id> and this script to /opt/firstmic/bin.
#
#   deploy.sh <40-char commit sha> <github run id>
#
# Updates firstmic and cloudflared. Never removes volumes, never prunes broadly.
set -Eeuo pipefail

sha="${1:?usage: deploy.sh <sha> <run-id>}"
run_id="${2:?usage: deploy.sh <sha> <run-id>}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy: invalid sha '$sha'" >&2; exit 2; }
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo "deploy: invalid run id '$run_id'" >&2; exit 2; }

deploy_dir="/opt/firstmic"
image="ghcr.io/raghadalsaka/firstmic"
health_timeout=120
min_compose="2.24.0"

cd "$deploy_dir"
staged_compose=".compose.yml.$run_id"
trap 'rm -f "$staged_compose"' EXIT

compose() {
  docker compose --env-file .env --env-file images.env -f compose.yml "$@"
}

fail() {
  echo "deploy: $*" >&2
  exit 1
}

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

set_image_env() {
  # Rewrites one KEY=VALUE line in images.env atomically, keeping every other line.
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$deploy_dir/.images.env.XXXXXX")"
  { grep -v "^${key}=" images.env 2>/dev/null || true; printf '%s=%s\n' "$key" "$value"; } > "$tmp"
  mv -f "$tmp" images.env
}

wait_tunnel() {
  # The cloudflared image has no shell, so there is no container health check; its metrics
  # endpoint answers /ready with 200 only while a tunnel connection is registered.
  local cid ip waited=0
  cid="$(compose ps -q cloudflared)"
  [ -n "$cid" ] || fail "cloudflared container not found"
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid")"
  while [ "$waited" -lt "$health_timeout" ]; do
    if curl -fsS --max-time 3 "http://$ip:2000/ready" > /dev/null 2>&1; then
      echo "deploy: cloudflared connected"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  echo "deploy: cloudflared is not connected; recent logs:" >&2
  compose logs --no-color --tail 50 cloudflared >&2 || true
  return 1
}

compose_version="$(docker compose version --short)"
version_ge "$compose_version" "$min_compose" || fail "docker compose $compose_version is too old; need >= $min_compose"

[ -f .env ] || fail "$deploy_dir/.env is missing. Create it from deploy/.env.production.example (see docs/DEPLOYMENT.md)."
[ -f "$staged_compose" ] || fail "staged compose file $staged_compose not found"

echo "deploy: pulling $image:$sha"
docker pull --quiet "$image:$sha"

if [ ! -f images.env ]; then
  echo "deploy: bootstrapping images.env"
  printf 'FIRSTMIC_IMAGE_TAG=%s\n' "$sha" > images.env
fi
previous_tag="$(sed -n 's/^FIRSTMIC_IMAGE_TAG=//p' images.env)"

echo "deploy: validating staged compose file"
docker compose --env-file .env --env-file images.env -f "$staged_compose" config --quiet
mv -f "$staged_compose" compose.yml

if [ -n "$previous_tag" ] && [ "$previous_tag" != "$sha" ]; then
  set_image_env FIRSTMIC_PREVIOUS_TAG "$previous_tag"
fi
set_image_env FIRSTMIC_IMAGE_TAG "$sha"

echo "deploy: updating firstmic"
if ! compose up -d --no-deps --wait --wait-timeout "$health_timeout" firstmic; then
  compose logs --no-color --tail 50 firstmic >&2 || true
  fail "firstmic did not become healthy; roll back with: FIRSTMIC_IMAGE_TAG=${previous_tag:-<previous sha>} in images.env, then docker compose ... up -d --no-deps firstmic"
fi

echo "deploy: updating cloudflared"
compose up -d --no-deps cloudflared
wait_tunnel || fail "cloudflared did not register a tunnel connection; check CLOUDFLARE_TUNNEL_TOKEN in .env and the tunnel status in Cloudflare Zero Trust"

echo "deploy: removing local firstmic images other than current and previous"
docker image ls --format '{{.Repository}}:{{.Tag}}' "$image" \
  | grep -v -e ":$sha\$" -e ":${previous_tag:-none}\$" -e ':<none>$' \
  | xargs -r docker image rm >/dev/null 2>&1 || true

echo "deploy: firstmic $sha deployed (previous: ${previous_tag:-none})"
