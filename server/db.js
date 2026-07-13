// ═══════════════════════════════════════════════════════════════
//  Atlavue — история в Postgres (Railway)
//  Полностью опционально: без DATABASE_URL (или без модуля pg)
//  всё деградирует мягко — дашборд работает как раньше.
// ═══════════════════════════════════════════════════════════════

const { runMigrations } = require('./migrations');
const { createJobsRepo } = require('./repos/jobsRepo');
const { createBugsRepo } = require('./repos/bugsRepo');
const { createCollectorRepo } = require('./repos/collectorRepo');
const { createAnalyticsRepo } = require('./repos/analyticsRepo');
const { createReportsRepo } = require('./repos/reportsRepo');
const { createUsersRepo } = require('./repos/usersRepo');
const { createChannelsRepo } = require('./repos/channelsRepo');
const { createSourcesRepo } = require('./repos/sourcesRepo');
const { createIntegrationsRepo } = require('./repos/integrationsRepo');
const { createGdprService } = require('./services/gdprService');
// DB core (P2 db/core): пул / Railway-SSL / enabled / ping / close + классификация недоступности
// живут в server/db/*. db.js их импортирует и ре-экспортит — публичный `db.*` API не меняется.
const { pool, enabled, ping, close } = require('./db/pool');
const { isDbUnavailable } = require('./db/errors');
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

// Collector writes (num/INT4-clamp, graphsToDailyRows, upsert daily/posts/mentions, saveSnapshot,
// ingestCollectorPayload, persistCentralDaily/persistTgBundleTx) → server/repos/collectorRepo.

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
// Collector writes (saveVelocity, upsertIg{Daily,MediaDaily}, saveRawSnapshot, prune{RawSnapshots,
// IgMediaDaily}, rollupChannelMonthly) → server/repos/collectorRepo.

// ── GDPR (erasure/export, F4/F5) → services/gdprService (PR 8) ──────────────────────────────
// Сервис, не repo: пересекает все домены. Композиция ниже, фасад тот же (db.deleteUserAccount/
// db.exportUserData) — routes/account.js не менялся.

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
// sourcesRepo — external identity отдельный домен (finding 8); channels/integrations зависят ОТ него,
// не друг от друга. Инстанцируется ДО channelsRepo (тот инъектит ensureExternalSource).
const sourcesRepo = createSourcesRepo({ pool, enabled });
const channelsRepo = createChannelsRepo({ pool, enabled, transaction, ensureExternalSource: sourcesRepo.ensureExternalSource });
// ensureExternalSource / transaction — инъекция (repos не импортят друг друга; связывание только тут).
const integrationsRepo = createIntegrationsRepo({ pool, enabled, transaction, ensureExternalSource: sourcesRepo.ensureExternalSource });
// getAccessibleChannel — инъекция (finding 5: ForActor-ридеры гейтят доступ через канонический
// ownership-check channelsRepo.getChannel; repos не импортят друг друга). ПОСЛЕ channelsRepo (TDZ).
const analyticsRepo = createAnalyticsRepo({ pool, enabled, getAccessibleChannel: channelsRepo.getChannel });
// setChannelTgId — инъекция (ingestCollectorPayload штампует tg-id в своей транзакции; repos не импортят друг друга).
const collectorRepo = createCollectorRepo({ pool, enabled, transaction, setChannelTgId: channelsRepo.setChannelTgId });
// GDPR — сервис над пулом+transaction (кросс-доменные erasure/export; спека: GDPR=service).
const gdprService = createGdprService({ pool, enabled, transaction });

// db.js-локальные экспорты (домены, ещё не вынесенные в repos/*): core + collector-writes +
// analytics-reads + bugs/crashes. По мере распила эти наборы переезжают в свои repo.
const localExports = {
  enabled, init, migrate, ping, close, isDbUnavailable,
  adoptOwnerChannel,
  recordAuditEvent,
};

// Публичный фасад db.* — сборка из доменных частей с ГАРДОМ на коллизии имён (finding 3):
// mergeExports падает на загрузке, если два repo (или локальный набор) экспортируют одно имя —
// раньше spread `{...a, ...b}` молча оставлял последнее, тихо затирая реализацию.
module.exports = mergeExports({
  local: localExports,
  users: usersRepo,
  channels: channelsRepo,
  sources: sourcesRepo,
  integrations: integrationsRepo,
  bugs: bugsRepo,
  analytics: analyticsRepo,
  collector: collectorRepo,
  reports: reportsRepo,   // REPORT_SCHEDULES, listReports, getReport, createReport, updateReport, deleteReport, listDueReports, markReportSent, listPostsWindow
  jobs: jobsRepo,   // claimJob, completeJob, failJob, getJob, runJobOnce
  gdpr: gdprService,   // deleteUserAccount, exportUserData (сервис, не repo)
});
