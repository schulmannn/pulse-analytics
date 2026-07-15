'use strict';

/**
 * Named reports — per-user composition of dashboard blocks + email schedule (repo 2 of the P2
 * stage-5 db decomposition). Extracted verbatim from db.js; the public API (db.listReports /
 * getReport / createReport / updateReport / deleteReport / listDueReports / markReportSent /
 * listPostsWindow + db.REPORT_SCHEDULES) is preserved by db.js spreading this repo's return value
 * into its exports. Self-contained: every query is ownership-scoped by uid, the only internal call
 * is updateReport→getReport, and it depends solely on the shared pool + enabled flag.
 */
function createReportsRepo({ pool, enabled }) {
  // ── Named reports (per-user composition of dashboard blocks + email schedule) ──
  const REPORT_SCHEDULES = ['none', 'weekly', 'monthly'];
  const REPORT_COLS = `id, name, config, schedule,
    to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at,
    to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS updated_at`;

  // Compact index rows: the list never needs the full config, only a few summary facts pulled
  // safely out of the JSONB (jsonb_typeof guards so a legacy/garbage config never breaks the
  // query — a non-number channelId/periodDays or non-array blocks just yields NULL). Ownership
  // stays WHERE uid=$1; nothing here widens the tenant boundary.
  async function listReports(uid) {
    if (!enabled || uid == null) return [];
    const { rows } = await pool.query(
      `SELECT id, name, schedule,
              CASE
                WHEN jsonb_typeof(config->'channelId') = 'number'
                THEN CASE
                  WHEN (config->>'channelId') ~ '^[0-9]{1,10}$'
                  THEN CASE
                    WHEN (config->>'channelId')::numeric BETWEEN 1 AND 2147483647
                    THEN (config->>'channelId')::int
                  END
                END
              END AS channel_id,
              CASE
                WHEN jsonb_typeof(config->'periodDays') = 'number'
                THEN CASE
                  WHEN config->>'periodDays' IN ('0','7','30','90')
                  THEN (config->>'periodDays')::int
                END
              END AS period_days,
              CASE WHEN jsonb_typeof(config->'blocks')     = 'array'  THEN jsonb_array_length(config->'blocks')         END AS block_count,
              to_char(last_sent_at,'YYYY-MM-DD"T"HH24:MI:SS') AS last_sent_at,
              to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
              to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
         FROM reports WHERE uid=$1 ORDER BY updated_at DESC, id DESC`, [uid]);
    return rows;
  }

  // Ownership-checked fetch (WHERE uid) — routes turn null → 404.
  async function getReport(uid, id) {
    if (!enabled || uid == null || !id) return null;
    const { rows } = await pool.query(
      `SELECT ${REPORT_COLS} FROM reports WHERE uid=$1 AND id=$2`, [uid, id]);
    return rows[0] || null;
  }

  // schedule is optional and backward-compatible: old callers pass nothing → the column default
  // ('none') stands. Invalid direct callers fail explicitly; routes validate first for a clean 400.
  async function createReport(uid, name, config, schedule) {
    if (!enabled || uid == null) return null;
    if (schedule != null && !REPORT_SCHEDULES.includes(schedule)) throw new Error('bad schedule');
    const sched = schedule ?? null;
    const { rows } = await pool.query(
      sched
        ? `INSERT INTO reports (uid, name, config, schedule) VALUES ($1,$2,$3,$4) RETURNING ${REPORT_COLS}`
        : `INSERT INTO reports (uid, name, config) VALUES ($1,$2,$3) RETURNING ${REPORT_COLS}`,
      sched
        ? [uid, String(name).slice(0, 120), config || {}, sched]
        : [uid, String(name).slice(0, 120), config || {}]);
    return rows[0] || null;
  }

  // Partial update: only the provided fields; updated_at bumps on every write.
  async function updateReport(uid, id, { name, config, schedule } = {}) {
    if (!enabled || uid == null || !id) return null;
    const sets = [], vals = [uid, id];
    let i = 3;
    if (name != null)     { sets.push(`name=$${i++}`);     vals.push(String(name).slice(0, 120)); }
    if (config != null)   { sets.push(`config=$${i++}`);   vals.push(config); }
    if (schedule != null) { if (!REPORT_SCHEDULES.includes(schedule)) throw new Error('bad schedule'); sets.push(`schedule=$${i++}`); vals.push(schedule); }
    if (!sets.length) return getReport(uid, id);
    const { rows } = await pool.query(
      `UPDATE reports SET ${sets.join(', ')}, updated_at=now()
        WHERE uid=$1 AND id=$2 RETURNING ${REPORT_COLS}`, vals);
    return rows[0] || null;
  }

  async function deleteReport(uid, id) {
    if (!enabled || uid == null || !id) return false;
    const { rowCount } = await pool.query('DELETE FROM reports WHERE uid=$1 AND id=$2', [uid, id]);
    return rowCount > 0;
  }

  /* Scheduled email delivery: candidate reports, joined to the owner's email.
     The day-of-week / day-of-month + catch-up gate lives in the caller (index.js),
     which reads the returned last_sent_at — here only the anti-double-send window
     (weekly: >6 days, monthly: >27 days), so a cron fired twice the same day emails
     at most once. Disabled accounts are never emailed. */
  async function listDueReports({ weekly = false, monthly = false } = {}) {
    if (!enabled || (!weekly && !monthly)) return [];
    const { rows } = await pool.query(
      `SELECT r.id, r.uid, r.name, r.config, r.schedule, r.last_sent_at, u.email
         FROM reports r JOIN users u ON u.id = r.uid
        WHERE u.status = 'active'
          AND ((r.schedule = 'weekly'  AND $1 AND (r.last_sent_at IS NULL OR r.last_sent_at < now() - interval '6 days'))
            OR (r.schedule = 'monthly' AND $2 AND (r.last_sent_at IS NULL OR r.last_sent_at < now() - interval '27 days')))
        ORDER BY r.id ASC`, [weekly, monthly]);
    return rows;
  }

  async function markReportSent(id) {
    if (!enabled || !id) return false;
    const { rowCount } = await pool.query('UPDATE reports SET last_sent_at=now() WHERE id=$1', [id]);
    return rowCount > 0;
  }

  /* Durable at-most-once reservation for a scheduled email send (019_report_delivery_attempts).
     Resend's Idempotency-Key only dedupes for 24h; the next daily tick can fall outside that
     window, so the job takes its OWN reservation right before calling the provider. Atomic and
     actor-internal — no ownership arg because the scheduler already selected the row by id, and no
     shape reaches routes.

     reserveReportDelivery: claim `period` for `id` ONLY if that exact period is not already the
     reserved one — an older/absent period is overwritten, an identical one is refused. The
     `IS DISTINCT FROM` predicate is the whole gate: it matches (and updates) when the stored period
     is NULL or a different value, and matches nothing when it already equals `period`. Returns true
     only when THIS call took the reservation, so a duplicate discovery in the same period (double
     cron tick, catch-up next to the anchored branch, second instance) gets false and does not send. */
  async function reserveReportDelivery(id, period) {
    if (!enabled || !id || !period) return false;
    const { rowCount } = await pool.query(
      `UPDATE reports
          SET last_delivery_period = $2, last_delivery_attempt_at = now()
        WHERE id = $1 AND last_delivery_period IS DISTINCT FROM $2`,
      [id, period]);
    return rowCount > 0;
  }

  /* clearReportDelivery: release the reservation ONLY when report id + the exact reserved period
     still match — used after a known-not-sent (429) rejection so the next daily tick may retry the
     same period cleanly. The exact-period WHERE guards against clearing a reservation that a newer
     period has already overwritten. Returns true only when this exact reservation was cleared. */
  async function clearReportDelivery(id, period) {
    if (!enabled || !id || !period) return false;
    const { rowCount } = await pool.query(
      `UPDATE reports
          SET last_delivery_period = NULL, last_delivery_attempt_at = NULL
        WHERE id = $1 AND last_delivery_period = $2`,
      [id, period]);
    return rowCount > 0;
  }

  // Посты канала за окно (архив ingest'а) — вход серверного недельного дайджеста (weekDigest.js).
  // Ридер посты до сих пор читал только фронт через mtproto/снапшоты; здесь — прямое чтение архива.
  // channelId обязан быть уже resolved через ownership (вызывающий берёт его из listChannels(uid)).
  async function listPostsWindow(channelId, days = 28) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT date_published, caption, views, reactions, forwards, replies, erv
         FROM posts
        WHERE channel_id = $1 AND date_published >= now() - ($2::int || ' days')::interval
        ORDER BY date_published ASC`, [channelId, days]);
    return rows;
  }
  return { REPORT_SCHEDULES, listReports, getReport, createReport, updateReport, deleteReport, listDueReports, markReportSent, reserveReportDelivery, clearReportDelivery, listPostsWindow };
}

module.exports = { createReportsRepo };
