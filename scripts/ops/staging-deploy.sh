#!/usr/bin/env bash
# Deploys one published image to the staging host.
#
# Runs ON the host, in the directory that holds the Compose files, `Caddyfile`,
# `staging.env` and `migration.env` (default: /opt/kfin-staging). The staging
# workflow calls it over SSH; an operator can run it by hand:
#
#   KFIN_IMAGE=ghcr.io/<owner>/<repo>/kfin-runtime:sha-<commit> \
#   STAGING_SITE_ADDRESS=staging.example.com \
#   STAGING_TLS_ARGS=ops@example.com \
#     bash staging-deploy.sh
#
# Order matters: migrations run first, as `kfin_migrator`, from the same image
# and against the same database. The API is only replaced once the schema is
# ready, so a failed migration leaves the previous deployment serving.
#
# Exit codes: 0 deployed, 1 failed, 2 usage/configuration.

set -euo pipefail

: "${KFIN_IMAGE:?KFIN_IMAGE is required (ghcr.io/.../kfin-runtime:sha-<commit>)}"
: "${STAGING_SITE_ADDRESS:?STAGING_SITE_ADDRESS is required}"
: "${STAGING_TLS_ARGS:?STAGING_TLS_ARGS is required (ACME email, or 'internal' for a test CA)}"

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BASE_COMPOSE="$DEPLOY_DIR/docker-compose.yml"
DATABASE_COMPOSE="$DEPLOY_DIR/docker-compose.database.yml"
ENV_FILE="$DEPLOY_DIR/staging.env"
DB_ENV_FILE="$DEPLOY_DIR/db.env"
MIGRATION_ENV_FILE="$DEPLOY_DIR/migration.env"
NETWORK_NAME="${NETWORK_NAME:-kfin-staging-edge}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

if [ "$STAGING_TLS_ARGS" = "internal" ] && [ "${ALLOW_INTERNAL_TLS:-0}" != "1" ]; then
  echo "refusing 'internal' TLS on a real host: set STAGING_TLS_ARGS to the ACME email," >&2
  echo "or ALLOW_INTERNAL_TLS=1 for a throwaway host." >&2
  exit 2
fi

for file in "$BASE_COMPOSE" "$ENV_FILE" "$DB_ENV_FILE" "$MIGRATION_ENV_FILE"; do
  if [ ! -f "$file" ]; then
    echo "missing $file" >&2
    exit 2
  fi
done
if [ ! -f "$DEPLOY_DIR/Caddyfile" ]; then
  echo "missing $DEPLOY_DIR/Caddyfile" >&2
  exit 2
fi

# Names only: never print a value.
for name in DATABASE_POOL_MAX IDEMPOTENCY_RETENTION_HOURS AUTH_SECRET FINANCIAL_PREVIEW_SIGNING_KEY AUTH_COOKIE_SECURE; do
  if ! grep -Eq "^${name}=.+$" "$ENV_FILE"; then
    echo "staging.env is missing a value for ${name}" >&2
    exit 2
  fi
done
if ! grep -Eq '^MIGRATION_DATABASE_URL=.+$' "$MIGRATION_ENV_FILE"; then
  echo "migration.env is missing MIGRATION_DATABASE_URL" >&2
  exit 2
fi
if grep -qx 'EMAIL_DELIVERY_ADAPTER=none' "$ENV_FILE" && ! grep -qx 'STAGING_MODE=true' "$ENV_FILE"; then
  echo "EMAIL_DELIVERY_ADAPTER=none is refused outside staging: set STAGING_MODE=true explicitly." >&2
  exit 2
fi

# db.env carries only what Compose and the database container need, so the API
# container never receives the admin or migration credential.
db_mode="$(sed -n 's/^STAGING_DB_MODE=//p' "$DB_ENV_FILE" | tail -1)"
db_mode="${db_mode:-container}"

compose=(docker compose -f "$BASE_COMPOSE" --project-directory "$DEPLOY_DIR" --env-file "$DB_ENV_FILE")
if [ "$db_mode" = "container" ]; then
  compose+=(-f "$DATABASE_COMPOSE")
  for name in STAGING_DB_ADMIN_PASSWORD KFIN_APP_PASSWORD; do
    if ! grep -Eq "^${name}=.+$" "$DB_ENV_FILE"; then
      echo "db.env is missing a value for ${name} (required for a container database)" >&2
      exit 2
    fi
  done
elif [ "$db_mode" != "managed" ]; then
  echo "STAGING_DB_MODE must be 'container' or 'managed' (got '$db_mode')" >&2
  exit 2
fi

export KFIN_IMAGE STAGING_SITE_ADDRESS STAGING_TLS_ARGS

trusted_cidr="${KFIN_PROXY_CIDR:-172.28.0.0/16}"
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  actual_cidr="$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$NETWORK_NAME" | tr -d ' ')"
  case " $actual_cidr " in
    *" $trusted_cidr "* | "") : ;;
    *)
      echo "network ${NETWORK_NAME} has subnet '${actual_cidr}', but the app trusts '${trusted_cidr}'." >&2
      echo "Remove the stale network (docker network rm ${NETWORK_NAME}) or set KFIN_PROXY_CIDR to match it." >&2
      exit 2
      ;;
  esac
else
  echo "==> creating network ${NETWORK_NAME} (${trusted_cidr})"
  docker network create --subnet "$trusted_cidr" "$NETWORK_NAME" >/dev/null
fi

# The migration container joins the edge network, so it can also reach a
# container database by its `db` service name.
if [ "$db_mode" = "container" ]; then
  echo "==> starting the staging database"
  "${compose[@]}" up -d --wait db
fi

echo "==> pulling ${KFIN_IMAGE}"
"${compose[@]}" pull kfin

echo "==> applying migrations as the migration role"
# A separate env file keeps the migrator credential out of the API container.
docker run --rm \
  --env-file "$MIGRATION_ENV_FILE" \
  --network "$NETWORK_NAME" \
  "$KFIN_IMAGE" node migrate.bundle.mjs

echo "==> starting the stack"
"${compose[@]}" up -d --remove-orphans

echo "==> waiting for the API to become healthy"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
container="$("${compose[@]}" ps -q kfin)"
status="missing"
while [ "$(date +%s)" -lt "$deadline" ]; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo missing)"
  case "$status" in
    healthy | unhealthy) break ;;
  esac
  sleep 3
done

if [ "$status" != "healthy" ]; then
  echo "the API did not become healthy (status: $status). Last logs:" >&2
  "${compose[@]}" logs --tail=80 kfin >&2 || true
  exit 1
fi

echo "==> deployed"
docker inspect --format 'image={{.Config.Image}} started={{.State.StartedAt}}' "$container"
"${compose[@]}" exec -T kfin node --input-type=module -e "import { readFileSync } from 'node:fs'; console.log(readFileSync('BUILD-INFO.json', 'utf8').trim())"

# Keep the previous image for a manual rollback but do not grow without bound.
docker image prune -f --filter "until=168h" >/dev/null || true
