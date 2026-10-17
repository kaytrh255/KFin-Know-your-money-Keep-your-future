#!/usr/bin/env bash
# Logical backup of the KFin database (PostgreSQL / Supabase compatible).
#
# The dump is the provider-independent copy: `pg_dump --format=custom` includes
# schema, data, ownership and the ACLs the application role depends on. It is
# written with a 0700 umask because it contains user data and password digests.
#
# Usage:
#   SOURCE_DATABASE_URL=postgresql://... BACKUP_FILE=/secure/path/kfin.dump \
#     scripts/operations/backup-database.sh
#
# Optional:
#   PG_DUMP=/path/to/pg_dump   pin the client version (must be >= server major)
#   PG_RESTORE=/path/to/pg_restore
#
# This script never prints the connection string or its password.
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"

if [ -e "$BACKUP_FILE" ]; then
  echo "refusing to overwrite an existing backup: $BACKUP_FILE" >&2
  exit 1
fi

if ! command -v "$PG_DUMP" >/dev/null 2>&1; then
  echo "pg_dump not found. Install PostgreSQL client tools or set PG_DUMP." >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname "$BACKUP_FILE")"

# --lock-wait-timeout: a stuck table lock must fail the backup, not hang it.
"$PG_DUMP" \
  --format=custom \
  --compress=6 \
  --lock-wait-timeout=30s \
  --file="$BACKUP_FILE" \
  "$SOURCE_DATABASE_URL"

# A dump that cannot be listed cannot be restored; fail before declaring success.
"$PG_RESTORE" --list "$BACKUP_FILE" >/dev/null

SIZE_BYTES="$(wc -c < "$BACKUP_FILE" | tr -d ' ')"
if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM="$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')"
else
  CHECKSUM="unavailable"
fi

printf 'backup complete: file=%s bytes=%s sha256=%s\n' "$BACKUP_FILE" "$SIZE_BYTES" "$CHECKSUM"
