#!/usr/bin/env bash
# One-time checks and directory setup for the staging host.
#
# Run as the deploy user (the account the workflow connects as), or as root
# followed by `chown -R <deploy-user> /opt/kfin-staging`:
#
#   STAGING_SITE_ADDRESS=staging.example.com bash host-bootstrap.sh
#
# It installs nothing and changes no firewall rule: Docker Engine, the Compose
# plugin and the DNS record are owner actions (see README.md). Re-running it is
# safe.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/kfin-staging}"
SITE="${STAGING_SITE_ADDRESS:-}"

failures=0
check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok      %s\n' "$label"
  else
    printf 'FAILED  %s\n' "$label"
    failures=$((failures + 1))
  fi
}

check "Docker daemon reachable" docker info
check "Compose plugin present" docker compose version
check "network tools present" sh -c 'command -v ss || command -v netstat'

docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
compose_version="$(docker compose version --short 2>/dev/null || echo unknown)"
echo "Docker ${docker_version}, Compose ${compose_version} (need Docker >= 24, Compose >= 2.17 for 'up --wait')"

if [ "$(id -u)" -eq 0 ]; then
  echo "warning: running as root. The deploy workflow connects as a non-root user in the 'docker' group."
  echo "         Create ${DEPLOY_DIR} yourself, then 'chown -R <deploy-user> ${DEPLOY_DIR}'."
else
  if id -nG "$(id -un)" | grep -qw docker; then
    echo "ok      user '$(id -un)' is in the docker group"
  else
    echo "FAILED  user '$(id -un)' is not in the docker group"
    failures=$((failures + 1))
  fi
  mkdir -p "$DEPLOY_DIR"
  chmod 750 "$DEPLOY_DIR"
  echo "ok      ${DEPLOY_DIR} exists"
fi

for port in 80 443; do
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "( sport = :${port} )" 2>/dev/null | tail -n +2 | grep -q .; then
      echo "FAILED  TCP ${port} is already in use (stop the other web server)"
      failures=$((failures + 1))
    else
      echo "ok      TCP ${port} is free"
    fi
  fi
done

if [ -n "$SITE" ]; then
  resolved="$(getent ahostsv4 "$SITE" 2>/dev/null | awk 'NR==1 {print $1}')"
  public="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    echo "FAILED  ${SITE} does not resolve (create the DNS A record before deploying)"
    failures=$((failures + 1))
  elif [ -n "$public" ] && [ "$resolved" != "$public" ]; then
    echo "warning ${SITE} resolves to ${resolved}, this host reports ${public}"
    echo "        Let's Encrypt will fail until they match (or a proxy is in front)."
  else
    echo "ok      ${SITE} resolves to ${resolved}"
  fi
else
  echo "note    set STAGING_SITE_ADDRESS to check the DNS record"
fi

if [ "$failures" -gt 0 ]; then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "host is ready for the staging workflow"
