// ═══════════════════════════════════════════════════════════════
//  Pulse Analytics — история в Postgres (Railway)
//  Полностью опционально: без DATABASE_URL (или без модуля pg)
//  всё деградирует мягко — дашборд работает как раньше.
// ═══════════════════════════════════════════════════════════════

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_e) { /* pg не установлен — БД выключена */ }

const DATABASE_URL = process.env.DATABASE_URL || '';
const enabled = !!(DATABASE_URL && Pool);

let pool = null;
if (enabled) {
  // SSL: Railway's PRIVATE url (*.railway.internal) needs NO ssl; external/public
  // managed Postgres usually does. Override with PGSSL=disable|require if needed.
  const internal = /\.railway\.internal/i.test(DATABASE_URL);
  const sslMode = (process.env.PGSSL || '').toLowerCase();
  let ssl;
  if (sslMode === 'disable') ssl = false;
  else if (sslMode === 'require') ssl = { rejectUnauthorized: false };
  else ssl = internal ? false : { rejectUnauthorized: false };   // smart default

  pool = new Pool({ connectionString: DATABASE_URL, ssl, max: 4 });
  pool.on('error', (e) => console.error('[db] pool error:', e.message));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_daily (
  day DATE PRIMARY KEY,
  subscribers INTEGER, joins INTEGER, leaves INTEGER,
  views INTEGER, forwards INTEGER, reactions INTEGER,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS posts (
  post_id BIGINT PRIMARY KEY,
  date_published TIMESTAMPTZ,
  views INTEGER, reactions INTEGER, forwards INTEGER, replies INTEGER,
  erv NUMERIC, virality NUMERIC, media_type TEXT, caption TEXT, hashtags JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mentions (
  channel_id BIGINT, msg_id BIGINT,
  post_date TIMESTAMPTZ, first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
  title TEXT, username TEXT, link TEXT, snippet TEXT, views INTEGER, query TEXT,
  PRIMARY KEY (channel_id, msg_id)
);
CREATE TABLE IF NOT EXISTS bugs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  text TEXT NOT NULL,
  context TEXT
);
-- kind: тип обращения (баг / фича / правка). Идемпотентно для уже существующих БД.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bug';
CREATE TABLE IF NOT EXISTS bug_attachments (
  id SERIAL PRIMARY KEY,
  bug_id INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bug_attachments_bug_id_idx ON bug_attachments(bug_id);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);
`;

const USER_ROLES = ['user', 'superuser'];
const USER_STATUSES = ['pending', 'active', 'disabled'];
const BUG_STATUSES = ['open', 'in_progress', 'done', 'wont_fix'];
const BUG_SEVERITIES = ['low', 'medium', 'high'];
const BUG_KINDS = ['bug', 'feature', 'change'];

async function init() {
  if (!enabled) { console.log('[db] disabled (no DATABASE_URL) — history off'); return; }
  await pool.query(SCHEMA);
  console.log('[db] schema ready');
}

const num = (v) => (v == null || isNaN(v)) ? null : Math.round(Number(v));

/* Pure transform: stats graphs → array of daily rows. Exported for testing.
   Builds the union of all days present across the daily series, so re-running
   refreshes the last ~3 months while older days already in the DB are kept. */
function graphsToDailyRows(graphs) {
  if (!graphs || !graphs.available) return [];
  const map = {};
  const put = (ts, field, val) => {
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return;
    const k = d.toISOString().slice(0, 10);
    (map[k] || (map[k] = { day: k }))[field] = num(val);
  };
  const g = graphs;
  if (g.growth && g.growth.x && g.growth.series && g.growth.series[0]) {
    g.growth.x.forEach((ts, i) => put(ts, 'subscribers', g.growth.series[0].values[i]));
  }
  if (g.followers && g.followers.x && g.followers.series) {
    const j = g.followers.series.find(s => /join|подпис/i.test(s.name)) || g.followers.series[0];
    const l = g.followers.series.find(s => /left|отпис/i.test(s.name)) || g.followers.series[1];
    g.followers.x.forEach((ts, i) => { if (j) put(ts, 'joins', j.values[i]); if (l) put(ts, 'leaves', l.values[i]); });
  }
  if (g.interactions && g.interactions.x && g.interactions.series) {
    const v = g.interactions.series.find(s => /view|просмотр/i.test(s.name)) || g.interactions.series[0];
    const s = g.interactions.series.find(s => /share|репост/i.test(s.name)) || g.interactions.series[1];
    g.interactions.x.forEach((ts, i) => { if (v) put(ts, 'views', v.values[i]); if (s) put(ts, 'forwards', s.values[i]); });
  }
  if (g.reactions_daily && g.reactions_daily.x && g.reactions_daily.values) {
    g.reactions_daily.x.forEach((ts, i) => put(ts, 'reactions', g.reactions_daily.values[i]));
  }
  return Object.values(map);
}

async function upsertChannelDaily(rows) {
  if (!enabled || !rows || !rows.length) return 0;
  const sql = `INSERT INTO channel_daily (day, subscribers, joins, leaves, views, forwards, reactions, captured_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (day) DO UPDATE SET
      subscribers=COALESCE(EXCLUDED.subscribers, channel_daily.subscribers),
      joins=COALESCE(EXCLUDED.joins, channel_daily.joins),
      leaves=COALESCE(EXCLUDED.leaves, channel_daily.leaves),
      views=COALESCE(EXCLUDED.views, channel_daily.views),
      forwards=COALESCE(EXCLUDED.forwards, channel_daily.forwards),
      reactions=COALESCE(EXCLUDED.reactions, channel_daily.reactions),
      captured_at=now()`;
  const client = await pool.connect();
  try {
    for (const r of rows) {
      await client.query(sql, [r.day, r.subscribers ?? null, r.joins ?? null, r.leaves ?? null,
        r.views ?? null, r.forwards ?? null, r.reactions ?? null]);
    }
  } finally { client.release(); }
  return rows.length;
}

async function upsertPosts(rows) {
  if (!enabled || !rows || !rows.length) return 0;
  const sql = `INSERT INTO posts (post_id, date_published, views, reactions, forwards, replies, erv, virality, media_type, caption, hashtags, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
    ON CONFLICT (post_id) DO UPDATE SET
      date_published=COALESCE(EXCLUDED.date_published, posts.date_published),
      views=EXCLUDED.views, reactions=EXCLUDED.reactions, forwards=EXCLUDED.forwards, replies=EXCLUDED.replies,
      erv=EXCLUDED.erv, virality=EXCLUDED.virality, media_type=EXCLUDED.media_type,
      caption=EXCLUDED.caption, hashtags=EXCLUDED.hashtags, updated_at=now()`;
  const client = await pool.connect();
  try {
    for (const r of rows) {
      await client.query(sql, [r.post_id, r.date_published || null, r.views ?? null, r.reactions ?? null,
        r.forwards ?? null, r.replies ?? null, r.erv ?? null, r.virality ?? null,
        r.media_type || null, r.caption || null, JSON.stringify(r.hashtags || [])]);
    }
  } finally { client.release(); }
  return rows.length;
}

async function upsertMentions(list) {
  if (!enabled || !list || !list.length) return 0;
  const sql = `INSERT INTO mentions (channel_id, msg_id, post_date, first_seen, last_seen, title, username, link, snippet, views, query)
    VALUES ($1,$2,$3, now(), now(), $4,$5,$6,$7,$8,$9)
    ON CONFLICT (channel_id, msg_id) DO UPDATE SET
      last_seen=now(), views=EXCLUDED.views, title=EXCLUDED.title, username=EXCLUDED.username,
      link=EXCLUDED.link, snippet=EXCLUDED.snippet, query=EXCLUDED.query`;
  const client = await pool.connect();
  let n = 0;
  try {
    for (const m of list) {
      if (m.channel_id == null || m.msg_id == null) continue;
      await client.query(sql, [m.channel_id, m.msg_id, m.date || null, m.title || null, m.username || null,
        m.link || null, m.snippet || null, m.views ?? null, m.query || null]);
      n++;
    }
  } finally { client.release(); }
  return n;
}

async function getChannelHistory(days = 400) {
  if (!enabled) return [];
  const { rows } = await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, subscribers, joins, leaves, views, forwards, reactions
     FROM channel_daily WHERE day >= (CURRENT_DATE - $1::int) ORDER BY day ASC`, [days]);
  return rows;
}

async function getMentionsHistory() {
  if (!enabled) return null;
  const total = await pool.query(
    'SELECT count(*)::int AS total, count(distinct channel_id)::int AS channels, COALESCE(sum(views),0)::bigint AS views FROM mentions');
  const byMonth = await pool.query(
    `SELECT to_char(date_trunc('month', COALESCE(post_date, first_seen)),'YYYY-MM') AS month, count(*)::int AS c
     FROM mentions GROUP BY 1 ORDER BY 1`);
  return { total: total.rows[0], by_month: byMonth.rows };
}

// Full mentions panel from the archive — same shape renderMentions() expects from
// the live search, so the dashboard can show stored mentions without spending quota.
async function getMentionsArchive(limit = 30) {
  if (!enabled) return null;
  const totals = await pool.query(
    `SELECT count(*)::int AS total, count(distinct channel_id)::int AS unique_channels,
            COALESCE(sum(views),0)::bigint AS total_views FROM mentions`);
  const byDay = await pool.query(
    `SELECT to_char(COALESCE(post_date, first_seen),'DD.MM') AS d, count(*)::int AS c
       FROM mentions WHERE COALESCE(post_date, first_seen) >= (CURRENT_DATE - 60) GROUP BY 1`);
  const channels = await pool.query(
    `SELECT max(title) AS title, max(username) AS username, count(*)::int AS count,
            COALESCE(sum(views),0)::int AS views
       FROM mentions GROUP BY channel_id ORDER BY count(*) DESC, sum(views) DESC NULLS LAST LIMIT 10`);
  const recent = await pool.query(
    `SELECT channel_id, msg_id, title, username, link, snippet, views,
            to_char(COALESCE(post_date, first_seen),'YYYY-MM-DD"T"HH24:MI:SS') AS date
       FROM mentions ORDER BY COALESCE(post_date, first_seen) DESC LIMIT $1`, [limit]);
  const t = totals.rows[0] || {};
  const by_day = {};
  for (const r of byDay.rows) by_day[r.d] = r.c;
  return {
    available: true,
    total: t.total || 0,
    unique_channels: t.unique_channels || 0,
    total_views: Number(t.total_views || 0),
    by_day,
    top_channels: channels.rows,
    recent: recent.rows,
  };
}

// ── Users / accounts ──
async function countUsers() {
  if (!enabled) return 0;
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  return rows[0].n;
}

async function createUser({ email, pass_hash, role, status }) {
  if (!enabled) return null;
  const r = USER_ROLES.includes(role) ? role : 'user';
  const s = USER_STATUSES.includes(status) ? status : 'pending';
  const { rows } = await pool.query(
    `INSERT INTO users (email, pass_hash, role, status) VALUES ($1,$2,$3,$4)
     RETURNING id, email, role, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
    [String(email).toLowerCase().trim(), pass_hash, r, s]);
  return rows[0];
}

async function getUserByEmail(email) {
  if (!enabled) return null;
  const { rows } = await pool.query(
    'SELECT id, email, pass_hash, role, status FROM users WHERE email=$1',
    [String(email).toLowerCase().trim()]);
  return rows[0] || null;
}

async function getUserById(id) {
  if (!enabled) return null;
  const { rows } = await pool.query('SELECT id, email, role, status FROM users WHERE id=$1', [id]);
  return rows[0] || null;
}

async function listUsers() {
  if (!enabled) return [];
  const { rows } = await pool.query(
    `SELECT id, email, role, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
     FROM users ORDER BY created_at ASC`);
  return rows;
}

async function updateUser(id, { role, status }) {
  if (!enabled) return null;
  const sets = [], vals = [];
  let i = 1;
  if (role != null)   { if (!USER_ROLES.includes(role))     throw new Error('bad role');   sets.push(`role=$${i++}`);   vals.push(role); }
  if (status != null) { if (!USER_STATUSES.includes(status)) throw new Error('bad status'); sets.push(`status=$${i++}`); vals.push(status); }
  if (!sets.length) return getUserById(id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id=$${i}
     RETURNING id, email, role, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`, vals);
  return rows[0] || null;
}

async function setUserPassword(id, pass_hash) {
  if (!enabled) return false;
  await pool.query('UPDATE users SET pass_hash=$2 WHERE id=$1', [id, pass_hash]);
  return true;
}

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

module.exports = {
  enabled, init, graphsToDailyRows,
  USER_ROLES, USER_STATUSES,
  countUsers, createUser, getUserByEmail, getUserById, listUsers, updateUser, setUserPassword,
  upsertChannelDaily, upsertPosts, upsertMentions,
  getChannelHistory, getMentionsHistory, getMentionsArchive,
  createBug, listBugs, updateBug, deleteBug, BUG_STATUSES, BUG_SEVERITIES, BUG_KINDS,
  bugExists, getBug, addAttachmentIfRoom, getAttachment,
};
