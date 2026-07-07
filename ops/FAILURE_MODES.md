# FAILURE_MODES.md — Operation «Ковчег»

Does AtlaVue survive failure and scale operationally? This is the failure-mode matrix + the
idempotency/invariant proof, grounded in a verified restore drill and a green test suite. Companion
to `ops/BACKUP_RESTORE.md` (DR runbook + drill §7). Baseline: `origin/main` @ `8bc4b79`.

**Verdict:** the platform degrades gracefully across every failure boundary. The one real gap —
the **daily-ingest cron was not idempotent** (a double tick / second web instance ran the heavy
MTProto pass twice with racing upserts) — is fixed in this PR (`runJobOnce('daily_ingest',
'central:<date>')` + a single-transaction `persistCentralDaily`). Everything else is resilient.

---

## 1. Failure-mode matrix

| Failure | Expected | Actual behaviour (code) | HTTP | UI | Gap → fix |
|---|---|---|---|---|---|
| **MTProto down** | serve DB, mark not-live | `mtprotoFetch` maps 429→503 w/ `retry_after`; non-central routes serve the Postgres snapshot; central live routes → `{available:false}` | 503 (central live) / 200 snapshot | "источник недоступен" / cached data | none — graceful |
| **Postgres down @ boot** | app still serves, data gated | `db.init()` rejects → `dbReady=false`; data routes 503 "Сервис запускается"; `app.listen` still runs (SPA served) | 503 on `/api/*` data | app shell loads, retries | none |
| **Postgres down @ runtime** | fail fast, don't crash | `pool.on('error')` logs, never `process.exit`; queries throw → `asyncHandler`→ terminal 500 (generic) or route catch → 503; `/api/ready` → 503 | 500/503 | error card, retry | minor: some routes 500 vs 503 (see §3) |
| **No DB (soft-off)** | full degrade, no errors | `db.enabled=false` → history `[]`, reports 503, channels = synthetic central id 0, prefs → localStorage | 200 (degraded) / 503 reports | works read-only | by design |
| **Collector stale** | show staleness, keep data | `getCollectorStatus` computes `stale` (>`COLLECTOR_STALE_HOURS`, def 24h); last snapshot still served | 200 + `stale:true` | stale badge | none |
| **Cron double-fire** | run heavy pass once/day | **was:** two `/graphs`+`/posts`+velocity passes + racing upserts. **now:** `runJobOnce('daily_ingest','central:<UTC-date>')` → one caller works, duplicate returns cached result + skips the tails | 200 `{skipped:true}` on dup | unchanged | **FIXED (this PR)** |
| **Migration halt** | no partial schema, prev deploy stays | failing `*.sql` → `ROLLBACK` its own tx + throw → `npm start` aborts before `app.listen`; Railway keeps the previous deploy; advisory lock serializes instances | n/a (deploy fails) | prev version serves | none — atomic per-file |
| **Postgres lost (DR)** | restore w/ correct data | `db-restore.mjs`: TRUNCATE→insert (FK order)→**reset sequences**, one tx; drill verified §2 | n/a | — | none — sequences reset, no PK dup |
| **Concurrent collector ingest** | idempotent, no deadlock | `ingestCollectorPayload` transactional + `ingest_id`/`payload_hash` receipt; `setChannelTgId`/`ensureChannelCanonical` ride the caller's executor (no self-deadlock — tested) | 202 / 200 dup / 409 conflict | — | none |

---

## 2. DR restore drill (verified)

Ran the full cycle on the portable PG 16.4 stand (schema 001–014, `drill` preset: 3 users / 5
channels / 90d / 500 posts), logged in `ops/BACKUP_RESTORE.md §7`:

`seed → snapshot → mutate (insert junk channel + delete 90 daily rows) → restore --yes → verify`.

- **RTO ≈ 1.4 s** at drill scale (driver-based row-by-row; use `pg_restore` past ~1–2M rows, §5).
- **Verify passed** — every table's row count matched the manifest; newest-day freshness preserved
  (channel_daily latest `2026-07-04`, posts `2026-07-03`).
- **Restore fidelity** — post-snapshot junk channel gone (TRUNCATE), the 90 deleted daily rows back.
- **Sequences reset** (the card's PK-dup concern — confirmed NOT a gap): after restore a fresh
  app-path insert got `channels.id=5005` (restored max 5004) and `users.id=1003` (restored max 1002)
  — no collision. `db-restore.mjs` resets every `nextval`-defaulted serial to `MAX(col)+1`.
- **RPO** = the snapshot interval. The JSONL snapshot is point-in-time modulo concurrent writes
  (the reader pages with OFFSET, doesn't lock — take snapshots at low traffic, §BACKUP_RESTORE 2).
  On Railway, enable PITR on the paid plan (§BACKUP_RESTORE 6) as the primary RPO control; the repo
  scripts are the owned offline copy.

---

## 3. Idempotency & invariant proof (test suite → `npm run check` + stand)

| Property | Where | Test |
|---|---|---|
| daily-ingest runs once per UTC date | `index.js` + `runJobOnce` | `ark.integration` «daily_ingest idempotent» |
| central daily bundle is atomic + no double-count | `db.persistCentralDaily` | `ark.integration` «persistCentralDaily …» |
| collector ingest: same id+hash→cached, diff hash→409 | `ingestCollectorPayload` | `ark.integration` «ingestCollectorPayload …» |
| migrations idempotent + forward-only | `migrations.js` | `ark.integration` «migrations idempotent» |
| `views_graph` is incremental, not cumulative; transform idempotent | `graphsToDailyRows` | `db.test.js` «инкрементальный, не кумулятив» |
| album `grouped_id` collapse; MAX views not SUM (no double-count) | `service._logical_posts`/`_build_post` | `test_invariants.py` |
| collector SQLite queue: retry / dead-letter / restart-survival | `pulse_collector.py` | `test_collector.py` (pre-existing) |

The DB-dependent tests (`ark.integration`) follow the repo contour — they SKIP without
`TEST_DATABASE_URL` (CI stays DB-less) and run on the local stand:
`TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test`.

---

## 4. Residual items (accepted risk / follow-up)

- **Runtime-Postgres HTTP code**: a few routes surface a generic 500 (not 503) when the pool is
  exhausted mid-request. Accepted — the client retries either way; a uniform 503 mapper is a small
  follow-up. `/api/ready` already reports 503 for monitoring.
- **`INGEST_TOKEN` query fallback** (`?token=`) — Low, from the security audit (S2): recommend
  removing once no external cron uses it (the workflow already sends the header).
- **Fire-and-forget tails** (`processPersistence` IG collection, `processTgQrCollection`) skip on a
  duplicate day but are not themselves `runJobOnce`-guarded across instances — safe (idempotent
  upserts), but their per-source dedup is the capacity follow-up (`ops/CAPACITY_SCALE_1K_10K.md`).
- **Native DR at scale**: past ~1–2M rows switch the drill to `pg_dump -Fc` / `pg_restore`
  (`ops/BACKUP_RESTORE.md §5`); re-measure RTO there before relying on it for prod-size data.
