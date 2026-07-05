# Incident Runbook

Operational playbook for Atlavue incidents: upstream API outage, degraded database, stuck
collector jobs, and partial dashboard data.

Owner: product/operator on call. Technical backup: whoever last touched `server/`, `collector/`,
or Railway configuration. Update this runbook after every incident review.

## Severity

| Severity | User impact | Examples | Target response |
| --- | --- | --- | --- |
| SEV1 | Product unavailable or data loss risk | app returns 5xx for most users, DB migration failed, bad deploy corrupts writes | start immediately, mitigate first |
| SEV2 | Core analytics degraded | source sync stuck, dashboards show stale/partial data, reports cannot load | start within 30 min |
| SEV3 | Limited or cosmetic impact | one provider delayed, export degraded, non-critical admin tool broken | schedule same day |

## First 5 Minutes

1. Confirm scope:
   - `GET https://atlavue.app/api/health`
   - `GET https://atlavue.app/api/ready`
   - open Railway logs for web, mtproto, collector if applicable.
2. Capture one failing request:
   - URL/route, timestamp, status, `X-Request-Id`, user/source if known.
   - Search logs by `request_id`; server logs emit JSON `http_request` rows.
3. Decide severity and owner.
4. Mitigate before deep debugging:
   - rollback bad deploy, pause noisy jobs, disable a broken upstream path, or show stale data.
5. Leave a short status note in the task/incident channel.

## Signals And Dashboards

Minimum checks available today:

- `/api/health`: process up, cache size, auth config, `database_ready`.
- `/api/ready`: DB connectivity and readiness.
- Railway service logs: JSON rows from `server/lib/observability.js`.
- Railway deploy history: identify the last commit deployed to `main`.
- Postgres service metrics: connection count, CPU, memory, storage, slow queries if available.
- GitHub Actions `ingest.yml`: central daily ingest failures.
- UI symptoms: empty widgets, stale timestamps, partial errors in cards/reports.

Useful log patterns:

- `http_request` with `status >= 500`.
- `readiness_failed`.
- `report_schedule_failed`, `report_email_failed`.
- `ingest_token_in_query_deprecated` is not an incident by itself, but marks old cron behavior.
- Upstream error messages mentioning Telegram, Graph, MTProto, timeout, rate limit, or ECONN.

## Scenario: Upstream API Outage

Symptoms:

- TG/IG endpoints return 502/503 or time out.
- `/api/ready` is healthy, but analytics routes fail.
- Cards show partial data, empty states, or stale values.
- Logs mention Telegram API, Graph API, MTProto, timeout, rate limit, or fetch failure.

Likely owner:

- Web/API owner if failure is in `server/index.js`.
- MTProto service owner if only `/api/tg/mtproto/*` fails.
- Collector owner if source snapshots stop updating.

Triage:

1. Check whether `/api/ready` is healthy. If not, follow DB degraded first.
2. Compare provider-specific endpoints:
   - TG central/live: `/api/tg/mtproto/health`, `/api/tg/full`.
   - IG: `/api/ig/profile`, `/api/ig/history` for an affected source.
3. Look for provider errors and rate-limit messages in logs.
4. Check whether cached/snapshot data is still available for collector channels.

Mitigation:

- Prefer stale-but-labeled data over blank dashboards.
- Avoid retry storms; do not repeatedly clear cache if upstream is rate-limited.
- If one provider is down, keep unrelated providers/routes serving.
- If a route fans out to multiple upstream calls, return partial data with an `errors` object where the code already supports it.
- For repeated upstream failure, reduce polling/refresh frequency until the provider recovers.

User-facing copy:

> Some source data is delayed because the upstream provider is not responding reliably. Existing historical data remains available; new metrics may update late. We are monitoring the provider and will resume normal sync automatically.

## Scenario: Database Degraded

Symptoms:

- `/api/ready` returns `503` or `status:not_ready`.
- Many routes return 500/503.
- Railway Postgres metrics show high CPU, storage pressure, connection saturation, or restarts.
- Logs show `readiness_failed`, `ECONN`, pool timeout, migration failure, or slow requests.

Likely owner:

- Backend/database owner.

Triage:

1. Check Railway Postgres health and recent deploys.
2. Confirm whether a migration just deployed.
3. Check pool pressure against `PGPOOL_MAX` and plan connection limit.
4. Identify the hottest route from `http_request.duration_ms`.
5. If data corruption or destructive migration is suspected, stop writes before experimenting.

Mitigation:

- Bad deploy or migration: revert the commit and push to `main`.
- Bad data migration: follow `ops/BACKUP_RESTORE.md`.
- Connection saturation: temporarily raise `PGPOOL_MAX` only if the Railway plan allows it.
- Heavy read route: lower client refresh, temporarily disable the expensive view, or serve cached/snapshot data.
- Storage pressure: stop ingest jobs, snapshot, then prune only with a reviewed SQL plan.

User-facing copy:

> Atlavue is temporarily slower because the database is under load. Your saved dashboards and reports are safe. We are reducing background work and restoring normal response times.

## Scenario: Collector Jobs Stuck

Symptoms:

- Dashboards load, but data freshness does not advance.
- Source/card status remains stale or failed.
- `collector_status.last_attempt_at` or `last_success_at` is old.
- Ingest endpoints have no recent successful receipts.
- GitHub Actions central ingest or external collector processes show failures.

Likely owner:

- Collector/source sync owner.

Triage:

1. Identify affected source/channel ids.
2. Check the latest collector status in DB or UI.
3. Check logs for `/api/ingest/daily` and collector API-key auth failures.
4. Confirm whether upstream provider is down. If yes, use upstream outage path.
5. Confirm whether DB writes are healthy. If no, use DB degraded path.

Mitigation:

- Restart the stuck collector process/service.
- Re-run the failed job only once after fixing the root cause.
- If an API key was revoked/expired, create a replacement through the channel admin flow.
- If job dedupe has a bad stuck row, inspect `jobs` before changing it; prefer natural lease expiry unless SEV1.
- Suppress noisy alerts during known upstream outages.

User-facing copy:

> Data collection for this source is delayed. Existing metrics are still visible, but the newest posts or daily totals may be missing until the collector catches up.

## Scenario: Dashboard Shows Partial Data

Symptoms:

- Some cards render, others show `0`, a dash placeholder, no comparison, or empty states.
- Reports/export disagree with dashboard.
- One source is affected, other sources are normal.
- Logs may be clean because the issue is missing history/coverage rather than a crash.

Likely owner:

- Data-quality owner for missing/stale/capped data.
- Frontend owner if UI turns known partial data into a misleading blank.

Triage:

1. Identify whether the problem is one metric, one source, or all dashboards.
2. Check source freshness and sample size.
3. Compare current window with previous period coverage.
4. Check if the metric resolver intentionally suppresses comparison for incomplete data.
5. Confirm timezone/date boundary if the issue is around today/yesterday/week/month.

Mitigation:

- Prefer explicit partial-data copy over silent zeroes.
- Disable misleading comparison when baseline coverage is too low.
- Backfill only after confirming source identity and retention expectations.
- If the UI is misleading but data is intact, ship copy/state fix before data rewrite.

User-facing copy:

> This dashboard has partial data for the selected period. Some comparisons are hidden until enough history is collected, so totals may change after the next sync.

## Customer Update Cadence

- SEV1: first update within 15 minutes, then every 30 minutes.
- SEV2: first update within 60 minutes, then when status changes.
- SEV3: update in release notes or support reply.

Template:

> We are investigating delayed/partial analytics for [provider/source]. Existing saved data is safe. Next update: [time].

Resolution copy:

> The issue is resolved. Data sync has resumed; some sources may take one more collection cycle to fully catch up.

## Postmortem Template

Use this for SEV1/SEV2, and for repeated SEV3.

```md
# Incident: <short title>

Date/time:
Severity:
Owner:
Related deploy/commit:
Affected users/sources:

## Summary

What happened, in two or three sentences.

## Timeline

- HH:MM detected by ...
- HH:MM mitigation started ...
- HH:MM user impact ended ...
- HH:MM full recovery confirmed ...

## Root Cause

The technical cause and why existing safeguards did not prevent it.

## Impact

Routes, providers, sources, reports, or user workflows affected.

## Mitigation

What was done to stop user impact.

## Follow-Ups

- [ ] Prevent recurrence
- [ ] Improve detection
- [ ] Improve user-facing state/copy
- [ ] Update runbook/tests

## What Went Well

## What Was Confusing
```

## Follow-Up Checklist

- Add or adjust an alert for the signal that would have caught this earlier.
- Add a regression test if a route returned the wrong status/shape.
- Update user-facing copy if users saw a blank, zero, or misleading state.
- Link the fixing commit and incident notes from the Notion task.
