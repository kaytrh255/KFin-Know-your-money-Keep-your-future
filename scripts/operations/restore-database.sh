#!/usr/bin/env bash
# Restores a logical backup produced by backup-database.sh.
#
# The target must be an EMPTY database. Restoring over a live one would leave a
# mixture of two schema versions that no verification can separate, so the script
# refuses instead of guessing. Provision the KFin roles first (they own the
# objects and hold the grants the dump records):
#
#   1. ROLE_ADMIN_DATABASE_URL=<admin url for the empty target> \
#      corepack pnpm run db:provision-roles
#   2. TARGET_DATABASE_URL=<admin url for the empty target> \
#      BACKUP_FILE=/secure/path/kfin.dump scripts/operations/restore-database.sh
#   3. SOURCE_DATABASE_URL=<admin url for the source> \
#      TARGET_DATABASE_URL=<admin url for the target> \
#      node scripts/operations/verify-restore.mjs
#   4. DATABASE_URL=<kfin_app url for the target> corepack pnpm run db:verify-app-role
#
# Usage:
#   TARGET_DATABASE_URL=postgresql://... BACKUP_FILE=/secure/path/kfin.dump \
#     scripts/operations/restore-database.sh
#
# Optional: PG_RESTORE, PSQL.
set -euo pipefail

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

PG_RESTORE="${PG_RESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"

if [ ! -s "$BACKUP_FILE" ]; then
  echo "backup file is missing or empty: $BACKUP_FILE" >&2
  exit 1
fi

if ! command -v "$PG_RESTORE" >/dev/null 2>&1; then
  echo "pg_restore not found. Install PostgreSQL client tools or set PG_RESTORE." >&2
  exit 1
fi

EXISTING_TABLES="$("$PSQL" "$TARGET_DATABASE_URL" -tAc \
  "select count(*) from pg_tables where schemaname = 'public'")"
if [ "$EXISTING_TABLES" != "0" ]; then
  echo "refusing to restore into a non-empty database: $EXISTING_TABLES table(s) in public" >&2
  exit 1
fi

# --single-transaction: a failure leaves the empty database empty, never half
# restored. --exit-on-error is what makes that transaction roll back on the
# first SQL error (pg_restore otherwise continues and reports "errors ignored").
"$PG_RESTORE" \
  --dbname="$TARGET_DATABASE_URL" \
  --single-transaction \
  --exit-on-error \
  "$BACKUP_FILE"

printf 'restore complete: file=%s\n' "$BACKUP_FILE"
