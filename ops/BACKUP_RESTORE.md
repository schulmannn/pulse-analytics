# Backup / Restore / Migration-Rollback Runbook

Owner: schulmannn. Applies to the Railway Postgres behind atlavue.app and to local stands.
Scripts live next to this file and use the repo's own `pg` driver — no external tooling needed.

## 1. When to take a backup (non-negotiable)

- **Before every migration deploy** (any commit touching `server/migrations/`). The runner applies
  forward-only on boot; there is no down-migration path — the rollback IS the backup.
- Before bulk data operations (imports, recalculations, manual SQL).
- On a schedule once real users exist (see §6).

## 2. Taking a snapshot

```bash
# DATABASE_URL: Railway → Postgres service → Variables → DATABASE_PUBLIC_URL (the public one —
# the .railway.internal URL is only reachable from inside the project).
DATABASE_URL='postgres://…' node ops/db-snapshot.mjs            # → ops/snapshots/<timestamp>/
DATABASE_URL='postgres://…' node ops/db-snapshot.mjs my-dir     # explicit output dir
```

Output: one JSONL per table + `manifest.json` (row counts, taken_at). `bytea` columns (bug
screenshots) are base64-wrapped; everything else round-trips as JSON. Take snapshots during low
traffic — the reader pages with OFFSET and does not lock, so concurrent writes can skew counts.

Snapshot dirs are git-ignored (`ops/snapshots/`); park important ones somewhere durable.

## 3. Restoring

```bash
# 1) Make sure the target schema is at least at the snapshot's migration level:
DATABASE_URL='postgres://…' node server/migrate.js
# 2) Restore (TRUNCATEs every table, re-inserts, resets sequences; one transaction — all or nothing):
DATABASE_URL='postgres://…' node ops/db-restore.mjs ops/snapshots/<timestamp>        # 5s abort window
DATABASE_URL='postgres://…' node ops/db-restore.mjs ops/snapshots/<timestamp> --yes  # scripted
# 3) Verify (row counts vs manifest + newest data day per time-series table):
DATABASE_URL='postgres://…' node ops/db-verify.mjs ops/snapshots/<timestamp>
```

The restore refuses to run when the target schema is MISSING migrations the snapshot had
(restoring newer data onto older code is undefined behaviour). Restoring an OLDER snapshot onto a
newer schema is fine when the newer migrations are additive (our convention below).

## 4. Migration rollback plan

Migrations are forward-only (sequential SQL in `server/migrations/`, tracked in
`schema_migrations`, applied on every boot under an advisory lock; a failing migration rolls back
its own transaction and **halts startup** — Railway keeps serving the previous deploy).

Rollback of a DEPLOYED bad migration:

1. `git revert` the commit that added the migration (do NOT edit an applied file — versions are
   tracked by name) and push. If the bad migration only ADDED things (tables/columns/indexes), the
   revert is enough: old code ignores the new objects. Clean the orphaned objects with a follow-up
   migration when convenient.
2. If the migration REWROTE data (backfills, splits): restore the pre-deploy snapshot from §3 on
   top of the reverted code, then `DELETE FROM schema_migrations WHERE version='<bad version>'`.
3. Post-restore: run `node ops/db-verify.mjs <snapshot>` and hit `GET /api/ready`.

Conventions that keep rollbacks cheap (enforced in review):

- **Additive first**: new columns are nullable (or defaulted), new tables standalone; code reads
  tolerantly for one deploy before anything is dropped.
- **Destructive later**: DROP/NOT NULL tightening ships in a separate migration at least one
  deploy after the code stopped using the old shape.
- Every migration is transactional (the runner wraps files) — no `CREATE INDEX CONCURRENTLY`
  in the same file as other statements.

## 5. Scale note (when JSONL stops being enough)

The driver-based snapshot is exact but row-by-row. Beyond ~1-2M rows switch to the native tools —
portable binaries work without installation:

```bash
# once: download + unzip https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip
pgsql/bin/pg_dump.exe  "$DATABASE_URL" -Fc -f pulse.dump      # compressed custom format
pgsql/bin/pg_restore.exe -d "$DATABASE_URL" --clean --if-exists pulse.dump
```

## 6. Railway-side safety nets

- Railway Postgres supports point-in-time restore / backups on paid plans — check
  Project → Postgres → Backups and turn on the schedule when real users arrive; the scripts here
  complement (offline copy you own), not replace it.
- `GET /api/ready` is the post-restore smoke: checks DB connectivity + auth config.

## 7. Drill log

| date | what | result |
|------|------|--------|
| 2026-07-04 | Full cycle on a local stand (portable PG 16.4, seeded schema): snapshot → wipe → migrate → restore → verify | see PERF_BASELINE.md / tracker |
