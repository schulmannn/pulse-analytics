// ═══════════════════════════════════════════════════════════════
//  Pulse Analytics — история в Postgres (Railway)
//  Полностью опционально: без DATABASE_URL (или без модуля pg)
//  всё деградирует мягко — дашборд работает как раньше.
// ═══════════════════════════════════════════════════════════════

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_e) { /* pg не установлен — БД выключена */ }
const { runMigrations } = require('./migrations');

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

/* Historical inline schema retained as a comment for one release only.
   Source of truth is server/migrations/*.sql; startup never executes this block.
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
-- Персональная раскладка дашборда (порядок/скрытие/ширина блоков) per-user.
CREATE TABLE IF NOT EXISTS user_prefs (
  uid INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Email verification / password-reset tokens (Sprint 1B). The raw token is sent
-- only in the email; we store its sha256. Single-use (used_at) + expiry, hashed
-- at rest so a DB read can't forge a link.
CREATE TABLE IF NOT EXISTS email_tokens (
  id SERIAL PRIMARY KEY,
  uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'verify' | 'reset'
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_hash_idx ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_tokens_uid_kind_idx ON email_tokens(uid, kind);
-- Снапшот "velocity" (жизнь поста). Считается тяжело (до ~12 последовательных
-- GetMessageStats), поэтому строится в ingest-кроне раз в день и кэшируется здесь,
-- чтобы дашборд-эндпоинт читал готовый JSON, а не дёргал Telegram в HTTP-запросе.
CREATE TABLE IF NOT EXISTS velocity_daily (
  day DATE PRIMARY KEY,
  data JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Multitenancy (Sprint 1A): channel = tenant, owned by a user ──────────────
-- Each user owns N channels. The owner's existing @bynotem data lives under a
-- single 'central' channel (fed by the cron/pulse-mtproto = "collector #0");
-- other users' channels are fed by their own collectors (later phase).
CREATE TABLE IF NOT EXISTS channels (
  id            SERIAL PRIMARY KEY,
  owner_uid     INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- nullable: tolerates bootstrap race
  tg_channel_id BIGINT,                                           -- populated lazily from /channel .id
  username      TEXT,
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  source        TEXT NOT NULL DEFAULT 'collector',                -- 'central' = owner (cron/pulse-mtproto)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channels_owner_idx ON channels(owner_uid);
CREATE UNIQUE INDEX IF NOT EXISTS channels_owner_tgid_uniq ON channels(owner_uid, tg_channel_id) WHERE tg_channel_id IS NOT NULL;
-- At most one 'central' channel (singleton owner feed) → makes find-or-create race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS channels_one_central ON channels(source) WHERE source = 'central';

-- Scope the data tables per channel. Drop the old single-column PKs (so two
-- channels can share a day/post_id) and replace with composite UNIQUE INDEXes —
-- CREATE UNIQUE INDEX IF NOT EXISTS is idempotent (Postgres lacks ADD CONSTRAINT
-- IF NOT EXISTS) and ON CONFLICT works against a unique index. NULL channel_id
-- rows stay distinct under the index until the boot-time backfill stamps them.
ALTER TABLE channel_daily ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_daily_pkey') THEN
  ALTER TABLE channel_daily DROP CONSTRAINT channel_daily_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS channel_daily_chan_day_uniq ON channel_daily(channel_id, day);
CREATE INDEX IF NOT EXISTS channel_daily_chan_idx ON channel_daily(channel_id);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='posts_pkey') THEN
  ALTER TABLE posts DROP CONSTRAINT posts_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS posts_chan_post_uniq ON posts(channel_id, post_id);
CREATE INDEX IF NOT EXISTS posts_chan_idx ON posts(channel_id);

ALTER TABLE velocity_daily ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='velocity_daily_pkey') THEN
  ALTER TABLE velocity_daily DROP CONSTRAINT velocity_daily_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS velocity_chan_day_uniq ON velocity_daily(channel_id, day);

-- mentions already has channel_id = the MENTIONING channel; the tenant key is a
-- distinct column to avoid the name clash.
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS owner_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mentions_pkey') THEN
  ALTER TABLE mentions DROP CONSTRAINT mentions_pkey; END IF; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS mentions_owner_src_msg_uniq ON mentions(owner_channel_id, channel_id, msg_id);
CREATE INDEX IF NOT EXISTS mentions_owner_idx ON mentions(owner_channel_id);

-- ── Collector ingest (Sprint 1C): per-channel API keys + current snapshot ──
-- API key authenticates a collector to push its channel's data. The raw key is
-- shown once; only sha256 is stored. key_prefix is shown in the UI to identify it.
CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uniq ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_channel_idx ON api_keys(channel_id);
-- Current computed dashboard state per channel (channel meta + stats + graphs +
-- views_summary + posts), pushed by the collector. Time-series go to the
-- per-channel tables (channel_daily / posts / velocity_daily / mentions).
CREATE TABLE IF NOT EXISTS channel_snapshots (
  channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
*/

const USER_ROLES = ['user', 'superuser'];
const USER_STATUSES = ['unverified', 'pending', 'active', 'disabled'];
const BUG_STATUSES = ['open', 'in_progress', 'done', 'wont_fix'];
const BUG_SEVERITIES = ['low', 'medium', 'high'];
const BUG_KINDS = ['bug', 'feature', 'change'];

async function init() {
  if (!enabled) { console.log('[db] disabled (no DATABASE_URL) — history off'); return; }
  await pool.query('SELECT 1 FROM channels LIMIT 1');
  await migrateOwnerChannel();
  console.log('[db] connection ready');
}

async function migrate() {
  if (!enabled) return [];
  return runMigrations(pool);
}

async function ping() {
  if (!enabled) return { enabled: false, ok: true };
  const started = Date.now();
  await pool.query('SELECT 1');
  return { enabled: true, ok: true, latency_ms: Date.now() - started };
}

async function close() {
  if (pool) await pool.end();
}

// ── Channels (tenants) ───────────────────────────────────────────
const OWNER_CHANNEL = process.env.OWNER_CHANNEL || process.env.TG_CHANNEL || '@bynotem';

/* Find-or-create the singleton 'central' channel (the owner's @bynotem feed) and
   stamp every pre-existing global data row onto it. Idempotent + double-boot-safe:
   the partial unique index makes the INSERT race-safe, and the backfill UPDATEs
   match nothing once the rows are stamped. The admin user may not exist yet at
   first boot (bootstrapAdmin runs after init) → create with owner_uid NULL and
   let adoptOwnerChannel() claim it once the admin row exists. */
async function migrateOwnerChannel() {
  if (!enabled) return;
  let { rows } = await pool.query(`SELECT id FROM channels WHERE source='central' LIMIT 1`);
  let ownerId = rows[0] && rows[0].id;
  if (!ownerId) {
    const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
    let adminId = null;
    if (adminEmail) {
      const u = await pool.query('SELECT id FROM users WHERE email=$1', [adminEmail]);
      adminId = u.rows[0] ? u.rows[0].id : null;
    }
    const uname = String(OWNER_CHANNEL).replace(/^@/, '');
    const ins = await pool.query(
      `INSERT INTO channels (owner_uid, username, title, status, source)
       VALUES ($1,$2,$2,'active','central') ON CONFLICT DO NOTHING RETURNING id`,
      [adminId, uname]);
    ownerId = ins.rows[0] ? ins.rows[0].id
      : (await pool.query(`SELECT id FROM channels WHERE source='central' LIMIT 1`)).rows[0]?.id;
  }
  if (!ownerId) return;
  await pool.query(`UPDATE channel_daily  SET channel_id=$1 WHERE channel_id IS NULL`, [ownerId]);
  await pool.query(`UPDATE posts          SET channel_id=$1 WHERE channel_id IS NULL`, [ownerId]);
  await pool.query(`UPDATE velocity_daily SET channel_id=$1 WHERE channel_id IS NULL`, [ownerId]);
  await pool.query(`UPDATE mentions       SET owner_channel_id=$1 WHERE owner_channel_id IS NULL`, [ownerId]);
}

// Claim the orphan central channel for the admin once its account exists
// (chained after bootstrapAdmin in index.js). No-op once owned → idempotent.
async function adoptOwnerChannel(adminUid) {
  if (!enabled || adminUid == null) return false;
  await pool.query(`UPDATE channels SET owner_uid=$1 WHERE owner_uid IS NULL AND source='central'`, [adminUid]);
  return true;
}

const CHANNEL_COLS = 'id, username, title, status, source, tg_channel_id, owner_uid';
const isOperator = (u) => u && u.uid == null && u.role === 'superuser';   // break-glass = central-only

// Channels visible to a user. Break-glass superuser (no account) sees the central channel only.
// Latest known subscriber count per channel (cheap: newest channel_daily row).
// Null for channels without daily history (e.g. a fresh collector channel).
const MEMBER_COUNT_COL =
  `(SELECT cd.subscribers FROM channel_daily cd
      WHERE cd.channel_id = channels.id AND cd.subscribers IS NOT NULL
      ORDER BY cd.day DESC LIMIT 1) AS "memberCount"`;

async function listChannels(user) {
  if (!enabled) return [];
  if (isOperator(user)) {
    const { rows } = await pool.query(
      `SELECT ${CHANNEL_COLS}, ${MEMBER_COUNT_COL} FROM channels WHERE source='central' ORDER BY created_at ASC`);
    return rows;
  }
  const uid = user && user.uid;
  if (uid == null) return [];
  const { rows } = await pool.query(
    `SELECT ${CHANNEL_COLS}, ${MEMBER_COUNT_COL} FROM channels WHERE owner_uid=$1 AND status<>'disabled' ORDER BY created_at ASC`, [uid]);
  return rows;
}

// Ownership-checked fetch: returns the channel row only if it belongs to the user
// (or is central, for the break-glass operator). Routes turn null → 403.
async function getChannel(id, user) {
  if (!enabled || !id) return null;
  if (isOperator(user)) {
    const { rows } = await pool.query(`SELECT ${CHANNEL_COLS} FROM channels WHERE id=$1 AND source='central'`, [id]);
    return rows[0] || null;
  }
  const uid = user && user.uid;
  if (uid == null) return null;
  const { rows } = await pool.query(`SELECT ${CHANNEL_COLS} FROM channels WHERE id=$1 AND owner_uid=$2`, [id, uid]);
  return rows[0] || null;
}

// Unscoped lookup (internal use: cron, etc.)
async function getChannelById(id) {
  if (!enabled || !id) return null;
  const { rows } = await pool.query(`SELECT ${CHANNEL_COLS} FROM channels WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function getOwnerChannelId() {
  if (!enabled) return null;
  const { rows } = await pool.query(`SELECT id FROM channels WHERE source='central' LIMIT 1`);
  return rows[0] ? rows[0].id : null;
}

async function setChannelTgId(id, tgId, executor = pool) {
  if (!enabled || !id || tgId == null) return false;
  await executor.query(`UPDATE channels SET tg_channel_id=$2 WHERE id=$1 AND tg_channel_id IS NULL`, [id, tgId]);
  return true;
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

async function upsertChannelDaily(channelId, rows, executor = pool) {
  if (!enabled || !channelId || !rows || !rows.length) return 0;
  const sql = `INSERT INTO channel_daily
      (channel_id, day, subscribers, joins, leaves, views, forwards, reactions, captured_at)
    SELECT $1, x.day::date, x.subscribers, x.joins, x.leaves, x.views, x.forwards, x.reactions, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        day text, subscribers integer, joins integer, leaves integer,
        views integer, forwards integer, reactions integer
      )
    ON CONFLICT (channel_id, day) DO UPDATE SET
      subscribers=COALESCE(EXCLUDED.subscribers, channel_daily.subscribers),
      joins=COALESCE(EXCLUDED.joins, channel_daily.joins),
      leaves=COALESCE(EXCLUDED.leaves, channel_daily.leaves),
      views=COALESCE(EXCLUDED.views, channel_daily.views),
      forwards=COALESCE(EXCLUDED.forwards, channel_daily.forwards),
      reactions=COALESCE(EXCLUDED.reactions, channel_daily.reactions),
      captured_at=now()`;
  await executor.query(sql, [channelId, JSON.stringify(rows)]);
  return rows.length;
}

async function upsertPosts(channelId, rows, executor = pool) {
  if (!enabled || !channelId || !rows || !rows.length) return 0;
  const sql = `INSERT INTO posts
      (channel_id, post_id, date_published, views, reactions, forwards, replies,
       erv, virality, media_type, caption, hashtags, updated_at)
    SELECT $1, x.post_id, x.date_published, x.views, x.reactions, x.forwards, x.replies,
           x.erv, x.virality, x.media_type, x.caption, x.hashtags, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        post_id bigint, date_published timestamptz, views integer, reactions integer,
        forwards integer, replies integer, erv numeric, virality numeric,
        media_type text, caption text, hashtags jsonb
      )
    ON CONFLICT (channel_id, post_id) DO UPDATE SET
      date_published=COALESCE(EXCLUDED.date_published, posts.date_published),
      views=EXCLUDED.views, reactions=EXCLUDED.reactions, forwards=EXCLUDED.forwards, replies=EXCLUDED.replies,
      erv=EXCLUDED.erv, virality=EXCLUDED.virality, media_type=EXCLUDED.media_type,
      caption=EXCLUDED.caption, hashtags=EXCLUDED.hashtags, updated_at=now()`;
  await executor.query(sql, [channelId, JSON.stringify(rows)]);
  return rows.length;
}

async function upsertMentions(channelId, list, executor = pool) {
  if (!enabled || !channelId || !list || !list.length) return 0;
  const clean = list.filter(m => m.channel_id != null && m.msg_id != null);
  if (!clean.length) return 0;
  const sql = `INSERT INTO mentions
      (owner_channel_id, channel_id, msg_id, post_date, first_seen, last_seen,
       title, username, link, snippet, views, query)
    SELECT $1, x.channel_id, x.msg_id, x.date, now(), now(),
           x.title, x.username, x.link, x.snippet, x.views, x.query
      FROM jsonb_to_recordset($2::jsonb) AS x(
        channel_id bigint, msg_id bigint, date timestamptz, title text, username text,
        link text, snippet text, views integer, query text
      )
    ON CONFLICT (owner_channel_id, channel_id, msg_id) DO UPDATE SET
      last_seen=now(), views=EXCLUDED.views, title=EXCLUDED.title, username=EXCLUDED.username,
      link=EXCLUDED.link, snippet=EXCLUDED.snippet, query=EXCLUDED.query`;
  await executor.query(sql, [channelId, JSON.stringify(clean)]);
  return clean.length;
}

async function getChannelHistory(channelId, days = 400) {
  if (!enabled || !channelId) return [];
  const { rows } = await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, subscribers, joins, leaves, views, forwards, reactions
     FROM channel_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int) ORDER BY day ASC`, [channelId, days]);
  return rows;
}

async function getMentionsHistory(channelId) {
  if (!enabled || !channelId) return null;
  const total = await pool.query(
    'SELECT count(*)::int AS total, count(distinct channel_id)::int AS channels, COALESCE(sum(views),0)::bigint AS views FROM mentions WHERE owner_channel_id=$1', [channelId]);
  const byMonth = await pool.query(
    `SELECT to_char(date_trunc('month', COALESCE(post_date, first_seen)),'YYYY-MM') AS month, count(*)::int AS c
     FROM mentions WHERE owner_channel_id=$1 GROUP BY 1 ORDER BY 1`, [channelId]);
  return { total: total.rows[0], by_month: byMonth.rows };
}

// Full mentions panel from the archive — same shape renderMentions() expects from
// the live search, so the dashboard can show stored mentions without spending quota.
async function getMentionsArchive(channelId, limit = 30) {
  if (!enabled || !channelId) return null;
  const totals = await pool.query(
    `SELECT count(*)::int AS total, count(distinct channel_id)::int AS unique_channels,
            COALESCE(sum(views),0)::bigint AS total_views FROM mentions WHERE owner_channel_id=$1`, [channelId]);
  const byDay = await pool.query(
    `SELECT to_char(COALESCE(post_date, first_seen),'DD.MM') AS d, count(*)::int AS c
       FROM mentions WHERE owner_channel_id=$1 AND COALESCE(post_date, first_seen) >= (CURRENT_DATE - 60) GROUP BY 1`, [channelId]);
  const channels = await pool.query(
    `SELECT max(title) AS title, max(username) AS username, count(*)::int AS count,
            COALESCE(sum(views),0)::int AS views
       FROM mentions WHERE owner_channel_id=$1 GROUP BY channel_id ORDER BY count(*) DESC, sum(views) DESC NULLS LAST LIMIT 10`, [channelId]);
  const recent = await pool.query(
    `SELECT channel_id, msg_id, title, username, link, snippet, views,
            to_char(COALESCE(post_date, first_seen),'YYYY-MM-DD"T"HH24:MI:SS') AS date
       FROM mentions WHERE owner_channel_id=$1 ORDER BY COALESCE(post_date, first_seen) DESC LIMIT $2`, [channelId, limit]);
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
     RETURNING id, email, role, status, token_version,
       to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
    [String(email).toLowerCase().trim(), pass_hash, r, s]);
  return rows[0];
}

async function getUserByEmail(email) {
  if (!enabled) return null;
  const { rows } = await pool.query(
    'SELECT id, email, pass_hash, role, status, token_version FROM users WHERE email=$1',
    [String(email).toLowerCase().trim()]);
  return rows[0] || null;
}

async function getUserById(id) {
  if (!enabled) return null;
  const { rows } = await pool.query(
    'SELECT id, email, role, status, token_version FROM users WHERE id=$1', [id]);
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
    `UPDATE users SET ${sets.join(', ')}, token_version=token_version+1 WHERE id=$${i}
     RETURNING id, email, role, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`, vals);
  return rows[0] || null;
}

async function setUserPassword(id, pass_hash) {
  if (!enabled) return false;
  await pool.query(
    'UPDATE users SET pass_hash=$2, token_version=token_version+1 WHERE id=$1',
    [id, pass_hash]);
  return true;
}

async function revokeUserSessions(id) {
  if (!enabled || id == null) return false;
  const { rowCount } = await pool.query(
    'UPDATE users SET token_version=token_version+1 WHERE id=$1', [id]);
  return rowCount > 0;
}

async function setUserStatus(id, status) {
  if (!enabled) return null;
  if (!USER_STATUSES.includes(status)) throw new Error('bad status');
  const { rows } = await pool.query(
    `UPDATE users SET status=$2, token_version=token_version+1
      WHERE id=$1 RETURNING id, email, role, status, token_version`, [id, status]);
  return rows[0] || null;
}

// ── Email tokens (verify / reset) ─────────────────────────────────
// Issuing a new token of a kind invalidates the user's prior unused ones of that
// kind, so only the latest emailed link works.
async function createEmailToken(uid, kind, tokenHash, expiresAt) {
  if (!enabled) return null;
  // Per-account cooldown (independent of IP rate-limit): at most one email per
  // minute per uid+kind → blocks email-bombing a victim / burning the send quota.
  const recent = await pool.query(
    "SELECT 1 FROM email_tokens WHERE uid=$1 AND kind=$2 AND created_at > now() - interval '60 seconds' LIMIT 1", [uid, kind]);
  if (recent.rows.length) return null;
  await pool.query('UPDATE email_tokens SET used_at=now() WHERE uid=$1 AND kind=$2 AND used_at IS NULL', [uid, kind]);
  const { rows } = await pool.query(
    'INSERT INTO email_tokens (uid, kind, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id',
    [uid, kind, tokenHash, expiresAt]);
  return rows[0] ? rows[0].id : null;
}

// Atomically consume a token: single-use + expiry enforced in one UPDATE … RETURNING,
// so concurrent double-clicks can't both succeed. Returns { uid } or null.
async function useEmailToken(tokenHash, kind) {
  if (!enabled) return null;
  const { rows } = await pool.query(
    `UPDATE email_tokens SET used_at=now()
       WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now()
       RETURNING uid`, [tokenHash, kind]);
  return rows[0] ? { uid: rows[0].uid } : null;
}

// ── Channels (collector onboarding) + API keys + snapshot — Sprint 1C ──
async function createChannel({ owner_uid, username, title }) {
  if (!enabled || owner_uid == null) return null;
  const uname = String(username || '').replace(/^@/, '').trim();
  const { rows } = await pool.query(
    `INSERT INTO channels (owner_uid, username, title, status, source)
     VALUES ($1,$2,$3,'active','collector') RETURNING ${CHANNEL_COLS}`,
    [owner_uid, uname || null, title || uname || null]);
  return rows[0] || null;
}

// Delete a channel the user owns (cascades data/keys/snapshot). Never the central one.
async function deleteChannel(id, uid) {
  if (!enabled || !id || uid == null) return false;
  const { rowCount } = await pool.query(
    "DELETE FROM channels WHERE id=$1 AND owner_uid=$2 AND source<>'central'", [id, uid]);
  return rowCount > 0;
}

async function createApiKey(channelId, keyHash, keyPrefix, label) {
  if (!enabled || !channelId) return null;
  const { rows } = await pool.query(
    `INSERT INTO api_keys (channel_id, key_hash, key_prefix, label) VALUES ($1,$2,$3,$4)
     RETURNING id, key_prefix, label, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
    [channelId, keyHash, keyPrefix, label || null]);
  return rows[0] || null;
}

// Authenticate a collector by API-key hash → the channel row (active key only).
// Atomically touches last_used_at. Returns the channel or null.
async function getChannelByApiKey(keyHash) {
  if (!enabled) return null;
  const { rows } = await pool.query(
    'UPDATE api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL RETURNING channel_id', [keyHash]);
  return rows[0] ? getChannelById(rows[0].channel_id) : null;
}

// Keys of a channel the user owns (ownership enforced via the join).
async function listApiKeys(channelId, uid) {
  if (!enabled || !channelId || uid == null) return [];
  const { rows } = await pool.query(
    `SELECT k.id, k.key_prefix, k.label,
            to_char(k.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
            to_char(k.last_used_at,'YYYY-MM-DD"T"HH24:MI:SS') AS last_used_at,
            (k.revoked_at IS NOT NULL) AS revoked
       FROM api_keys k JOIN channels c ON c.id=k.channel_id
      WHERE k.channel_id=$1 AND c.owner_uid=$2 ORDER BY k.created_at DESC`, [channelId, uid]);
  return rows;
}

async function revokeApiKey(keyId, uid) {
  if (!enabled || !keyId || uid == null) return false;
  const { rowCount } = await pool.query(
    `UPDATE api_keys k SET revoked_at=now() FROM channels c
      WHERE k.id=$1 AND k.channel_id=c.id AND c.owner_uid=$2 AND k.revoked_at IS NULL`, [keyId, uid]);
  return rowCount > 0;
}

async function saveSnapshot(channelId, data, executor = pool) {
  if (!enabled || !channelId || !data) return false;
  await executor.query(
    `INSERT INTO channel_snapshots (channel_id, data, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (channel_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [channelId, data]);
  return true;
}

async function getSnapshot(channelId) {
  if (!enabled || !channelId) return null;
  const { rows } = await pool.query(
    `SELECT data, to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
       FROM channel_snapshots WHERE channel_id=$1`, [channelId]);
  return rows[0] || null;   // { data, updated_at } | null
}

/* Atomically accept a collector delivery. The receipt, current snapshot and all
   normalized archives commit together, so the dashboard never observes a new
   snapshot with only half of its history written. */
async function ingestCollectorPayload(channelId, meta, data) {
  if (!enabled || !channelId) throw new Error('database unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO ingest_receipts
        (channel_id, ingest_id, schema_version, collector_version, collected_at, payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (channel_id, ingest_id) DO NOTHING
       RETURNING status, result, payload_hash`,
      [channelId, meta.ingest_id, meta.schema_version, meta.collector_version,
        meta.collected_at, meta.payload_hash]);

    if (!inserted.rows.length) {
      const prior = await client.query(
        `SELECT status, result, payload_hash FROM ingest_receipts
          WHERE channel_id=$1 AND ingest_id=$2 FOR UPDATE`,
        [channelId, meta.ingest_id]);
      const receipt = prior.rows[0];
      if (!receipt || receipt.payload_hash !== meta.payload_hash) {
        const error = new Error('ingest_id already used with a different payload');
        error.code = 'INGEST_ID_CONFLICT';
        throw error;
      }
      if (receipt.status === 'completed') {
        await client.query('COMMIT');
        return { ...(receipt.result || {}), duplicate: true };
      }
      await client.query(
        `UPDATE ingest_receipts
            SET status='processing', error=NULL, received_at=now()
          WHERE channel_id=$1 AND ingest_id=$2`,
        [channelId, meta.ingest_id]);
    }

    await saveSnapshot(channelId, data.snapshot, client);
    const nDaily = await upsertChannelDaily(channelId, data.dailyRows, client);
    const nPosts = await upsertPosts(channelId, data.postRows, client);
    const nMentions = await upsertMentions(channelId, data.mentions, client);
    let velocityOk = false;
    if (data.velocity && data.velocity.available) {
      await saveVelocity(channelId, data.velocity, client);
      velocityOk = true;
    }
    if (data.tgChannelId != null) await setChannelTgId(channelId, data.tgChannelId, client);

    const result = {
      ok: true,
      channel_id: channelId,
      ingest_id: meta.ingest_id,
      schema_version: meta.schema_version,
      snapshot: true,
      channel_daily: nDaily,
      posts: nPosts,
      velocity: velocityOk,
      mentions: nMentions,
    };
    await client.query(
      `UPDATE ingest_receipts
          SET status='completed', completed_at=now(), result=$3, error=NULL
        WHERE channel_id=$1 AND ingest_id=$2`,
      [channelId, meta.ingest_id, result]);
    await client.query(
      `INSERT INTO collector_status
        (channel_id, collector_version, last_ingest_id, last_attempt_at, last_success_at, last_error)
       VALUES ($1,$2,$3,now(),now(),NULL)
       ON CONFLICT (channel_id) DO UPDATE SET
         collector_version=EXCLUDED.collector_version,
         last_ingest_id=EXCLUDED.last_ingest_id,
         last_attempt_at=now(), last_success_at=now(), last_error=NULL, updated_at=now()`,
      [channelId, meta.collector_version, meta.ingest_id]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error.code !== 'INGEST_ID_CONFLICT') {
      const message = String(error.message || error).slice(0, 1000);
      await pool.query(
        `INSERT INTO ingest_receipts
          (channel_id, ingest_id, schema_version, collector_version, collected_at,
           payload_hash, status, completed_at, error)
         VALUES ($1,$2,$3,$4,$5,$6,'failed',now(),$7)
         ON CONFLICT (channel_id, ingest_id) DO UPDATE SET
           status='failed', completed_at=now(), error=EXCLUDED.error
         WHERE ingest_receipts.status <> 'completed'`,
        [channelId, meta.ingest_id, meta.schema_version, meta.collector_version,
          meta.collected_at, meta.payload_hash, message]).catch(() => {});
      await pool.query(
        `INSERT INTO collector_status
          (channel_id, collector_version, last_ingest_id, last_attempt_at, last_error)
         VALUES ($1,$2,$3,now(),$4)
         ON CONFLICT (channel_id) DO UPDATE SET
           collector_version=EXCLUDED.collector_version,
           last_ingest_id=EXCLUDED.last_ingest_id,
           last_attempt_at=now(), last_error=EXCLUDED.last_error, updated_at=now()`,
        [channelId, meta.collector_version, meta.ingest_id, message]).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getCollectorStatus(channelId, user) {
  if (!enabled || !channelId || !user || user.uid == null) return null;
  const { rows } = await pool.query(
    `SELECT s.collector_version, s.last_ingest_id,
            to_char(s.last_attempt_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_attempt_at,
            to_char(s.last_success_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS last_success_at,
            s.last_error
       FROM collector_status s
       JOIN channels c ON c.id=s.channel_id
      WHERE s.channel_id=$1 AND c.owner_uid=$2`,
    [channelId, user.uid]);
  return rows[0] || null;
}

async function recordAuditEvent({ uid = null, channel_id = null, action, request_id = null, ip_hash = null, metadata = {} }) {
  if (!enabled || !action) return false;
  await pool.query(
    `INSERT INTO audit_events (uid, channel_id, action, request_id, ip_hash, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [uid, channel_id, String(action).slice(0, 100), request_id, ip_hash, metadata]);
  return true;
}

/* ── Персональная раскладка дашборда ─────────────────────────────
   Возвращает сохранённый объект prefs (или null, если ничего нет /
   нет БД / гость без аккаунта). Запись — upsert по uid. */
async function getPrefs(uid) {
  if (!enabled || uid == null) return null;
  const { rows } = await pool.query('SELECT prefs FROM user_prefs WHERE uid=$1', [uid]);
  return rows[0] ? rows[0].prefs : null;
}

async function setPrefs(uid, prefs) {
  if (!enabled || uid == null) return false;
  await pool.query(
    `INSERT INTO user_prefs (uid, prefs, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (uid) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [uid, prefs]
  );
  return true;
}

/* ── Velocity snapshot (жизнь поста) ─────────────────────────────
   Сохраняем готовый объект /velocity целиком (форма не меняется), upsert по
   текущему дню. Чтение — самый свежий день. Пустые/недоступные снимки не
   пишем (guard в вызывающем коде), чтобы не затирать хороший снапшот. */
async function saveVelocity(channelId, data, executor = pool) {
  if (!enabled || !channelId || !data) return false;
  await executor.query(
    `INSERT INTO velocity_daily (channel_id, day, data, computed_at) VALUES ($1, CURRENT_DATE, $2, now())
     ON CONFLICT (channel_id, day) DO UPDATE SET data = EXCLUDED.data, computed_at = now()`,
    [channelId, data]);
  return true;
}

async function getLatestVelocity(channelId) {
  if (!enabled || !channelId) return null;
  const { rows } = await pool.query(
    `SELECT data, to_char(computed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS computed_at
       FROM velocity_daily WHERE channel_id=$1 ORDER BY day DESC LIMIT 1`, [channelId]);
  return rows[0] || null;   // { data, computed_at } | null
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

// ── Instagram accounts (per-channel OAuth connection) ─────────────
// One IG professional account per channel. The access token is stored already-encrypted
// (callers encrypt via lib/ig_crypto before persisting) — db.js never sees plaintext.
async function saveIgAccount(channelId, { ig_user_id, username, access_token_enc, token_expires_at, scopes }) {
  if (!enabled || !channelId) return false;
  await pool.query(
    `INSERT INTO ig_accounts (channel_id, ig_user_id, username, access_token_enc, token_expires_at, scopes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (channel_id) DO UPDATE SET
       ig_user_id=EXCLUDED.ig_user_id, username=EXCLUDED.username,
       access_token_enc=EXCLUDED.access_token_enc, token_expires_at=EXCLUDED.token_expires_at,
       scopes=EXCLUDED.scopes, updated_at=now()`,
    [channelId, ig_user_id, username || null, access_token_enc, token_expires_at || null, scopes || null]);
  return true;
}

// Full row incl. the encrypted token (callers decrypt). Returns null when not connected.
async function getIgAccount(channelId) {
  if (!enabled || !channelId) return null;
  const { rows } = await pool.query(
    `SELECT channel_id, ig_user_id, username, access_token_enc, scopes,
            to_char(token_expires_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS token_expires_at,
            to_char(connected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at
       FROM ig_accounts WHERE channel_id=$1`, [channelId]);
  return rows[0] || null;
}

// Refresh path: rotate the encrypted token + expiry without touching identity columns.
async function updateIgToken(channelId, access_token_enc, token_expires_at) {
  if (!enabled || !channelId) return false;
  await pool.query(
    'UPDATE ig_accounts SET access_token_enc=$2, token_expires_at=$3, updated_at=now() WHERE channel_id=$1',
    [channelId, access_token_enc, token_expires_at || null]);
  return true;
}

async function deleteIgAccount(channelId) {
  if (!enabled || !channelId) return false;
  const { rowCount } = await pool.query('DELETE FROM ig_accounts WHERE channel_id=$1', [channelId]);
  return rowCount > 0;
}

module.exports = {
  enabled, init, migrate, ping, close, graphsToDailyRows,
  USER_ROLES, USER_STATUSES,
  countUsers, createUser, getUserByEmail, getUserById, listUsers, updateUser, setUserPassword,
  revokeUserSessions, setUserStatus, createEmailToken, useEmailToken,
  getPrefs, setPrefs,
  adoptOwnerChannel, listChannels, getChannel, getChannelById, getOwnerChannelId, setChannelTgId,
  createChannel, deleteChannel, createApiKey, getChannelByApiKey, listApiKeys, revokeApiKey,
  saveSnapshot, getSnapshot, ingestCollectorPayload, getCollectorStatus, recordAuditEvent,
  saveVelocity, getLatestVelocity,
  upsertChannelDaily, upsertPosts, upsertMentions,
  getChannelHistory, getMentionsHistory, getMentionsArchive,
  createBug, listBugs, updateBug, deleteBug, BUG_STATUSES, BUG_SEVERITIES, BUG_KINDS,
  bugExists, getBug, addAttachmentIfRoom, getAttachment,
  saveIgAccount, getIgAccount, updateIgToken, deleteIgAccount,
};
