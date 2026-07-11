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

  async function listReports(uid) {
    if (!enabled || uid == null) return [];
    const { rows } = await pool.query(
      `SELECT id, name, schedule,
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

  async function createReport(uid, name, config) {
    if (!enabled || uid == null) return null;
    const { rows } = await pool.query(
      `INSERT INTO reports (uid, name, config) VALUES ($1,$2,$3) RETURNING ${REPORT_COLS}`,
      [uid, String(name).slice(0, 120), config || {}]);
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
  return { REPORT_SCHEDULES, listReports, getReport, createReport, updateReport, deleteReport, listDueReports, markReportSent, listPostsWindow };
}

module.exports = { createReportsRepo };
