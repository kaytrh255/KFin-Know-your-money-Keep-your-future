# A migration failed: what is true and what to do

KFin migrations are **forward-only** and checksum-pinned. There is no down
migration and no `migrate:down` command; do not assume one exists. This document
states the boundary that is actually enforced by the runner and proven by tests.

## What the runner guarantees

`packages/database/src/migrations.ts`:

- one advisory lock per run, so two deploys cannot migrate concurrently;
- `kfin_migrations` records `version`, `name` and a SHA-256 of the file;
- each **file** runs in its own transaction with `lock_timeout=5s` and
  `statement_timeout=30s`;
- a file that fails rolls back completely — no objects, no row;
- a file whose checksum no longer matches the recorded one aborts the run before
  executing anything;
- an unchanged migration set is a no-op.

It does **not** wrap the whole run in one transaction. If files 0001–0005 are
new and 0006 fails, 0001–0005 stay applied and committed; only 0006 is rolled
back. Recovery is therefore "roll forward" or "restore", never "undo".

## Preflight (before every migration)

1. Take a logical backup and confirm the archive lists:
   `scripts/operations/backup-database.sh`.
2. Confirm the provider's PITR/backup timestamp is recent enough to cover the
   change window.
3. Record the current `SELECT version, checksum FROM kfin_migrations ORDER BY version`.
4. Apply outside user-facing peak hours; the migration holds an advisory lock and
   may take table locks.
5. Run `corepack pnpm run db:migrate` (artifact: `node apps/api/dist/migrate.bundle.mjs`)
   as `kfin_migrator`, never as `kfin_app`.

## Decision table

| Symptom | State | Action |
|---|---|---|
| A file fails; earlier files in the same run succeeded | schema is at the last successful file | fix or replace the **new** file (it was never recorded), then re-run. If the replacement changes intent, prefer a new higher-numbered file. |
| Checksum mismatch | the run aborted before executing | restore the file byte-for-byte from version control. Never edit an applied migration. |
| `kfin_operator`/`kfin_app` grant missing after a manual restore | the dump or provisioning is wrong | re-run `db:provision-roles` before serving traffic. |
| A migration committed but is wrong (bad column, bad constraint) | schema is ahead of the code | roll forward with a new migration. If data was corrupted, restore the preflight backup and redeploy the previous artifact. |
| Migration holds a lock too long | the statement timed out and rolled back | reschedule; do not raise `statement_timeout` blindly. |

## Rules that prevent the irrecoverable cases

- **Never edit an applied migration file.** The checksum guard turns a silent
  difference between environments into a failed deploy.
- **Destructive changes use expand/contract**: add the new shape, deploy code
  that writes both, backfill, then remove the old shape in a later release. A
  migration that drops a column cannot be undone without a restore.
- **Keep the previous application artifact deployable.** Rolling back code is a
  redeploy; rolling back schema is a restore.
- **A restore is a data rewind.** Everything written after the backup is lost —
  sessions, invitations, password-reset codes, transactions. Announce it.

## Evidence

`packages/database/test/migration-atomicity.integration.test.ts` creates its own
disposable database and proves, against real PostgreSQL:

1. a failing file leaves no table and no `kfin_migrations` row;
2. an earlier file stays applied when a later file fails, and only the earlier
   version is recorded;
3. editing an applied file is refused with a checksum error;
4. re-running an unchanged set applies nothing.

Executed 2026-10-17: 4/4 passed. The backup/restore path is exercised separately
by `pnpm run backup:drill` (see `BACKUP-AND-RESTORE.md`).
