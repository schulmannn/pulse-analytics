# Capacity baseline — 100 concurrent users (2026-07-04)

Roadmap P0 «Capacity baseline: 100 concurrent users smoke/load test». Method, numbers and the
bottleneck list. Re-run anytime with the commands below — everything is in-repo and deterministic.

## Stand

- Portable PostgreSQL 16.4 (localhost:54329), repo migrations 001-012 applied.
- Seed: `node ops/seed-loadtest.mjs --preset load --wipe` → 100 users, 300 collector channels
  (canonical sources), **219 000** `channel_daily` rows (730d × 300), **100 200** posts, mentions,
  prefs, reports, per-channel snapshots.
- Server: the real `server/index.js` (`SESSION_SECRET` known → tokens minted per virtual user),
  DB pool default `max=4`.
- Driver: `ops/load-test.mjs` — N virtual users, EACH with their own token (the general rate
  limiter keys per uid; a single-token blaster would measure the limiter, not the app) and their
  own channel, looping a realistic session: `auth/me → channels → history(400d) → tg/channel
  (snapshot) → [10%] PUT prefs`.

```bash
SESSION_SECRET=… BASE=http://localhost:3100 DATABASE_URL=… node ops/load-test.mjs --users 100 --seconds 30
```

## Results — 100 users × 30 s (target load)

| endpoint | n | p50 ms | p95 ms | p99 ms | errors |
|---|---|---|---|---|---|
| auth/me | 8 598 | 48 | 73 | 136 | 0 |
| channels (+memberCount subquery) | 8 598 | 53 | 83 | 118 | 0 |
| history 400d (canonical DISTINCT ON) | 8 598 | 120 | 162 | 222 | 0 |
| tg/channel (collector snapshot) | 8 598 | 114 | 160 | 228 | 0 |
| prefs PUT | 730 | 58 | 123 | 145 | 0 |

**1 163 rps sustained, 0 errors, 8 598 full sessions.** Peak active DB backends: 5
(= pool max 4 + the sampler) — the pool saturates but queues gracefully; no timeouts.

## Results — 200 users × 20 s (overload probe)

1 543 rps; ~21% requests rejected. The rejections are the **general per-uid rate limiter** — with
only 100 seed accounts, 200 virtual users double up on uids and trip it (working as designed: the
limiter is the first, intentional ceiling; the DB stayed at 5 active backends, non-error p95
≈ 320 ms). A true 200-account run needs `--preset` scaled up first.

## Bottleneck list → mitigation

1. **DB pool `max=4`** — saturated at 100 users (the queue absorbs it today). Now env-tunable:
   `PGPOOL_MAX` (raise to 8-10 on Railway once real concurrency approaches 50+; watch the plan's
   connection limit).
2. **`history 400d` and `snapshot` are the heavy reads** (~120 ms p50: payload size + DISTINCT ON
   over 730 rows). Fine at this scale; the «Materialized daily aggregates» roadmap card is the
   long-term answer, `days=` clamping the short-term one if payloads grow.
3. **Per-uid rate limiter is the first ceiling under burst** — correct behaviour for one user
   hammering, but the team-workspace policy card («Rate-limit and quota policy for teams») stays
   relevant: workspace-level budgets for expensive source refreshes.
4. **Unmeasured here**: Railway network/edge, MTProto/Graph fan-out endpoints (the stand serves
   the collector-snapshot path instead — the central channel's live MTProto path is bounded by
   Telegram quotas, not app capacity, and is already serialized), email sending.

## Verdict

The current architecture clears the 100-concurrent-users bar on commodity hardware with 5×
headroom on latency budgets (p95 < 250 ms everywhere) and zero errors. First knobs when real
load arrives: `PGPOOL_MAX`, then materialized aggregates for the history-heavy widgets.

## Concurrency / idempotency (Operation «Ковчег», 2026-07-07)

Under concurrent writes the correctness guarantees (not just latency) hold, verified by
`test/ark.integration.test.js` on the stand:

- **daily-ingest is single-run per UTC date** — `runJobOnce('daily_ingest','central:<date>')`, so a
  double cron tick or a second web instance no longer doubles the heavy MTProto pass; a duplicate
  returns the first run's cached result. The three central upserts commit as one transaction
  (`persistCentralDaily`) — no half-written day.
- **No self-deadlock on the small pool** — `setChannelTgId`/`ensureChannelCanonical` ride the
  caller's transaction executor (a `pool.query` inside an open tx would block on the tx's own row
  lock forever with `max=4`). Regression: tenancy suite «setChannelTgId INSIDE a transaction».
- **No double-count under retry** — every ingest upsert is `ON CONFLICT DO UPDATE`, so re-delivering
  a day overwrites rather than accumulates. See `ops/FAILURE_MODES.md §3` for the full matrix.
