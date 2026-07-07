# CAPACITY_SCALE_1K_10K.md — AtlaVue at 10× / 100×

Does AtlaVue survive the jump from the proven **100 users / 300 channels** baseline
(`ops/PERF_BASELINE.md`: 1 163 rps, p95 < 250 ms, pool max 4) to **1 000** and **10 000** users?
This is the capacity model + ranked bottleneck list + scaling plan, grounded in code and in fresh
`EXPLAIN (ANALYZE, BUFFERS)` measurements at 1 000-channel scale on the local stand.

**Headline:** the *read* path scales well — per-channel reads are index-bound and constant in N.
The walls, in order, are (1) the **nightly collector cron** (sequential + a 200-channel cap →
saturates around 1–2k tracked QR channels), (2) the **DB pool** (max 4 → raise + pooler), and
(3) `listChannels` **seq-scans `channels`** (degrades with total channel count). This PR ships the
safe, additive groundwork (rollup scaffold, load presets, env docs); the higher-blast-radius fixes
(the tenant-predicate rewrite, the cron→jobs redesign, the multi-instance cache) are specified here
as reviewed follow-ups, not bundled into a prod push.

---

## 1. Method & stand

Portable PostgreSQL 16.4 (localhost:5432), migrations 001–014 applied. Seed:
`node ops/seed-loadtest.mjs --preset load10x --wipe` → 1 000 users, 1 000 channels, **730 000**
`channel_daily`, 334 000 posts, 100 000 mentions. The channels were then canonicalized (workspace +
`external_sources` + `source_id` stamped on `channels` and `channel_daily`) to mirror the prod
Phase-B read path. `EXPLAIN (ANALYZE, BUFFERS)` was run on the hot queries exactly as `server/db.js`
emits them (including the ADR-001 `sameTenantSource` trust check from PR #56).

Measured table sizes at 1 000 channels → linear extrapolation to 10 000:

| Table | rows @1k ch | size @1k | rows @10k ch | size @10k | 3-yr @10k (no retention) |
|---|---|---|---|---|---|
| `channel_daily` | 730 000 | 183 MB | 7.3 M | ~1.8 GB | ~5.5 GB |
| `posts` | 334 000 | 82 MB | 3.3 M | ~0.8 GB | ~2.4 GB |
| `mentions` | 100 000 | 21 MB | 1.0 M | ~0.2 GB | grows with searches |

---

## 2. Capacity model — what breaks, at what N

| Subsystem | 100 (proven) | 1 000 | 10 000 | Breaks at / key assumption |
|---|---|---|---|---|
| Per-channel reads (`history`, `mentions`, `velocity`) | p95 < 250 ms | index-bound, ~2 ms/query | index-bound, ~2 ms/query | **Scales**: a read touches ≤730 daily rows for ONE channel — cost is O(days), independent of N. |
| `listChannels` (channel switcher, every load) | ~0.2 ms | ~0.6 ms | ~6–20 ms | **Seq-scans `channels`** (the `owner_uid OR workspace-EXISTS` predicate); cost O(total channels). Client-cached, so not fatal. |
| DB pool `max=4` | saturates, queues OK | queues heavily | exhausted / timeouts | ~200–500 concurrent in-flight queries. Raise `PGPOOL_MAX`; PgBouncer past the plan's connection limit × K instances. |
| `channel_daily` growth | 50 MB | 183 MB | 1.8–5.5 GB | No retention/rollup today → storage cost + slower vacuums, not query latency. |
| Nightly collector cron | fits | tight | **does not fit** | Sequential, `TG_QR_MAX_CHANNELS_PER_RUN=200`, single Telethon `Semaphore(1)`, FloodWait. ~1–2k tracked QR channels saturates the window. |
| In-process cache (`Map`, cap 500) | fine (1 instance) | fine (1 instance) | inconsistent (K>1) | Per-instance → a connect/disconnect on instance A isn't seen by B; cap 500 thrashes past 500 channel×param combos. |
| Frontend fan-out (~14 `useQuery`/view) | fine | burst on switch | thundering herd | ~14 × concurrent channel-switchers. React Query caches steady-state; the mount/switch burst is the spike. |
| MTProto central live path | serialized, cached | same | same | **Central-only** (every other tenant is collector/snapshot-served); per-viewer live calls are 10-min cached. Bounded by Telegram quota, not app N. |

---

## 3. Ranked bottlenecks (symptom → threshold → fix)

1. **Collector cron saturation — Critical (~1–2k QR channels).** `processTgQrCollection`
   (`index.js`) is sequential, capped at 200 channels/run, and every heavy Telethon call funnels
   through `Semaphore(1)`. Symptom: most tracked channels silently stop refreshing; `collector_status`
   goes stale. **Fix (follow-up):** enqueue one `jobs` row per (source, day) and drain with a small
   worker pool (per-source dedup via the existing `runJobOnce` idempotency, ADR-002); collect per
   *source* once, not per follower.
2. **DB pool exhaustion — High (~200–500 concurrent).** `max: PGPOOL_MAX||4` (`db.js:27`). Symptom:
   query queue latency spikes, then `pool` timeouts surface as 500s. **Fix (config, this PR docs it):**
   set `PGPOOL_MAX` to `min(plan_conn_limit / K_web_instances − headroom, 10–20)`; add PgBouncer
   (transaction pooling) once `K × PGPOOL_MAX` approaches the plan's connection ceiling.
3. **`listChannels` seq-scan — Medium (~10k–30k total channels).** Measured below. **Fix (follow-up,
   tenant-SQL — needs the isolation suite re-run):** split the `owner_uid OR workspace-member`
   predicate into a `UNION` of two indexed branches. No new index required.
4. **`channel_daily` growth — Medium (cost @10k).** **Fix:** the monthly rollup (shipped inert here)
   + a retention policy (e.g. keep 24 months of dailies, serve older ranges from `channel_monthly`).
5. **Multi-instance cache inconsistency — Medium (when K>1).** **Fix:** Redis (shared) or sticky
   sessions; key by `source_id` (ADR-001) so co-followers share one cached payload.
6. **Frontend waterfall — Medium (high concurrency).** **Fix:** an aggregate `/api/channel/overview`
   endpoint or stagger + longer `staleTime` on the cold widgets.
7. **`audit_events` unbounded growth — Low.** Append-only, no prune. **Fix:** retention (e.g. 180 d).
8. **`searchPosts` quota — Low.** ~10/day, on-demand (button), and per-user for QR sessions — does
   not scale with viewers.

---

## 4. Measured evidence (EXPLAIN ANALYZE, load10x)

**Q1 — `getChannelHistory` (canonical source path, 730 d): 1.8 ms.** Bitmap scans of
`channel_daily_source_day_idx` + `channel_daily_chan_day_uniq`; no seq scan. The PR #56
`sameTenantSource` trust check runs as an `channels_pkey` Index Scan **728× (one per candidate row)** —
buffer-cached (sub-2 ms) but the dominant buffer cost of the query. The rollup (§5) collapses this to
~24 monthly rows → ~24 probes.

**Q2 — `listChannels`: SEQ SCAN on `channels`, 999 rows removed to find 1.** The
`owner_uid = $1 OR (workspace_id IS NOT NULL AND EXISTS(…))` predicate can't be indexed as written.
0.6 ms at 1k channels; linear in total channels (~6 ms @10k, ~20 ms @30k), on every dashboard load.
The `UNION`-of-two-indexed-branches rewrite was measured at **0.185 ms, index-bound (no seq scan)**
using the *existing* `channels_owner_status_idx` + `channels_workspace_idx`:

```sql
SELECT … FROM channels WHERE owner_uid = $1 AND status <> 'disabled'
UNION
SELECT … FROM channels
 WHERE workspace_id IN (SELECT m.workspace_id FROM workspace_members m WHERE m.uid = $1)
   AND status <> 'disabled'
```
(The naive `owner_uid = $1 OR workspace_id IN (…)` still seq-scans — the `OR` defeats the index; only
the `UNION` splits it into two indexable probes. This is a tenant-isolation predicate → ship it in a
focused PR that re-runs `test/tenancy.integration.test.js`, not bundled with scaling groundwork.)

**Q3 — `getMentionsArchive` recent list: 0.19 ms**, `mentions_owner_idx`. No change needed.

---

## 5. Scaling plan

**Postgres.**
- Indexing is *adequate* for the hot reads (Q1/Q3 index-bound). The one gap is the `listChannels`
  predicate shape (§4 Q2) — a query rewrite, not a missing index.
- **Rollup (shipped inert):** `channel_monthly` (migration `014`) + `db.rollupChannelMonthly(months)`,
  called nightly from the persistence cron **only when `CAPACITY_ROLLUPS=1`** and de-duplicated across
  web instances by a `jobs` row (`runJobOnce`). Measured: 4 000 monthly rows for 1 000 channels in
  206 ms. Next step (separate PR): a `getChannelHistoryMonthly` reader + the frontend range-picker
  serving ≥6-month ranges from months, ≤3-month ranges from dailies.
- **Retention:** add `pruneChannelDaily(maxAgeDays≈730)` alongside the existing prunes once the
  monthly reader ships (older ranges come from `channel_monthly`).
- **Pool:** `PGPOOL_MAX` (env, `db.js:27`). Formula: `min(⌊plan_conn_limit / K_web⌋ − 2, 20)`. Add
  **PgBouncer** (transaction mode) when `K_web × PGPOOL_MAX` nears the plan ceiling. Railway private
  `DATABASE_URL` stays `ssl=false`.

**MTProto.** Central-only live path is already serialized + cached — not an N-scaling risk. The
collection *fan-out* is: move `processTgQrCollection`/`processPersistence` from a sequential
fire-and-forget tail to `jobs`-queued units (one per source×day), drained by a bounded worker pool;
keep the `Semaphore(1)` as the Telethon safety valve. Separate the **central** searchPosts quota from
**per-user** QR sessions (already the case — QR collection uses each user's own session).

**Cache.** For K>1 web instances: Redis (shared, TTL-per-key) or sticky sessions. Key by `source_id`
(not `channel.id`) so ADR-001 co-followers share one entry; raise `CACHE_MAX_ENTRIES` with real
channel×param cardinality. (Not shipped here — touches every cached route; do it with the Redis
introduction.)

**Frontend.** Add an aggregate `overview` endpoint (fold the ~6 TG widgets like `/api/tg/full`
already folds 3) or stagger the cold widgets + raise `staleTime`; `useHistory` should request months
for long ranges once the rollup reader lands.

---

## 6. What THIS PR ships (all additive, idempotent, inert-by-default)

| Change | File | Runtime impact |
|---|---|---|
| `channel_monthly` rollup table + canonical index | `server/migrations/014_capacity_rollups.sql` | Empty table; none until enabled |
| `rollupChannelMonthly(months)` | `server/db.js` | Exported; called only when enabled |
| Gated nightly rollup call | `server/index.js` (persistence cron) | **Inert unless `CAPACITY_ROLLUPS=1`**; one instance/day via `jobs` |
| `load10x` / `load100x` presets | `ops/seed-loadtest.mjs` | Test tooling only |
| This capacity model + env docs | `ops/CAPACITY_SCALE_1K_10K.md` | Docs |

**Env knobs documented:** `PGPOOL_MAX` (pool size, default 4 — raise per §5 formula);
`CAPACITY_ROLLUPS=1` (enable the nightly `channel_monthly` rollup — leave unset until a reader ships).

**Reviewed follow-ups (NOT shipped — specified above):** `listChannels` UNION rewrite (tenant SQL);
collector cron → `jobs`-queue workers; Redis / source-keyed cache; `channel_daily` retention +
monthly reader; frontend aggregate endpoint; `audit_events` retention.

---

## 7. Load-test methodology (reproducible)

```bash
# 1k-user horizon (fast: ~730k daily rows)
DATABASE_URL=… node ops/seed-loadtest.mjs --preset load10x --wipe
# 10k-user horizon (heavy: ~7.3M daily, minutes + ~3-4 GB)
DATABASE_URL=… node ops/seed-loadtest.mjs --preset load100x --wipe

# HTTP load (raise SEED_USERS/SEED_CHANNELS to match the preset's id ranges):
SESSION_SECRET=… BASE=http://localhost:3100 DATABASE_URL=… \
  node ops/load-test.mjs --users 500 --seconds 30
```

- **Reads:** the driver loops `auth/me → channels → history → snapshot`. Watch p50/p95/p99 + peak
  `pg_stat_activity` backends; raise `--users` until errors appear (the per-uid rate limiter is the
  first, intentional ceiling — seed enough accounts first).
- **Ingest storm:** fire K collector POSTs concurrently at `/api/collector/ingest` with distinct
  `ingest_id`s (idempotency + `payload_hash` verified in `contract.js`; the ingest limiter is
  60/15 min per key). Confirm the pool doesn't starve live readers — this is the pool-sizing test.
- **MTProto / cron:** analytical (Telegram quota + the 200-cap + `Semaphore(1)`), per §3.

Thresholds above are reproducible on the stand; re-run after any change to the hot queries or pool.
