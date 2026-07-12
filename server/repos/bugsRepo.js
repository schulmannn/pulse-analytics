'use strict';

/* ── Bugs / crash-telemetry repo (P2 db-split, PR 5) ─────────────────────────────────────────────
   Трекер багов/фич-реквестов (bugs), клиентская crash-телеметрия (та же таблица, kind='crash') +
   dedup-леджер сигнатур крашей (crash_signatures, «одна Notion-карточка на уникальный краш») и
   вложения (bug_attachments). Извлечено ДОСЛОВНО из db.js — SQL не менялся. Публичный `db.*` API
   не меняется: db.js спредит методы этого репо в module.exports.

   Самый изолированный домен: зависит только от pool + enabled (инъекция), без tenant-предикатов и
   транзакций (все операции — одиночные запросы; addAttachmentIfRoom атомарен через INSERT ... SELECT
   WHERE count<max). Решение «уведомлять Claude/Notion» живёт ВЫШЕ (routes/service), не тут. */

const BUG_STATUSES = ['open', 'in_progress', 'done', 'wont_fix'];
const BUG_SEVERITIES = ['low', 'medium', 'high'];
const BUG_KINDS = ['bug', 'feature', 'change'];

function createBugsRepo({ pool, enabled }) {
  async function createBug({ text, severity, context, kind }) {
    if (!enabled) return null;
    const sev = BUG_SEVERITIES.includes(severity) ? severity : 'medium';
    const knd = BUG_KINDS.includes(kind) ? kind : 'bug';
    const { rows } = await pool.query(
      `INSERT INTO bugs (text, severity, context, kind) VALUES ($1,$2,$3,$4)
       RETURNING id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, status, severity, kind, text, context`,
      [String(text).slice(0, 4000), sev, context ? String(context).slice(0, 500) : null, knd]);
    return rows[0];
  }

  async function listBugs(status) {
    if (!enabled) return [];
    const filter = BUG_STATUSES.includes(status) ? status : null;
    const { rows } = await pool.query(
      `SELECT id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, status, severity, kind, text, context,
         (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'mime', a.mime) ORDER BY a.id), '[]')
            FROM bug_attachments a WHERE a.bug_id = bugs.id) AS attachments
       FROM bugs ${filter ? 'WHERE status=$1' : ''} ORDER BY
         CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT 300`, filter ? [filter] : []);
    return rows;
  }

  async function updateBug(id, status) {
    if (!enabled) return null;
    if (!BUG_STATUSES.includes(status)) throw new Error('bad status');
    const { rows } = await pool.query(
      `UPDATE bugs SET status=$2, updated_at=now() WHERE id=$1
       RETURNING id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, status, severity, kind, text, context`,
      [id, status]);
    return rows[0] || null;
  }

  async function deleteBug(id) {
    if (!enabled) return false;
    await pool.query('DELETE FROM bugs WHERE id=$1', [id]);
    return true;
  }

  // Client render-crash telemetry lands in the SAME bugs table under kind='crash' — one admin surface,
  // no new table/migration (kind is free TEXT). 'crash' is inserted directly (not via BUG_KINDS, which
  // stays the user-facing kind set), and context gets far more room than the 500-char user-report cap
  // so a full componentStack + trace context fits.
  async function createCrash({ text, context }) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      `INSERT INTO bugs (text, severity, context, kind) VALUES ($1,'high',$2,'crash')
       RETURNING id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, status, severity, kind, text, context`,
      [String(text).slice(0, 4000), context ? String(context).slice(0, 8000) : null]);
    return rows[0];
  }

  // ── Client-crash dedup ledger (drives the "one Notion card per unique crash" sink) ──
  // Upsert by signature: a first sighting inserts (count=1); a repeat bumps count + last_seen. The
  // `(xmax = 0)` trick distinguishes INSERT (new signature) from UPDATE (repeat) in ONE round-trip, so
  // the caller knows whether to CREATE a Notion card or UPDATE the existing one.
  async function upsertCrashSignature(f) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      `INSERT INTO crash_signatures
         (signature, scope, name, message, route, widget_id, label, commit_sha, last_trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (signature) DO UPDATE
         SET count = crash_signatures.count + 1,
             last_seen = now(),
             last_trace_id = EXCLUDED.last_trace_id
       RETURNING (xmax = 0) AS is_new, count, notion_page_id,
                 to_char(last_notified AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_notified`,
      [String(f.signature).slice(0, 64), f.scope || null, f.name || null,
       f.message ? String(f.message).slice(0, 500) : null, f.route || null,
       f.widgetId || null, f.label || null, f.commit || null, f.traceId || null]);
    const r = rows[0];
    return r ? { isNew: r.is_new, count: Number(r.count), notionPageId: r.notion_page_id, lastNotified: r.last_notified } : null;
  }

  /** Record the Notion page id for a signature; also starts the notify-throttle window. */
  async function setCrashNotionPage(signature, pageId) {
    if (!enabled) return;
    await pool.query('UPDATE crash_signatures SET notion_page_id=$2, last_notified=now() WHERE signature=$1',
      [String(signature).slice(0, 64), pageId]);
  }

  /** Mark that we just pushed a repeat-update to Notion (throttle window reset). */
  async function touchCrashNotified(signature) {
    if (!enabled) return;
    await pool.query('UPDATE crash_signatures SET last_notified=now() WHERE signature=$1', [String(signature).slice(0, 64)]);
  }

  async function bugExists(id) {
    if (!enabled) return false;
    const { rows } = await pool.query('SELECT 1 FROM bugs WHERE id=$1', [id]);
    return rows.length > 0;
  }

  async function getBug(id) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      `SELECT id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, status, severity, kind, text, context,
         (SELECT count(*)::int FROM bug_attachments a WHERE a.bug_id = bugs.id) AS attachment_count
       FROM bugs WHERE id=$1`, [id]);
    return rows[0] || null;
  }

  // Atomic cap: insert only if the bug has < max attachments. Returns the row,
  // or null when full — closes the count-then-insert race (concurrent uploads).
  async function addAttachmentIfRoom(bugId, mime, buf, max) {
    if (!enabled) return null;
    const { rows } = await pool.query(
      `INSERT INTO bug_attachments (bug_id, mime, data)
       SELECT $1, $2, $3
       WHERE (SELECT count(*) FROM bug_attachments WHERE bug_id = $1) < $4
       RETURNING id, mime`, [bugId, mime, buf, max]);
    return rows[0] || null;
  }

  async function getAttachment(id) {
    if (!enabled) return null;
    const { rows } = await pool.query('SELECT mime, data FROM bug_attachments WHERE id=$1', [id]);
    return rows[0] || null;
  }

  return {
    BUG_STATUSES, BUG_SEVERITIES, BUG_KINDS,
    createBug, listBugs, updateBug, deleteBug,
    createCrash, upsertCrashSignature, setCrashNotionPage, touchCrashNotified,
    bugExists, getBug, addAttachmentIfRoom, getAttachment,
  };
}

module.exports = { createBugsRepo };
