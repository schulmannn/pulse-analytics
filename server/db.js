// ═══════════════════════════════════════════════════════════════
//  Atlavue — история в Postgres (Railway)
//  Полностью опционально: без DATABASE_URL (или без модуля pg)
//  всё деградирует мягко — дашборд работает как раньше.
// ═══════════════════════════════════════════════════════════════

const { runMigrations } = require('./migrations');
const { createJobsRepo } = require('./repos/jobsRepo');
const { createBugsRepo } = require('./repos/bugsRepo');
const { createReportsRepo } = require('./repos/reportsRepo');
const { createUsersRepo } = require('./repos/usersRepo');
const { createChannelsRepo } = require('./repos/channelsRepo');
const { createIntegrationsRepo } = require('./repos/integrationsRepo');
// DB core (P2 db/core): пул / Railway-SSL / enabled / ping / close + классификация недоступности
// живут в server/db/*. db.js их импортирует и ре-экспортит — публичный `db.*` API не меняется.
const { pool, enabled, ping, close } = require('./db/pool');
const { isDbUnavailable } = require('./db/errors');
const { sameTenantSource } = require('./db/access');
const { createTransaction } = require('./db/transaction');
const { mergeExports } = require('./db/mergeExports');

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

// USER_ROLES / USER_STATUSES -> server/repos/usersRepo (spread in exports).
// BUG_STATUSES / BUG_SEVERITIES / BUG_KINDS → server/repos/bugsRepo (spread в exports).

// isDbUnavailable + DB_UNAVAILABLE_* → server/db/errors (импортировано выше).

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

// ping / close → server/db/pool (импортировано выше).

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
    await channelsRepo.ensureChannelCanonical(rows[0].id, adminUid, rows[0].tg_channel_id != null
      ? { network: 'tg', externalId: rows[0].tg_channel_id, username: rows[0].username, title: rows[0].title }
      : {});
  }
  return true;
}

// ── Channels (tenants): видимость/доступ/tg-id → server/repos/channelsRepo (createChannelsRepo, spread в exports).
// Tenancy-предикаты (sameTenantSource / CHANNEL_ACCESS_PREDICATE / ADMIN) → server/db/access (импорт выше).

// INT4-колонки дневных таблиц: одно переполнение счётчика (сверхкрупный канал) раньше валило
// ВЕСЬ дневной ingest («integer out of range» → ROLLBACK всей транзакции дня). Клампим к границе
// INT4; полноценная BIGINT-миграция дневных таблиц — отдельным шагом (ALTER на больших таблицах).
const INT4_MAX = 2147483647;
const num = (v) => {
  if (v == null || isNaN(v)) return null;
  const n = Math.round(Number(v));
  const clamped = Math.max(-INT4_MAX - 1, Math.min(INT4_MAX, n));
  // Лог ТОЛЬКО при реальном клампе (сверхкрупный канал) — сигнал «пора BIGINT-миграция»; в норме молчит.
  if (clamped !== n) console.warn(`[db] INT4 clamp ${n} → ${clamped}: канал переполняет INT4, нужна BIGINT-миграция дневных таблиц`);
  return clamped;
};

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
      -- NULL в свежем ре-ингесте = «метрика временно недоступна», не «стало ноль»: голый
      -- EXCLUDED затирал уже сохранённые значения (соседние daily-upsert'ы всегда COALESCE'ят)
      views=COALESCE(EXCLUDED.views, posts.views), reactions=COALESCE(EXCLUDED.reactions, posts.reactions),
      forwards=COALESCE(EXCLUDED.forwards, posts.forwards), replies=COALESCE(EXCLUDED.replies, posts.replies),
      erv=COALESCE(EXCLUDED.erv, posts.erv), virality=COALESCE(EXCLUDED.virality, posts.virality),
      media_type=COALESCE(EXCLUDED.media_type, posts.media_type),
      caption=COALESCE(EXCLUDED.caption, posts.caption),
      hashtags=COALESCE(EXCLUDED.hashtags, posts.hashtags), updated_at=now()`;
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
      last_seen=now(),
      views=COALESCE(EXCLUDED.views, mentions.views), title=COALESCE(EXCLUDED.title, mentions.title),
      username=COALESCE(EXCLUDED.username, mentions.username), link=COALESCE(EXCLUDED.link, mentions.link),
      snippet=COALESCE(EXCLUDED.snippet, mentions.snippet), query=COALESCE(EXCLUDED.query, mentions.query)`;
  await executor.query(sql, [channelId, JSON.stringify(clean)]);
  return clean.length;
}

async function getChannelHistory(channelId, days = 400) {
  if (!enabled || !channelId) return [];
  // Canonical read (ADR-001 phase B): the history of the channel's SOURCE — a same-workspace
  // co-follow of one @channel sees ONE row-set. Until phase C flips the write conflict-targets, both
  // links may still write their own rows, so DISTINCT ON (day) keeps the freshest capture. The
  // source union is bounded to the reader's own workspace (sameTenantSource) so an unverified
  // source claim can't inherit another tenant's history; links without a source fall back to their
  // own channel-scoped rows.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (d.day)
            to_char(d.day,'YYYY-MM-DD') AS day, d.subscribers, d.joins, d.leaves, d.views, d.forwards, d.reactions
     FROM channel_daily d
     JOIN channels c ON c.id = $1
     WHERE ((c.source_id IS NOT NULL AND d.source_id = c.source_id AND ${sameTenantSource('d', 'c')})
            OR d.channel_id = c.id)
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
            COALESCE(sum(views),0)::bigint AS views
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
    // pg отдаёт bigint строкой — приводим к number (сумма просмотров << 2^53, точность не страдает;
    // строка ломала бы zod-схему фронта и арифметику сортировок). ::int здесь переполнялся.
    top_channels: channels.rows.map((r) => ({ ...r, views: Number(r.views || 0) })),
    recent: recent.rows,
  };
}

// Users / accounts / email-tokens / prefs -> server/repos/usersRepo (createUsersRepo, spread in exports).

// Instagram tags (@-упоминания) → server/repos/integrationsRepo (createIntegrationsRepo, spread в exports).

// (listUsers/updateUser/setUserStatus/email-tokens -> usersRepo)

// ── Canonical wiring for NEW rows (ADR-001; the 010 backfill covers pre-existing ones) ─────────

// The creator's personal workspace, created on first need. Backfill 010 seeds one per existing
// user; this covers users registered after the migration and keeps creation paths one-call simple.
// Workspaces / canonical external_sources / channel creates / delete / api-keys → server/repos/channelsRepo.

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
    if (data.tgChannelId != null) await channelsRepo.setChannelTgId(channelId, data.tgChannelId, client);

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

/* Atomically persist ONE central daily-ingest bundle (the cron's /graphs + /posts + /velocity).
   The three upserts commit together so a mid-write crash never leaves channel_daily updated but
   posts/velocity not (the collector path already gets this via ingestCollectorPayload; the central
   cron did three separate autocommitted writes). Idempotent by construction — every upsert is
   ON CONFLICT DO UPDATE — so re-running the same day overwrites, never double-counts. The caller
   wraps this in runJobOnce('daily_ingest', 'central:<date>') so a double cron / second instance
   does the heavy MTProto pass at most once per day. */
async function persistCentralDaily(channelId, { dailyRows = [], postRows = [], velocity = null } = {}) {
  if (!enabled || !channelId) throw new Error('database unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const nDaily = await upsertChannelDaily(channelId, dailyRows, client);
    const nPosts = await upsertPosts(channelId, postRows, client);
    let velocityOk = false;
    if (velocity && velocity.available) {
      await saveVelocity(channelId, velocity, client);
      velocityOk = true;
    }
    await client.query('COMMIT');
    return { channel_daily: nDaily, posts: nPosts, velocity: velocityOk };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

// QR-канал: снапшот + дневные серии + посты — в ОДНОЙ транзакции (зеркало persistCentralDaily).
// Раньше сервер-сайд QR-сбор писал это четырьмя автокоммитными вызовами (persistTgBundle в
// index.js): сбой посередине оставлял канал со свежим снапшотом, но устаревшими daily/posts до
// следующего идемпотентного прогона. Сырой graphs-снимок сюда НЕ входит — это опциональный
// архив, вызывающий пишет его best-effort ПОСЛЕ коммита.
async function persistTgBundleTx(channelId, { snapshot, dailyRows = [], postRows = [] } = {}) {
  if (!enabled || !channelId) throw new Error('database unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await saveSnapshot(channelId, snapshot, client);
    if (dailyRows.length) await upsertChannelDaily(channelId, dailyRows, client);
    if (postRows.length) await upsertPosts(channelId, postRows, client);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

// getCollectorStatus (connection-status; writes живут в ingest выше) → server/repos/integrationsRepo.

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
// (getPrefs/setPrefs -> usersRepo)

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
  // Canonical read (ADR-001): freshest snapshot of the channel's source (bounded to the reader's
  // own workspace via sameTenantSource so an unverified source claim can't read a foreign tenant's
  // velocity), own rows as fallback.
  const { rows } = await pool.query(
    `SELECT v.data, to_char(v.computed_at,'YYYY-MM-DD"T"HH24:MI:SS') AS computed_at
       FROM velocity_daily v
       JOIN channels c ON c.id = $1
      WHERE ((c.source_id IS NOT NULL AND v.source_id = c.source_id AND ${sameTenantSource('v', 'c')})
             OR v.channel_id = c.id)
      ORDER BY v.day DESC, v.computed_at DESC NULLS LAST LIMIT 1`, [channelId]);
  return rows[0] || null;   // { data, computed_at } | null
}

// Bugs / crash-telemetry / attachments (createBug/listBugs/…/getAttachment) → server/repos/bugsRepo.

// IG-аккаунты (OAuth, access_token_enc) + TG QR-сессии (session_enc) → server/repos/integrationsRepo.

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
      (channel_id, source_id, day, followers, followers_total, reach, views, profile_views, accounts_engaged,
       total_interactions, likes, comments, saves, shares, follows, unfollows, captured_at)
    SELECT $1, (SELECT a.source_id FROM ig_accounts a WHERE a.channel_id = $1),
           x.day::date, x.followers, x.followers_total, x.reach, x.views, x.profile_views, x.accounts_engaged,
           x.total_interactions, x.likes, x.comments, x.saves, x.shares, x.follows, x.unfollows, now()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        day text, followers integer, followers_total integer, reach integer, views integer, profile_views integer,
        accounts_engaged integer, total_interactions integer, likes integer, comments integer,
        saves integer, shares integer, follows integer, unfollows integer
      )
    ON CONFLICT (channel_id, day) DO UPDATE SET
      source_id=COALESCE(EXCLUDED.source_id, ig_daily.source_id),
      followers=COALESCE(EXCLUDED.followers, ig_daily.followers),
      followers_total=COALESCE(EXCLUDED.followers_total, ig_daily.followers_total),
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

// ── Monthly rollup of channel_daily (capacity; 014_capacity_rollups.sql) ──────────────────────────
// Idempotent upsert that folds the last `months` calendar months of channel_daily into
// channel_monthly (one row per channel×month), so a long-range history read can serve ~24 monthly
// points instead of scanning up to 730 daily rows per channel. Bounded to recent months so the
// nightly recompute stays cheap. INERT until wired: nothing reads channel_monthly yet — the reader
// (getChannelHistoryMonthly) lands with the frontend range-picker change (see CAPACITY doc §rollups).
async function rollupChannelMonthly(months = 3) {
  if (!enabled) return 0;
  const m = Number.isFinite(+months) ? Math.max(1, Math.round(+months)) : 3;
  const { rowCount } = await pool.query(
    `INSERT INTO channel_monthly
       (channel_id, source_id, month, subscribers_end,
        joins_sum, leaves_sum, views_sum, forwards_sum, reactions_sum, days_count, computed_at)
     SELECT d.channel_id, MAX(c.source_id), date_trunc('month', d.day)::date AS month,
            (array_agg(d.subscribers ORDER BY d.day DESC) FILTER (WHERE d.subscribers IS NOT NULL))[1],
            COALESCE(SUM(d.joins),0), COALESCE(SUM(d.leaves),0), COALESCE(SUM(d.views),0),
            COALESCE(SUM(d.forwards),0), COALESCE(SUM(d.reactions),0), COUNT(*), now()
       FROM channel_daily d
       JOIN channels c ON c.id = d.channel_id
      WHERE d.day >= date_trunc('month', CURRENT_DATE) - make_interval(months => $1)
      GROUP BY d.channel_id, date_trunc('month', d.day)
     ON CONFLICT (channel_id, month) DO UPDATE SET
       source_id       = COALESCE(EXCLUDED.source_id, channel_monthly.source_id),
       subscribers_end = EXCLUDED.subscribers_end,
       joins_sum       = EXCLUDED.joins_sum,
       leaves_sum      = EXCLUDED.leaves_sum,
       views_sum       = EXCLUDED.views_sum,
       forwards_sum    = EXCLUDED.forwards_sum,
       reactions_sum   = EXCLUDED.reactions_sum,
       days_count      = EXCLUDED.days_count,
       computed_at     = now()`,
    [m]);
  return rowCount;
}

// ── Read helpers (история для будущих графиков) ──
async function listIgDaily(channelId, days = 400) {
  if (!enabled || !channelId) return [];
  const { rows } = await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, followers, followers_total, reach, views, profile_views,
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

// Timeline annotations (listAnnotations/createAnnotation/deleteAnnotation) → server/repos/channelsRepo.

// Named reports (per-user composition + email schedule) → repos/reportsRepo.js. Composed below.

// ── GDPR: стирание и экспорт аккаунта (F4/F5) ─────────────────────────────────────────────────

/* Полное стирание аккаунта (GDPR erasure) — один DELETE FROM users: реляционную полноту даёт
   схема. Каскадом умирают user_prefs / tg_sessions / email_tokens / reports / workspaces
   (+members) / channels(owner_uid), а от channels — все архивы (channel_daily / monthly /
   posts / mentions / velocity / ig_accounts / ig_daily / ig_media_daily / api_keys /
   annotations / snapshots). audit_events.uid и chart_annotations.created_by → SET NULL
   (журнал остаётся, но анонимный). Разделяемые external_sources НЕ трогаются — это identity
   публичного канала, не персональные данные.
   Pre-null: канал ДРУГОГО владельца, живущий в воркспейсе стираемого юзера (инвариант «канал
   в личном воркспейсе создателя» кодом не enforced), переводится в legacy NULL-workspace —
   owner_uid-fallback чтения жив с миграции 010; иначе NO ACTION FK на channels.workspace_id
   валит весь DELETE. */
async function deleteUserAccount(uid) {
  if (!enabled || uid == null) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE channels SET workspace_id = NULL
        WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_uid = $1)
          AND owner_uid IS DISTINCT FROM $1`, [uid]);
    // SET NULL анонимизирует только uid: исторические metadata несут прямые идентификаторы
    // (tg.session.connected — личный @username, ig_oauth_connected, channel.created) — без
    // зачистки «анонимный журнал» ложь (скептик-панель, erasure-completeness).
    await client.query(`UPDATE audit_events SET metadata = '{}'::jsonb WHERE uid = $1`, [uid]);
    const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [uid]);
    // Осиротевшие external_sources: для приватного канала username/title (часто имя человека)
    // не «shared identity» — если после каскада на источник не ссылается НИКТО, стираем и его.
    // Разделяемые источники (чужие channels/архивы ссылаются) переживают sweep невредимыми.
    await client.query(
      `DELETE FROM external_sources s
        WHERE NOT EXISTS (SELECT 1 FROM channels        t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM ig_accounts     t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM channel_daily   t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM channel_monthly t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM posts           t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM velocity_daily  t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM mentions        t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM ig_daily        t WHERE t.source_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM ig_media_daily  t WHERE t.source_id = s.id)`);
    await client.query('COMMIT');
    return rowCount > 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* Экспорт персональных данных (GDPR portability) — один JSON-объект. Учётные данные не
   экспортируются НИКОГДА: pass_hash, token_version, tg_sessions.session_enc,
   ig_accounts.access_token_enc и key_hash не попадают в SELECT'ы. Каналы — только
   owner_uid=uid: шаренные воркспейс-каналы принадлежат другому владельцу (data minimization).
   Объём при текущем масштабе (кап 100 юзеров, архив ≤730 дн) — единицы МБ, буферизуем целиком. */
async function exportUserData(uid) {
  if (!enabled || uid == null) return null;
  // GDPR-экспорт редкий, но тяжёлый (5 запросов на аккаунт + 9 на КАЖДЫЙ канал): его
  // Promise.all-фан-аут через pool.query занимал все PGPOOL_MAX=4 коннекта и душил
  // остальной API на время экспорта. Один выделенный клиент = ровно один коннект.
  // Запросы ПОСЛЕДОВАТЕЛЬНО (не Promise.all на одном клиенте): pg и так сериализует их на
  // соединении, но при отклонении одного Promise.all прыгал бы в finally→release() при ещё
  // живущих в очереди запросах — вернул бы в пул ЗАНЯТОЕ соединение (interleaving под нагрузкой).
  const client = await pool.connect();
  try {
    const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
    const many = async (sql, params) => (await client.query(sql, params)).rows;

    const account = await one(
      `SELECT id, email, role, status, avatar_url, created_at FROM users WHERE id=$1`, [uid]);
    if (!account) return null;

    const prefs = await one(`SELECT prefs, updated_at FROM user_prefs WHERE uid=$1`, [uid]);
    const reports = await many(`SELECT id, name, config, schedule, created_at, updated_at, last_sent_at
              FROM reports WHERE uid=$1 ORDER BY id`, [uid]);
    const workspaces = await many(`SELECT w.id, w.name, w.created_at,
                   (SELECT json_agg(json_build_object('uid', m.uid, 'role', m.role) ORDER BY m.uid)
                      FROM workspace_members m WHERE m.workspace_id = w.id) AS members
              FROM workspaces w WHERE w.owner_uid=$1 ORDER BY w.id`, [uid]);
    const tgSession = await one(`SELECT tg_user_id, username, connected_at, updated_at FROM tg_sessions WHERE uid=$1`, [uid]);
    const channels = await many(`SELECT id, username, title, source, tg_channel_id, created_at
              FROM channels WHERE owner_uid=$1 ORDER BY id`, [uid]);

    for (const ch of channels) {
      const daily = await many(`SELECT * FROM channel_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
      const monthly = await many(`SELECT month, subscribers_end, joins_sum, leaves_sum, views_sum, forwards_sum,
                       reactions_sum, days_count
                  FROM channel_monthly WHERE channel_id=$1 ORDER BY month`, [ch.id]);
      const posts = await many(`SELECT * FROM posts WHERE channel_id=$1 ORDER BY date_published`, [ch.id]);
      const mentionRows = await many(`SELECT * FROM mentions WHERE owner_channel_id=$1 ORDER BY msg_id`, [ch.id]);
      const velocity = await many(`SELECT * FROM velocity_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
      const annotations = await many(`SELECT day, label, created_at FROM chart_annotations WHERE channel_id=$1 ORDER BY day`, [ch.id]);
      const ig = await one(`SELECT ig_user_id, username, scopes, token_expires_at, connected_at, updated_at
                 FROM ig_accounts WHERE channel_id=$1`, [ch.id]);
      const igDaily = await many(`SELECT * FROM ig_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
      const igMedia = await many(`SELECT * FROM ig_media_daily WHERE channel_id=$1 ORDER BY day`, [ch.id]);
      ch.archive = { daily, monthly, posts, mentions: mentionRows, velocity, annotations };
      ch.instagram = ig ? { ...ig, daily: igDaily, media_daily: igMedia } : null;
    }

    return {
      format: 'atlavue-export',
      version: 1,
      exported_at: new Date().toISOString(),
      account,
      prefs: prefs ? prefs.prefs : null,
      workspaces,
      reports,
      // Присутствие подключения — да; сама сессия — никогда (это credential, не данные).
      telegram_session: tgSession,
      channels,
    };
  } finally {
    client.release();
  }
}

// ── Repo composition (P2 stage 5) — thin re-export so the public `db` API is unchanged ──
// pool/enabled are settled at module load (above); each repo owns a domain's queries and its
// methods are spread into the exports below at their original names.
// Один transaction-хелпер над пулом, инжектится в репо с составными транзакциями (finding 4:
// единый способ достать DB-зависимость, без inline-BEGIN'ов в репозиториях).
const transaction = createTransaction(pool);
const jobsRepo = createJobsRepo({ pool, enabled });
const bugsRepo = createBugsRepo({ pool, enabled });
const reportsRepo = createReportsRepo({ pool, enabled });
const usersRepo = createUsersRepo({ pool, enabled, transaction });
const channelsRepo = createChannelsRepo({ pool, enabled, transaction });
// ensureExternalSource / transaction — инъекция (repos не импортят друг друга; связывание только тут).
const integrationsRepo = createIntegrationsRepo({ pool, enabled, transaction, ensureExternalSource: channelsRepo.ensureExternalSource });

// db.js-локальные экспорты (домены, ещё не вынесенные в repos/*): core + collector-writes +
// analytics-reads + bugs/crashes + gdpr. По мере распила эти наборы переезжают в свои repo.
const localExports = {
  enabled, init, migrate, ping, close, graphsToDailyRows, isDbUnavailable,
  adoptOwnerChannel,
  saveSnapshot, getSnapshot, ingestCollectorPayload, persistCentralDaily, persistTgBundleTx, recordAuditEvent,
  saveVelocity, getLatestVelocity,
  upsertChannelDaily, upsertPosts, upsertMentions,
  getChannelHistory, getMentionsHistory, getMentionsArchive,
  upsertIgDaily, upsertIgMediaDaily, saveRawSnapshot, pruneRawSnapshots, pruneIgMediaDaily,
  rollupChannelMonthly,
  listIgDaily, listIgMediaDaily,
  deleteUserAccount, exportUserData,
};

// Публичный фасад db.* — сборка из доменных частей с ГАРДОМ на коллизии имён (finding 3):
// mergeExports падает на загрузке, если два repo (или локальный набор) экспортируют одно имя —
// раньше spread `{...a, ...b}` молча оставлял последнее, тихо затирая реализацию.
module.exports = mergeExports({
  local: localExports,
  users: usersRepo,
  channels: channelsRepo,
  integrations: integrationsRepo,
  bugs: bugsRepo,
  reports: reportsRepo,   // REPORT_SCHEDULES, listReports, getReport, createReport, updateReport, deleteReport, listDueReports, markReportSent, listPostsWindow
  jobs: jobsRepo,   // claimJob, completeJob, failJob, getJob, runJobOnce
});
