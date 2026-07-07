// ═══════════════════════════════════════════════════════════════
//  Atlavue — история в Postgres (Railway)
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

  // Pool ceiling is the first infrastructure knob under load (ops/PERF_BASELINE.md): 4 keeps a
  // hobby Railway PG comfortable; raise via env (e.g. 8-10) as concurrent users grow.
  pool = new Pool({ connectionString: DATABASE_URL, ssl, max: Number(process.env.PGPOOL_MAX) || 4 });
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
  // Canonicalise the freshly-adopted central channel too (workspace now; tg source when its
  // platform id is already known — otherwise setChannelTgId stamps it on discovery).
  const { rows } = await pool.query(
    `SELECT id, tg_channel_id, username, title FROM channels WHERE owner_uid=$1 AND source='central'`, [adminUid]);
  if (rows[0]) {
    await ensureChannelCanonical(rows[0].id, adminUid, rows[0].tg_channel_id != null
      ? { network: 'tg', externalId: rows[0].tg_channel_id, username: rows[0].username, title: rows[0].title }
      : {});
  }
  return true;
}

const CHANNEL_COLS = 'id, username, title, status, source, tg_channel_id, owner_uid';

// Channels visible to a user (every session maps to a users row with a numeric uid).
// Latest known subscriber count per channel (cheap: newest daily row). Canonical per ADR-001:
// any row of the channel's SOURCE counts (two workspaces following one @channel share history),
// falling back to channel-scoped rows for links without a source yet.
const MEMBER_COUNT_COL =
  `(SELECT cd.subscribers FROM channel_daily cd
      WHERE ((channels.source_id IS NOT NULL AND cd.source_id = channels.source_id)
             OR cd.channel_id = channels.id)
        AND cd.subscribers IS NOT NULL
      ORDER BY cd.day DESC, cd.captured_at DESC NULLS LAST LIMIT 1) AS "memberCount"`;

// Access boundary (ADR-001): a channel is visible to its creator (legacy owner_uid — also covers
// pre-workspace rows like the bootstrap central channel) OR to any member of its workspace.
const CHANNEL_ACCESS_PREDICATE =
  `(channels.owner_uid = $UID
    OR (channels.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = channels.workspace_id AND m.uid = $UID)))`;

const CHANNEL_ADMIN_ACCESS_PREDICATE =
  `(c.owner_uid = $UID
    OR (c.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members m
          WHERE m.workspace_id = c.workspace_id
            AND m.uid = $UID
            AND m.role IN ('owner', 'admin'))))`;

async function listChannels(user) {
  if (!enabled) return [];
  const uid = user && user.uid;
  if (uid == null) return [];   // defensive: never query ownership with a missing uid
  const { rows } = await pool.query(
    `SELECT ${CHANNEL_COLS}, ${MEMBER_COUNT_COL},
            EXISTS(SELECT 1 FROM ig_accounts ia WHERE ia.channel_id = channels.id) AS ig_connected
     FROM channels
     WHERE ${CHANNEL_ACCESS_PREDICATE.replaceAll('$UID', '$1')} AND status<>'disabled'
     ORDER BY created_at ASC`, [uid]);
  return rows;
}

// Membership-checked fetch: returns the channel row only if the user may access it (creator or
// workspace member), plus their effective role for write-gates. Routes turn null → 403.
async function getChannel(id, user) {
  if (!enabled || !id) return null;
  const uid = user && user.uid;
  if (uid == null) return null;   // defensive: never query ownership with a missing uid
  // listChannels hides disabled channels — a direct ?channel=<id> must not bypass that.
  const { rows } = await pool.query(
    `SELECT ${CHANNEL_COLS},
            CASE WHEN channels.owner_uid = $2 THEN 'owner'
                 ELSE (SELECT m.role FROM workspace_members m
                       WHERE m.workspace_id = channels.workspace_id AND m.uid = $2)
            END AS member_role
     FROM channels
     WHERE id=$1 AND ${CHANNEL_ACCESS_PREDICATE.replaceAll('$UID', '$2')} AND status<>'disabled'`,
    [id, uid]);
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
  const upd = await executor.query(`UPDATE channels SET tg_channel_id=$2 WHERE id=$1 AND tg_channel_id IS NULL`, [id, tgId]);
  // Canonicalise when the platform identity just became known — and short-circuit on the hot
  // path: this runs on EVERY collector ingest, so an already-stamped channel must cost one SELECT,
  // not a shared external_sources write (which would briefly serialize tenants of one source).
  const { rows } = await executor.query(
    `SELECT owner_uid, username, title, workspace_id, source_id FROM channels WHERE id=$1`, [id]);
  const row = rows[0];
  if (row && (upd.rowCount > 0 || row.workspace_id == null || row.source_id == null)) {
    // Same executor all the way down — see ensureChannelCanonical's executor-discipline note.
    await ensureChannelCanonical(id, row.owner_uid, {
      network: 'tg', externalId: tgId, username: row.username, title: row.title,
    }, executor);
  }
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
      (channel_id, source_id, day, subscribers, joins, leaves, views, forwards, reactions, captured_at)
    SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1),
           x.day::date, x.subscribers, x.joins, x.leaves, x.views, x.forwards, x.reactions, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        day text, subscribers integer, joins integer, leaves integer,
        views integer, forwards integer, reactions integer
      )
    ON CONFLICT (channel_id, day) DO UPDATE SET
      source_id=COALESCE(EXCLUDED.source_id, channel_daily.source_id),
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
      (channel_id, source_id, post_id, date_published, views, reactions, forwards, replies,
       erv, virality, media_type, caption, hashtags, updated_at)
    SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1),
           x.post_id, x.date_published, x.views, x.reactions, x.forwards, x.replies,
           x.erv, x.virality, x.media_type, x.caption, x.hashtags, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        post_id bigint, date_published timestamptz, views integer, reactions integer,
        forwards integer, replies integer, erv numeric, virality numeric,
        media_type text, caption text, hashtags jsonb
      )
    ON CONFLICT (channel_id, post_id) DO UPDATE SET
      source_id=COALESCE(EXCLUDED.source_id, posts.source_id),
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
      (owner_channel_id, source_id, channel_id, msg_id, post_date, first_seen, last_seen,
       title, username, link, snippet, views, query)
    SELECT $1, (SELECT c.source_id FROM channels c WHERE c.id = $1),
           x.channel_id, x.msg_id, x.date, now(), now(),
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
  // Canonical read (ADR-001 phase B): the history of the channel's SOURCE — two workspaces
  // following one @channel see ONE row-set. Until phase C flips the write conflict-targets, both
  // links may still write their own rows, so DISTINCT ON (day) keeps the freshest capture. Links
  // without a source fall back to their own channel-scoped rows.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (d.day)
            to_char(d.day,'YYYY-MM-DD') AS day, d.subscribers, d.joins, d.leaves, d.views, d.forwards, d.reactions
     FROM channel_daily d
     JOIN channels c ON c.id = $1
     WHERE ((c.source_id IS NOT NULL AND d.source_id = c.source_id) OR d.channel_id = c.id)
       AND d.day >= (CURRENT_DATE - $2::int)
     ORDER BY d.day ASC, d.captured_at DESC NULLS LAST`, [channelId, days]);
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

// Avatar kept off getUserById (which runs on every auth lookup) — fetched only when /me asks.
async function getUserAvatar(id) {
  if (!enabled) return null;
  const { rows } = await pool.query('SELECT avatar_url FROM users WHERE id=$1', [id]);
  return rows[0] ? rows[0].avatar_url : null;
}
async function setUserAvatar(id, dataUrl) {
  if (!enabled) return;
  await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [dataUrl, id]);
}

// Instagram tags (media where we're @-tagged) — archive so they persist past the live edge's window.
async function upsertIgTags(rows) {
  if (!enabled || !rows || !rows.length) return 0;
  let n = 0;
  for (const r of rows) {
    if (!r || !r.id) continue;
    await pool.query(
      `INSERT INTO ig_tags (media_id, username, caption, permalink, media_type, like_count, comments_count, posted_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (media_id) DO UPDATE SET
         username=EXCLUDED.username, caption=EXCLUDED.caption, permalink=EXCLUDED.permalink,
         media_type=EXCLUDED.media_type, like_count=EXCLUDED.like_count,
         comments_count=EXCLUDED.comments_count, posted_at=EXCLUDED.posted_at, last_seen=now()`,
      [String(r.id), r.username || null, r.caption || null, r.permalink || null, r.media_type || null,
       r.like_count != null ? Number(r.like_count) : null, r.comments_count != null ? Number(r.comments_count) : null,
       r.timestamp || null],
    );
    n++;
  }
  return n;
}
async function getIgTags(limit = 100) {
  if (!enabled) return [];
  const { rows } = await pool.query(
    `SELECT media_id AS id, username, caption, permalink, media_type, like_count, comments_count,
            to_char(posted_at,'YYYY-MM-DD"T"HH24:MI:SS') AS timestamp,
            to_char(first_seen,'YYYY-MM-DD"T"HH24:MI:SS') AS first_seen
     FROM ig_tags ORDER BY posted_at DESC NULLS LAST, first_seen DESC LIMIT $1`, [limit]);
  return rows;
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

// ── Canonical wiring for NEW rows (ADR-001; the 010 backfill covers pre-existing ones) ─────────

// The creator's personal workspace, created on first need. Backfill 010 seeds one per existing
// user; this covers users registered after the migration and keeps creation paths one-call simple.
async function ensurePersonalWorkspace(uid, executor = pool) {
  if (!enabled || uid == null) return null;
  const found = await executor.query(`SELECT id FROM workspaces WHERE owner_uid=$1 ORDER BY id LIMIT 1`, [uid]);
  if (found.rows[0]) return found.rows[0].id;
  const { rows } = await executor.query(
    `INSERT INTO workspaces (name, owner_uid)
     SELECT split_part(u.email,'@',1), u.id FROM users u WHERE u.id=$1
     RETURNING id`, [uid]);
  const wsId = rows[0] ? rows[0].id : null;
  if (wsId) {
    await executor.query(
      `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1,$2,'owner')
       ON CONFLICT (workspace_id, uid) DO NOTHING`, [wsId, uid]);
  }
  return wsId;
}

// Find-or-create the deduplicated identity of an external property.
async function ensureExternalSource(network, externalId, { username, title } = {}, executor = pool) {
  if (!enabled || !network || externalId == null) return null;
  // Existing metadata WINS (fill NULLs only): the source row is shared across workspaces, so the
  // last-ingesting link must not keep overwriting the canonical username/title (metadata bleed).
  const { rows } = await executor.query(
    `INSERT INTO external_sources (network, external_id, username, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (network, external_id) DO UPDATE SET
       username = COALESCE(external_sources.username, EXCLUDED.username),
       title    = COALESCE(external_sources.title, EXCLUDED.title)
     RETURNING id`,
    [network, String(externalId), username || null, title || null]);
  return rows[0] ? rows[0].id : null;
}

// Stamp a channel row with its workspace (creator's personal one) and, when the platform identity
// is already known, its canonical source. Fills NULLs only — never re-homes an existing link.
// EXECUTOR DISCIPLINE: every query runs on the caller's executor. A pool.query here while the
// caller holds the row inside an open transaction (collector ingest → setChannelTgId) would block
// on the caller's own row lock forever — a self-deadlock Postgres cannot detect (the tx connection
// is idle-in-transaction, not lock-waiting), and with a small pool it starves the whole API.
async function ensureChannelCanonical(channelId, ownerUid, { network, externalId, username, title } = {}, executor = pool) {
  if (!enabled || !channelId) return;
  const wsId = await ensurePersonalWorkspace(ownerUid, executor);
  if (wsId) {
    await executor.query(`UPDATE channels SET workspace_id=$2 WHERE id=$1 AND workspace_id IS NULL`, [channelId, wsId]);
  }
  if (network && externalId != null) {
    const srcId = await ensureExternalSource(network, externalId, { username, title }, executor);
    if (srcId) {
      await executor.query(`UPDATE channels SET source_id=$2 WHERE id=$1 AND source_id IS NULL`, [channelId, srcId]);
    }
  }
}

// ── Channels (collector onboarding) + API keys + snapshot — Sprint 1C ──
async function createChannel({ owner_uid, username, title }) {
  if (!enabled || owner_uid == null) return null;
  const uname = String(username || '').replace(/^@/, '').trim();
  const { rows } = await pool.query(
    `INSERT INTO channels (owner_uid, username, title, status, source)
     VALUES ($1,$2,$3,'active','collector') RETURNING ${CHANNEL_COLS}`,
    [owner_uid, uname || null, title || uname || null]);
  const row = rows[0] || null;
  // Workspace now; the canonical source is stamped later, when the platform id becomes known
  // (setChannelTgId for collector channels).
  if (row) await ensureChannelCanonical(row.id, owner_uid);
  return row;
}

// Standalone Instagram source — a channels row not backed by any Telegram channel
// (source='ig', no tg_channel_id). Callers dedup by identity FIRST (findIgChannelByIgUser)
// so reconnecting the same IG account refreshes its token instead of duplicating the source.
async function createIgChannel({ owner_uid, username }) {
  if (!enabled || owner_uid == null) return null;
  const uname = String(username || '').replace(/^@/, '').trim();
  const { rows } = await pool.query(
    `INSERT INTO channels (owner_uid, username, title, status, source)
     VALUES ($1,$2,$3,'active','ig') RETURNING ${CHANNEL_COLS}`,
    [owner_uid, uname || null, uname || 'Instagram']);
  const row = rows[0] || null;
  // Workspace now; the IG canonical source lands in saveIgAccount (ig_user_id known there).
  if (row) await ensureChannelCanonical(row.id, owner_uid);
  return row;
}

// The user's channel already holding this Instagram identity (multi-account reconnect dedup).
async function findIgChannelByIgUser(uid, igUserId) {
  if (!enabled || uid == null || !igUserId) return null;
  const { rows } = await pool.query(
    `SELECT c.id FROM channels c JOIN ig_accounts ia ON ia.channel_id = c.id
     WHERE c.owner_uid=$1 AND ia.ig_user_id=$2 AND c.status<>'disabled' LIMIT 1`,
    [uid, String(igUserId)]);
  return rows[0] ? rows[0].id : null;
}

// Create/adopt a QR-connected channel (source='qr'). Idempotent per (owner_uid, tg_channel_id)
// via the partial unique index — re-adding after a re-scan just refreshes title/username and
// re-activates it, never duplicates. The captured tg_sessions row (same owner_uid) feeds it.
async function createTgChannel({ owner_uid, tg_channel_id, username, title }) {
  if (!enabled || owner_uid == null || tg_channel_id == null) return null;
  const uname = String(username || '').replace(/^@/, '').trim();
  const { rows } = await pool.query(
    `INSERT INTO channels (owner_uid, tg_channel_id, username, title, status, source)
     VALUES ($1,$2,$3,$4,'active','qr')
     ON CONFLICT (owner_uid, tg_channel_id) WHERE tg_channel_id IS NOT NULL
     DO UPDATE SET username=COALESCE(EXCLUDED.username, channels.username),
                   title=COALESCE(EXCLUDED.title, channels.title),
                   status='active'
     RETURNING ${CHANNEL_COLS}`,
    [owner_uid, tg_channel_id, uname || null, title || uname || null]);
  const row = rows[0] || null;
  if (row) {
    await ensureChannelCanonical(row.id, owner_uid, {
      network: 'tg', externalId: tg_channel_id, username: uname || null, title: title || uname || null,
    });
  }
  return row;
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

// Keys of a channel the caller can administer (workspace owner/admin or legacy creator).
async function listApiKeys(channelId, uid) {
  if (!enabled || !channelId || uid == null) return [];
  const { rows } = await pool.query(
    `SELECT k.id, k.key_prefix, k.label,
            to_char(k.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
            to_char(k.last_used_at,'YYYY-MM-DD"T"HH24:MI:SS') AS last_used_at,
            (k.revoked_at IS NOT NULL) AS revoked
       FROM api_keys k JOIN channels c ON c.id=k.channel_id
      WHERE k.channel_id=$1 AND ${CHANNEL_ADMIN_ACCESS_PREDICATE.replaceAll('$UID', '$2')}
      ORDER BY k.created_at DESC`, [channelId, uid]);
  return rows;
}

async function revokeApiKey(keyId, channelId, uid) {
  if (!enabled || !keyId || !channelId || uid == null) return false;
  const { rowCount } = await pool.query(
    `UPDATE api_keys k SET revoked_at=now() FROM channels c
      WHERE k.id=$1
        AND k.channel_id=$2
        AND k.channel_id=c.id
        AND ${CHANNEL_ADMIN_ACCESS_PREDICATE.replaceAll('$UID', '$3')}
        AND k.revoked_at IS NULL`, [keyId, channelId, uid]);
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
      WHERE s.channel_id=$1 AND ${CHANNEL_ACCESS_PREDICATE.replaceAll('channels.', 'c.').replaceAll('$UID', '$2')}`,
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
   нет БД). Запись — upsert по uid. */
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
    `INSERT INTO velocity_daily (channel_id, source_id, day, data, computed_at)
     VALUES ($1, (SELECT c.source_id FROM channels c WHERE c.id = $1), CURRENT_DATE, $2, now())
     ON CONFLICT (channel_id, day) DO UPDATE SET
       source_id = COALESCE(EXCLUDED.source_id, velocity_daily.source_id),
       data = EXCLUDED.data, computed_at = now()`,
    [channelId, data]);
  return true;
}

async function getLatestVelocity(channelId) {
  if (!enabled || !channelId) return null;
  // Canonical read (ADR-001): freshest snapshot of the channel's source, own rows as fallback.
  const { rows } = await pool.query(
    `SELECT v.data, to_char(v.computed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS computed_at
       FROM velocity_daily v
       JOIN channels c ON c.id = $1
      WHERE ((c.source_id IS NOT NULL AND v.source_id = c.source_id) OR v.channel_id = c.id)
      ORDER BY v.day DESC, v.computed_at DESC NULLS LAST LIMIT 1`, [channelId]);
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

// ── Instagram accounts (per-channel OAuth connection) ─────────────
// One IG professional account per channel. The access token is stored already-encrypted
// (callers encrypt via lib/ig_crypto before persisting) — db.js never sees plaintext.
async function saveIgAccount(channelId, { ig_user_id, username, access_token_enc, token_expires_at, scopes }) {
  if (!enabled || !channelId) return false;
  // Canonical IG source (ADR-001): find-or-create by ig_user_id and stamp the account row; a
  // standalone IG channel (source='ig', no TG identity) also carries it as its channel source.
  const srcId = await ensureExternalSource('ig', ig_user_id, { username });
  await pool.query(
    `INSERT INTO ig_accounts (channel_id, ig_user_id, username, access_token_enc, token_expires_at, scopes, source_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (channel_id) DO UPDATE SET
       ig_user_id=EXCLUDED.ig_user_id, username=EXCLUDED.username,
       access_token_enc=EXCLUDED.access_token_enc, token_expires_at=EXCLUDED.token_expires_at,
       scopes=EXCLUDED.scopes, source_id=COALESCE(EXCLUDED.source_id, ig_accounts.source_id), updated_at=now()`,
    [channelId, ig_user_id, username || null, access_token_enc, token_expires_at || null, scopes || null, srcId]);
  await pool.query(
    `UPDATE channels SET source_id=$2 WHERE id=$1 AND source_id IS NULL AND tg_channel_id IS NULL AND source='ig'`,
    [channelId, srcId]);
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

// Every connected IG account (any channel — central OR collector), incl. the encrypted
// token so a trusted cron can decrypt + fetch. NO ownership filter (unlike getIgAccount's
// single-channel scope): the daily persistence cron iterates ALL rows. Callers decrypt.
async function listIgAccounts() {
  if (!enabled) return [];
  const { rows } = await pool.query(
    `SELECT channel_id, ig_user_id, username, access_token_enc, scopes,
            to_char(token_expires_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS token_expires_at
       FROM ig_accounts ORDER BY channel_id ASC`);
  return rows;
}

// ── Telegram QR sessions (managed connect) ───────────────────────────
// One encrypted user session per account (callers encrypt via lib/tg_crypto — db.js never sees
// plaintext). Covers every channel where that user is an admin; QR-connected channels reach it
// via owner_uid. A StringSession = full account access, so this is the most sensitive row.
async function saveTgSession(uid, { tg_user_id, username, session_enc }) {
  if (!enabled || !uid) return false;
  await pool.query(
    `INSERT INTO tg_sessions (uid, tg_user_id, username, session_enc, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (uid) DO UPDATE SET
       tg_user_id=EXCLUDED.tg_user_id, username=EXCLUDED.username,
       session_enc=EXCLUDED.session_enc, updated_at=now()`,
    [uid, tg_user_id || null, username || null, session_enc]);
  return true;
}

// Full row incl. the encrypted session (callers decrypt). Returns null when not connected.
async function getTgSession(uid) {
  if (!enabled || !uid) return null;
  const { rows } = await pool.query(
    `SELECT uid, tg_user_id, username, session_enc,
            to_char(connected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS connected_at
       FROM tg_sessions WHERE uid=$1`, [uid]);
  return rows[0] || null;
}

async function deleteTgSession(uid) {
  if (!enabled || !uid) return false;
  const { rowCount } = await pool.query('DELETE FROM tg_sessions WHERE uid=$1', [uid]);
  return rowCount > 0;
}

// Every stored session (encrypted). Internal use only (the daily cron decrypts each to collect that
// user's QR-connected channels). Never expose session_enc outside the server.
async function listTgSessions() {
  if (!enabled) return [];
  const { rows } = await pool.query(
    `SELECT uid, tg_user_id, username, session_enc FROM tg_sessions`);
  return rows;
}

// ── История Instagram + сырые снапшоты (accumulate-now) ──────────────
// Мы копим историю САМИ, потому что IG отдаёт только короткое окно (сторис 24ч,
// демография без истории). Идиомы — как upsertChannelDaily/graphsToDailyRows:
// multi-row VALUES через jsonb_to_recordset + ON CONFLICT, все счётчики nullable
// с COALESCE(EXCLUDED.x, existing), чтобы повторный прогон дополнял, а не затирал.

// Дневные метрики IG-аккаунта. rows: [{ day, followers, reach, views, profile_views,
// accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows }].
async function upsertIgDaily(channelId, rows, executor = pool) {
  if (!enabled || !channelId || !rows || !rows.length) return 0;
  const sql = `INSERT INTO ig_daily
      (channel_id, source_id, day, followers, reach, views, profile_views, accounts_engaged,
       total_interactions, likes, comments, saves, shares, follows, unfollows, captured_at)
    SELECT $1, (SELECT a.source_id FROM ig_accounts a WHERE a.channel_id = $1),
           x.day::date, x.followers, x.reach, x.views, x.profile_views, x.accounts_engaged,
           x.total_interactions, x.likes, x.comments, x.saves, x.shares, x.follows, x.unfollows, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        day text, followers integer, reach integer, views integer, profile_views integer,
        accounts_engaged integer, total_interactions integer, likes integer, comments integer,
        saves integer, shares integer, follows integer, unfollows integer
      )
    ON CONFLICT (channel_id, day) DO UPDATE SET
      source_id=COALESCE(EXCLUDED.source_id, ig_daily.source_id),
      followers=COALESCE(EXCLUDED.followers, ig_daily.followers),
      reach=COALESCE(EXCLUDED.reach, ig_daily.reach),
      views=COALESCE(EXCLUDED.views, ig_daily.views),
      profile_views=COALESCE(EXCLUDED.profile_views, ig_daily.profile_views),
      accounts_engaged=COALESCE(EXCLUDED.accounts_engaged, ig_daily.accounts_engaged),
      total_interactions=COALESCE(EXCLUDED.total_interactions, ig_daily.total_interactions),
      likes=COALESCE(EXCLUDED.likes, ig_daily.likes),
      comments=COALESCE(EXCLUDED.comments, ig_daily.comments),
      saves=COALESCE(EXCLUDED.saves, ig_daily.saves),
      shares=COALESCE(EXCLUDED.shares, ig_daily.shares),
      follows=COALESCE(EXCLUDED.follows, ig_daily.follows),
      unfollows=COALESCE(EXCLUDED.unfollows, ig_daily.unfollows),
      captured_at=now()`;
  await executor.query(sql, [channelId, JSON.stringify(rows)]);
  return rows.length;
}

// Per-media lifetime-инсайты по дням. rows: [{ media_id, day, reach, likes, comments,
// saved, shares, views }]. Insights кумулятивны → каждый день — новая точка траектории.
async function upsertIgMediaDaily(channelId, rows, executor = pool) {
  if (!enabled || !channelId || !rows || !rows.length) return 0;
  const clean = rows.filter(r => r && r.media_id != null);
  if (!clean.length) return 0;
  const sql = `INSERT INTO ig_media_daily
      (channel_id, source_id, media_id, day, reach, likes, comments, saved, shares, views, captured_at)
    SELECT $1, (SELECT a.source_id FROM ig_accounts a WHERE a.channel_id = $1),
           x.media_id, x.day::date, x.reach, x.likes, x.comments, x.saved, x.shares, x.views, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        media_id text, day text, reach integer, likes integer, comments integer,
        saved integer, shares integer, views integer
      )
    ON CONFLICT (channel_id, media_id, day) DO UPDATE SET
      source_id=COALESCE(EXCLUDED.source_id, ig_media_daily.source_id),
      reach=COALESCE(EXCLUDED.reach, ig_media_daily.reach),
      likes=COALESCE(EXCLUDED.likes, ig_media_daily.likes),
      comments=COALESCE(EXCLUDED.comments, ig_media_daily.comments),
      saved=COALESCE(EXCLUDED.saved, ig_media_daily.saved),
      shares=COALESCE(EXCLUDED.shares, ig_media_daily.shares),
      views=COALESCE(EXCLUDED.views, ig_media_daily.views),
      captured_at=now()`;
  await executor.query(sql, [channelId, JSON.stringify(clean)]);
  return clean.length;
}

// Сырой снапшот «как есть». upsert по (channel,source,kind,day) — повторный прогон
// за день перезаписывает, а не дублирует (как saveVelocity). day по умолчанию —
// сегодня; payload обязателен и непустой (guard от затирания хорошего снимка null'ом).
async function saveRawSnapshot(channelId, source, kind, day, payload, executor = pool) {
  if (!enabled || !channelId || !source || !kind || payload == null) return false;
  await executor.query(
    `INSERT INTO raw_snapshots (channel_id, source, kind, day, payload, created_at)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, now())
     ON CONFLICT (channel_id, source, kind, day)
       DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
    [channelId, source, kind, day || null, JSON.stringify(payload)]);
  return true;
}

// Ретеншн: raw_snapshots — append-only (полный /graphs с points:400 + почасовые
// карты online_followers весят немало), поэтому кроном подрезаем старьё, иначе
// таблица растёт безгранично. По умолчанию храним ~400 дней (> года истории).
async function pruneRawSnapshots(maxAgeDays = 400) {
  if (!enabled) return 0;
  const days = Number.isFinite(+maxAgeDays) ? Math.max(1, Math.round(+maxAgeDays)) : 400;
  const { rowCount } = await pool.query(
    `DELETE FROM raw_snapshots WHERE day < (CURRENT_DATE - $1::int)`, [days]);
  return rowCount;
}

// Ретеншн ig_media_daily: новая строка на (media, day) для каждого «молодого» медиа
// каждый прогон — растёт по мере появления новых постов, поэтому подрезаем старьё.
// Горизонт щедрый (~2 года): дневная траектория медиа ценна вдолгую.
async function pruneIgMediaDaily(maxAgeDays = 730) {
  if (!enabled) return 0;
  const days = Number.isFinite(+maxAgeDays) ? Math.max(1, Math.round(+maxAgeDays)) : 730;
  const { rowCount } = await pool.query(
    `DELETE FROM ig_media_daily WHERE day < (CURRENT_DATE - $1::int)`, [days]);
  return rowCount;
}

// ── Read helpers (история для будущих графиков) ──
async function listIgDaily(channelId, days = 400) {
  if (!enabled || !channelId) return [];
  const { rows } = await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, followers, reach, views, profile_views,
            accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows
       FROM ig_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int) ORDER BY day ASC`,
    [channelId, days]);
  return rows;
}

async function listIgMediaDaily(channelId, days = 400) {
  if (!enabled || !channelId) return [];
  const { rows } = await pool.query(
    `SELECT media_id, to_char(day,'YYYY-MM-DD') AS day, reach, likes, comments, saved, shares, views
       FROM ig_media_daily WHERE channel_id=$1 AND day >= (CURRENT_DATE - $2::int)
       ORDER BY media_id ASC, day ASC`, [channelId, days]);
  return rows;
}

// ── Timeline annotations (per-channel event markers on the trend charts) ──
async function listAnnotations(channelId) {
  if (!enabled || !channelId) return [];
  const { rows } = await pool.query(
    `SELECT id, to_char(day,'YYYY-MM-DD') AS day, label,
            to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM chart_annotations WHERE channel_id=$1 ORDER BY day ASC, id ASC`, [channelId]);
  return rows;
}

async function createAnnotation(channelId, { day, label, createdBy }) {
  if (!enabled || !channelId) return null;
  const { rows } = await pool.query(
    `INSERT INTO chart_annotations (channel_id, day, label, created_by) VALUES ($1,$2,$3,$4)
     RETURNING id, to_char(day,'YYYY-MM-DD') AS day, label,
       to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`,
    [channelId, day, String(label).slice(0, 120), createdBy ?? null]);
  return rows[0] || null;
}

async function deleteAnnotation(id, channelId) {
  if (!enabled || !id || !channelId) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM chart_annotations WHERE id=$1 AND channel_id=$2', [id, channelId]);
  return rowCount > 0;
}

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
/* ── Background job idempotency (012_jobs.sql, roadmap P0) ────────────────────────────────────
   One row per logical unit of work, keyed (kind, idempotency_key) — e.g.
   ('report_email', 'report:7:2026-W27'). claimJob is the single atomic gate:
     • fresh key            → row created as running, returned (caller does the work);
     • queued / failed      → re-claimed (attempts++), returned (retry);
     • running, lease dead  → re-claimed (crashed runner), returned;
     • running, lease alive → null (someone else is on it — skip);
     • succeeded            → null + cached result via getJob (duplicate enqueue collapses).
   completeJob/failJob close the claim. Callers that need the cached outcome of a skipped
   duplicate read getJob(kind, key).result. */
const JOB_LEASE_SECONDS = 15 * 60;

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

async function listDueReports({ weekly = false, monthly = false } = {}) {
  if (!enabled || (!weekly && !monthly)) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.uid, r.name, r.schedule, r.last_sent_at, u.email
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

module.exports = {
  enabled, init, migrate, ping, close, graphsToDailyRows,
  USER_ROLES, USER_STATUSES,
  countUsers, createUser, getUserByEmail, getUserById, getUserAvatar, setUserAvatar, listUsers, updateUser, setUserPassword,
  revokeUserSessions, setUserStatus, createEmailToken, useEmailToken,
  getPrefs, setPrefs,
  adoptOwnerChannel, listChannels, getChannel, getChannelById, getOwnerChannelId, setChannelTgId,
  createChannel, createTgChannel, createIgChannel, findIgChannelByIgUser, deleteChannel, createApiKey, getChannelByApiKey, listApiKeys, revokeApiKey,
  saveSnapshot, getSnapshot, ingestCollectorPayload, getCollectorStatus, recordAuditEvent,
  saveVelocity, getLatestVelocity,
  upsertChannelDaily, upsertPosts, upsertMentions, upsertIgTags, getIgTags,
  getChannelHistory, getMentionsHistory, getMentionsArchive,
  createBug, createCrash, upsertCrashSignature, setCrashNotionPage, touchCrashNotified, listBugs, updateBug, deleteBug, BUG_STATUSES, BUG_SEVERITIES, BUG_KINDS,
  bugExists, getBug, addAttachmentIfRoom, getAttachment,
  saveIgAccount, getIgAccount, updateIgToken, deleteIgAccount, listIgAccounts,
  saveTgSession, getTgSession, deleteTgSession, listTgSessions,
  upsertIgDaily, upsertIgMediaDaily, saveRawSnapshot, pruneRawSnapshots, pruneIgMediaDaily,
  listIgDaily, listIgMediaDaily,
  listAnnotations, createAnnotation, deleteAnnotation,
  REPORT_SCHEDULES, listReports, getReport, createReport, updateReport, deleteReport,
  listDueReports, markReportSent,
  claimJob, completeJob, failJob, getJob, runJobOnce,
  ensurePersonalWorkspace, ensureExternalSource, ensureChannelCanonical,
};
