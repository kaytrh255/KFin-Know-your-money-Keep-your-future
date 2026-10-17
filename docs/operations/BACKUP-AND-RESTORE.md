# Backup and restore

Status: **procedure and scripts exist and were executed on 2026-10-17** against a
disposable local PostgreSQL 18 cluster. No production or Supabase backup has been
configured or tested.

## Targets (proposed, not approved policy)

| Property | Target | Mechanism |
|---|---|---|
| RPO | ≤ 5 minutes | Supabase PITR (paid add-on) |
| RPO fallback | ≤ 24 hours | provider daily backup + nightly logical dump |
| RTO | ≤ 2 hours | restore snapshot/PITR, then verify with `verify-restore.mjs` |
| Retention | 14 days | provider retention + dump retention |
| Drill cadence | quarterly and before any destructive migration | `pnpm run backup:drill` |

These numbers are engineering proposals for the beta; they are not measured
production results and no owner has approved them.

## Two layers

1. **Provider-managed** (Supabase): enable daily backups, and PITR if the plan
   supports it, before any real user data exists. Record the plan's actual
   retention and the PITR window in the deploy record — the defaults differ by
   plan and an upgraded plan is not retroactive.
2. **Logical dump** (this repository): `pg_dump --format=custom`. It is the
   provider-independent copy and the only one an operator can restore into a
   different cluster.

A provider backup that has never been restored is a hope, not a backup: run the
drill against staging and record the numbers.

## Taking a backup

```bash
SOURCE_DATABASE_URL='postgresql://...' \
BACKUP_FILE=/secure/kfin-$(date -u +%Y%m%dT%H%M%SZ).dump \
  scripts/operations/backup-database.sh
```

The script refuses to overwrite, writes with a `0700` umask, fails on a lock
wait longer than 30 seconds, and verifies the archive can be listed before it
prints the size and SHA-256. A dump contains user email addresses and password
digests: store it encrypted, restrict access, and delete it on the retention
schedule.

## Restoring

The target must be an **empty** database; the script refuses otherwise.

```bash
# 1. roles and grants first — the dump records ownership and ACLs
ROLE_ADMIN_DATABASE_URL='postgresql://admin@target/kfin' corepack pnpm run db:provision-roles

# 2. restore (single transaction, abort on first error)
TARGET_DATABASE_URL='postgresql://admin@target/kfin' BACKUP_FILE=/secure/kfin-....dump \
  scripts/operations/restore-database.sh

# 3. content must match the source
SOURCE_DATABASE_URL='postgresql://admin@source/kfin' \
TARGET_DATABASE_URL='postgresql://admin@target/kfin' \
  node scripts/operations/verify-restore.mjs

# 4. the application role must still be least-privileged
DATABASE_URL='postgresql://kfin_app@target/kfin' corepack pnpm run db:verify-app-role
```

`verify-restore.mjs` compares every `public` base table (row count and an `md5`
content checksum), the migration list and checksums, RLS flags and policies,
table grants for the three KFin roles, and sequence positions. Exit code 0 is a
pass; any difference is listed.

Restore is a **point-in-time rewind**: sessions, invitations and challenges
created after the dump no longer exist. Users must sign in again, and any code
issued after the backup is invalid.

## Executed drill

`scripts/operations/backup-restore-drill.mjs` creates two throwaway databases on
a non-production cluster, provisions roles, migrates the source with the
production migration bundle, seeds users and an account, dumps, restores, and
compares. It drops both databases afterwards.

Measured 2026-10-17, local PostgreSQL 18.4, artifact `caa43a818`:

| Step | Result |
|---|---|
| migrations on an empty database | 11 applied |
| seeded rows | 2 users, 1 financial account, 14 categories |
| dump | 77 ms |
| restore | 117 ms |
| verification | 19 tables / 28 rows, 0 differences (counts, checksums, RLS, policies, grants, sequences) |
| `kfin_app` least privilege after restore | 159 checks passed |
| application read through restored grants | 14 category rows |

Drill command (CI uses the same script):

```bash
ADMIN_DATABASE_URL=... MIGRATION_DATABASE_URL=... APP_DATABASE_URL=... \
  corepack pnpm run backup:drill
```

The timings are for an almost-empty database and say nothing about a real
restore; they prove the procedure, not the RTO.

## What is still missing

- no scheduled backup job, retention bucket or encryption key;
- no Supabase project, so PITR/backup settings are unverified;
- no restore into a staging environment or from a provider snapshot;
- no alert when a backup fails.
