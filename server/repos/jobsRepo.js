'use strict';

/* ── Background job idempotency (012_jobs.sql, roadmap P0) ────────────────────────────────────
   One row per logical unit of work, keyed (kind, idempotency_key) — e.g.
   ('report_email', 'report:7:2026-W27'). claimJob is the single atomic gate:
     • fresh key            → row created as running, returned (caller does the work);
     • queued / failed      → re-claimed (attempts++), returned (retry);
     • running, lease dead  → re-claimed (crashed runner), returned;
     • running, lease alive → null (someone else is on it — skip);
     • succeeded            → null + cached result via getJob (duplicate enqueue collapses).
   completeJob/failJob close the claim. Callers that need the cached outcome of a skipped
   duplicate read getJob(kind, key).result.

   Extracted from db.js as the first repo of the P2 db decomposition (stage 5). The public API
   (db.claimJob / completeJob / failJob / getJob / runJobOnce) is unchanged — db.js spreads this
   repo's returned methods into its exports. Depends only on the shared pool + enabled flag. */
const JOB_LEASE_SECONDS = 15 * 60;

function createJobsRepo({ pool, enabled }) {
  async function claimJob(kind, idempotencyKey, { leaseSeconds = JOB_LEASE_SECONDS, payload = null } = {}) {
    if (!enabled || !kind || !idempotencyKey) return null;
    const { rows } = await pool.query(
      `INSERT INTO jobs (kind, idempotency_key, status, attempts, locked_until, payload)
       VALUES ($1, $2, 'running', 1, now() + make_interval(secs => $3), $4)
       ON CONFLICT (kind, idempotency_key) DO UPDATE SET
         status = 'running',
         attempts = jobs.attempts + 1,
         locked_until = now() + make_interval(secs => $3),
         updated_at = now()
       WHERE jobs.status IN ('queued', 'failed')
          OR (jobs.status = 'running' AND jobs.locked_until < now())
       RETURNING *`,
      [kind, idempotencyKey, leaseSeconds, payload ? JSON.stringify(payload) : null]);
    return rows[0] || null;
  }

  async function completeJob(id, result = null) {
    if (!enabled || !id) return;
    await pool.query(
      `UPDATE jobs SET status='succeeded', result=$2, error=NULL, locked_until=NULL, updated_at=now() WHERE id=$1`,
      [id, result ? JSON.stringify(result) : null]);
  }

  async function failJob(id, error) {
    if (!enabled || !id) return;
    await pool.query(
      `UPDATE jobs SET status='failed', error=$2, locked_until=NULL, updated_at=now() WHERE id=$1`,
      [id, String(error && error.message ? error.message : error).slice(0, 2000)]);
  }

  async function getJob(kind, idempotencyKey) {
    if (!enabled || !kind || !idempotencyKey) return null;
    const { rows } = await pool.query(
      `SELECT * FROM jobs WHERE kind=$1 AND idempotency_key=$2`, [kind, idempotencyKey]);
    return rows[0] || null;
  }

  /** Run `fn` exactly once per (kind, key): claims, executes, records success/failure. A concurrent
   *  or already-succeeded duplicate resolves to { skipped: true, job } without running `fn`. */
  async function runJobOnce(kind, idempotencyKey, fn, opts) {
    const job = await claimJob(kind, idempotencyKey, opts);
    if (!job) return { skipped: true, job: await getJob(kind, idempotencyKey) };
    try {
      const result = await fn();
      await completeJob(job.id, result ?? null);
      return { skipped: false, result };
    } catch (e) {
      await failJob(job.id, e);
      throw e;
    }
  }

  return { claimJob, completeJob, failJob, getJob, runJobOnce };
}

module.exports = { createJobsRepo };
