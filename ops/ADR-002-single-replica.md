# ADR-002 — Single web replica (until shared state)

Status: **accepted** (2026-07-08, autonomous per owner's go-ahead; data = test accounts only).
Companion to the capacity model in [CAPACITY_SCALE_1K_10K.md](CAPACITY_SCALE_1K_10K.md) — that doc
sizes the bottlenecks; this one records the *decision* they force and the tripwire that guards it.

## Context

The web tier (`server/index.js`) keeps three kinds of state **in-process**. They are correctness- or
quota-relevant, and none is shared across instances:

| In-process state | Where | What breaks at K>1 replicas |
|---|---|---|
| Response cache (`Map`, TTL 10 min, cap 500) | `index.js` `cache`/`cacheGet`/`cacheSet` | Each replica has its own copy → a connect/disconnect seen by A is stale on B; **cache miss rate ×K → Graph/MTProto/`searchPosts` quota burn ×K** (the ~10/day mentions quota is the sharp edge). |
| IG singleflight (`Map`) | `index.js` `igInflight` | Dedup is per-replica → concurrent identical Graph calls collapse to one *per replica*, not globally. |
| Rate limiters ×4 (`express-rate-limit` MemoryStore) | `limiter` / `authLimiter` / `mediaLimiter` / `crashLimiter` | Per-uid counters live in one instance's memory → a user's effective limit is **×K** (auth brute-force / abuse protection weakens linearly with replicas). |

**What is already cross-instance safe** (so scaling would degrade, not corrupt):

- **Migrations** — `migrations.js` wraps the run in `pg_advisory_lock` → two booting instances serialize.
- **Daily ingest + report email + monthly rollup** — all go through `db.runJobOnce(kind, key, …)`,
  a Postgres-backed jobs table (migration `012_jobs.sql`) → exactly one instance does the work per key,
  regardless of replica count. The heavy MTProto pass never doubles.
- **Auth** — stateless HMAC tokens; no server session store to share.
- **All tenant reads/writes** — keyed by `channel_id`/`source_id` in Postgres, not memory.

So the correctness-critical paths are DB-coordinated. The instance-local state is the *optimization*
layer (cache, singleflight) and the *protection* layer (rate limits). That is the whole reason this is
a "pin to 1 replica" decision and not a "we must build Redis now" emergency.

## Decision

**Run exactly one web replica** until the shared-state prerequisites below exist. Do not raise
Railway's replica count for the `web` service.

**Guardrail (tripwire).** Railway does not expose the replica count to the app, so the operator
declares it: env var `WEB_REPLICAS` (default `1`). On boot, `WEB_REPLICAS > 1` emits
`log('error', 'multi_replica_unsupported', …)` — a loud, greppable line that turns a silent slider
bump into a visible error. It is advisory (does not block boot) by design: the day we DO run K>1
intentionally, we'll have flipped the state to shared and can drop the guard in the same change.

## Prerequisites to lift this (exit criteria)

1. **Shared cache** — move the response cache to Redis, keyed by `source_id` (ADR-001) so
   co-followers of the same external property share one cached payload. (CAPACITY §"Multi-instance
   cache inconsistency — Medium (K>1)".)
2. **Store-backed rate limit** — `express-rate-limit` with a Redis store (or a gateway-level limiter)
   so per-uid counters are global.
3. **Connection budget** — set `PGPOOL_MAX` to `plan_conn_limit / K − headroom` and front Postgres
   with PgBouncer past the plan's connection limit (CAPACITY row "DB pool `max=4`").

igInflight can stay per-replica (a shared cache makes its marginal value small).

## Observability note (ingest silent-death — see FAILURE_MODES "Ingest degraded")

The daily-ingest cron is the one scheduled job outside the app. Two silent-death vectors:

- **Upstream down at cron time** — `/graphs`→null → `channel_daily=0` → previously `{ok:true}`/200 →
  green cron while the archive stops growing. **Fixed:** the endpoint now returns `degraded:true` and
  `.github/workflows/ingest.yml` greps the flag and fails the job → GitHub's native workflow-failure
  email is the proactive alert.
- **Schedule disabled** — GitHub auto-disables `schedule:` workflows after **60 days of repo
  inactivity**. Not fixable in code; mitigations: repo activity keeps it live, `workflow_dispatch`
  allows a manual kick, and DataHealth surfaces `stale ≥ 2d` in-app. If ingest ever moves off GitHub
  Actions (a Railway cron / the `jobs` queue), this vector disappears — tracked with the
  cron→jobs-queue follow-up.

## Consequences

- One replica is a **capacity ceiling, not a correctness risk**: reads are index-bound and the process
  is CPU-light; the ceiling is concurrent connections + the DB pool, addressed by the prerequisites
  before it bites (CAPACITY: read path scales to 10×–100× on a single instance).
- **No availability from redundancy** while at K=1: a deploy or crash is a brief blip. Acceptable at
  current scale (Railway redeploy ≈ tens of seconds; DR drill in BACKUP_RESTORE.md covers data loss).
- The guardrail makes the constraint **discoverable at boot** instead of tribal knowledge.
