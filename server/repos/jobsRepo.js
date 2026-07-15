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

// Ретеншн терминальных строк (см. pruneTerminalJobs). Консервативные дефолты: жизнь строки после
// её терминального перехода (updated_at), размер одного батча и сколько батчей за прогон.
const JOBS_RETENTION_DAYS_DEFAULT = 30;
const JOBS_PRUNE_BATCH_DEFAULT = 500;
const JOBS_PRUNE_MAX_BATCHES_DEFAULT = 40;   // ≤ 20k строк/прогон/таблица — остаток добирают следующие прогоны
const clampInt = (v, def, min, max) =>
  Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : def;

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

  /* ── Retention: терминальные строки (succeeded/failed) ────────────────────────────────────────
     Таблица jobs — append-only ledger идемпотентности: одна строка на (kind, idempotency_key), и
     все реальные ключи содержат календарный день/период (`central:2026-07-11`, `report:7:2026-W27`,
     `${ch.id}:${day}`, `${ch}:${ig}:${day}`, `channel_monthly:2026-07-11`). ЗАЧЕМ безопасно удалять
     старые терминальные строки:
       • succeeded → claimJob НЕ переклеймливает её (ON CONFLICT WHERE status IN ('queued','failed')
         OR протухший running); кэш результата читается getJob'ом только тем же period-scoped
         вызовом. У report_email есть отдельная durable reservation на period, поэтому удаление
         ledger-строки не открывает повторную отправку даже на границе длинного месяца.
       • failed → означает незавершённую работу; если тот же period-scoped ключ когда-либо будет
         заявлен снова, свежая строка корректно разрешит повтор, а не потеряет выполненный результат.
     Поэтому режем лишь status IN ('succeeded','failed') с updated_at (момент терминального перехода:
     completeJob/failJob ставят now()) старше горизонта. queued/running НЕ трогаем НИКОГДА — даже
     running с протухшим lease (его добирает re-claim, а не ретеншн). Батчи маленькие и упорядочены
     по (updated_at, id) — детерминированно и дружелюбно к частичному индексу; `SKIP LOCKED`
     не даёт maintenance ждать за конкурентным claim, занятую строку доберёт следующий прогон.
     jobs_terminal_prune_idx (021). Повторяемо/идемпотентно: capped-остаток добирает следующий
     прогон. Возвращает структурные счётчики { deleted, batches, capped }. */
  async function pruneTerminalJobs({
    maxAgeDays = JOBS_RETENTION_DAYS_DEFAULT,
    batchSize = JOBS_PRUNE_BATCH_DEFAULT,
    maxBatches = JOBS_PRUNE_MAX_BATCHES_DEFAULT,
  } = {}) {
    if (!enabled) return { deleted: 0, batches: 0, capped: false };
    const days = clampInt(maxAgeDays, JOBS_RETENTION_DAYS_DEFAULT, 1, 3650);
    const limit = clampInt(batchSize, JOBS_PRUNE_BATCH_DEFAULT, 1, 10000);
    const caps = clampInt(maxBatches, JOBS_PRUNE_MAX_BATCHES_DEFAULT, 1, 1000);
    let deleted = 0;
    let batches = 0;
    let capped = false;
    for (;;) {
      if (batches >= caps) { capped = true; break; }
      const { rowCount } = await pool.query(
        `DELETE FROM jobs
          WHERE id IN (
           SELECT id FROM jobs
            WHERE status IN ('succeeded', 'failed')
              AND updated_at < now() - make_interval(days => $1)
            ORDER BY updated_at, id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
            -- Defense in depth: re-check the mutable predicate on the DELETE target as well as in
            -- the locked selector, so a future query refactor cannot turn an id-only match into a
            -- deletion of fresh running work.
            AND status IN ('succeeded', 'failed')
            AND updated_at < now() - make_interval(days => $1)`,
        [days, limit]);
      batches += 1;
      deleted += rowCount;
      if (rowCount < limit) break;   // хвост исчерпан
    }
    return { deleted, batches, capped };
  }

  return { claimJob, completeJob, failJob, getJob, runJobOnce, pruneTerminalJobs };
}

module.exports = { createJobsRepo };
