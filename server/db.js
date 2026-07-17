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
const { createCampaignsRepo } = require('./repos/campaignsRepo');
const { createUsersRepo } = require('./repos/usersRepo');
const { createChannelsRepo } = require('./repos/channelsRepo');
const { createSourcesRepo } = require('./repos/sourcesRepo');
const { createIntegrationsRepo } = require('./repos/integrationsRepo');
const { createMentionSettingsRepo } = require('./repos/mentionSettingsRepo');
const { createAiChatsRepo } = require('./repos/aiChatsRepo');
const { createAuditRepo } = require('./repos/auditRepo');
const { createGdprService } = require('./services/gdprService');
// DB core (P2 db/core): пул / Railway-SSL / enabled / ping / close + классификация недоступности
// живут в server/db/*. db.js их импортирует и ре-экспортит — публичный `db.*` API не меняется.
const { createPool } = require('./db/pool');
const { isDbUnavailable } = require('./db/errors');
const { createTransaction } = require('./db/transaction');
const { mergeExports } = require('./db/mergeExports');

function createDatabase(config, overrides = {}) {
  const core =
    overrides.core || createPool(config.database, overrides.poolOptions);
  const { pool, enabled, ping, close } = core;
  const OWNER_CHANNEL = config.telegram.ownerChannel;
  const ADMIN_EMAIL = config.auth.adminEmail;

  // Схема — ТОЛЬКО server/migrations/*.sql (исторический inline-дамп снесён в PR 9;
  // git-история хранит его на случай археологии).

  // USER_ROLES / USER_STATUSES -> server/repos/usersRepo (spread in exports).
  // BUG_STATUSES / BUG_SEVERITIES / BUG_KINDS → server/repos/bugsRepo (spread в exports).

  // isDbUnavailable + DB_UNAVAILABLE_* → server/db/errors (импортировано выше).

  async function init() {
    if (!enabled) {
      console.log('[db] disabled (no DATABASE_URL) — history off');
      return;
    }
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
  /* Find-or-create the singleton 'central' channel (the owner's @bynotem feed) and
   stamp every pre-existing global data row onto it. Idempotent + double-boot-safe:
   the partial unique index makes the INSERT race-safe, and the backfill UPDATEs
   match nothing once the rows are stamped. The admin user may not exist yet at
   first boot (bootstrapAdmin runs after init) → create with owner_uid NULL and
   let adoptOwnerChannel() claim it once the admin row exists. */
  async function migrateOwnerChannel() {
    if (!enabled) return;
    let { rows } = await pool.query(
      `SELECT id FROM channels WHERE source='central' LIMIT 1`,
    );
    let ownerId = rows[0] && rows[0].id;
    if (!ownerId) {
      const adminEmail = ADMIN_EMAIL;
      let adminId = null;
      if (adminEmail) {
        const u = await pool.query('SELECT id FROM users WHERE email=$1', [
          adminEmail,
        ]);
        adminId = u.rows[0] ? u.rows[0].id : null;
      }
      const uname = String(OWNER_CHANNEL).replace(/^@/, '');
      const ins = await pool.query(
        `INSERT INTO channels (owner_uid, username, title, status, source)
       VALUES ($1,$2,$2,'active','central') ON CONFLICT DO NOTHING RETURNING id`,
        [adminId, uname],
      );
      ownerId = ins.rows[0]
        ? ins.rows[0].id
        : (
            await pool.query(
              `SELECT id FROM channels WHERE source='central' LIMIT 1`,
            )
          ).rows[0]?.id;
    }
    if (!ownerId) return;
    await pool.query(
      `UPDATE channel_daily  SET channel_id=$1 WHERE channel_id IS NULL`,
      [ownerId],
    );
    await pool.query(
      `UPDATE posts          SET channel_id=$1 WHERE channel_id IS NULL`,
      [ownerId],
    );
    await pool.query(
      `UPDATE velocity_daily SET channel_id=$1 WHERE channel_id IS NULL`,
      [ownerId],
    );
    await pool.query(
      `UPDATE mentions       SET owner_channel_id=$1 WHERE owner_channel_id IS NULL`,
      [ownerId],
    );
  }

  // Claim the orphan central channel for the admin once its account exists
  // (chained after bootstrapAdmin in index.js). No-op once owned → idempotent.
  async function adoptOwnerChannel(adminUid) {
    if (!enabled || adminUid == null) return false;
    await pool.query(
      `UPDATE channels SET owner_uid=$1 WHERE owner_uid IS NULL AND source='central'`,
      [adminUid],
    );
    // Canonicalise the freshly-adopted central channel too (workspace now; tg source when its
    // platform id is already known — otherwise setChannelTgId stamps it on discovery).
    const { rows } = await pool.query(
      `SELECT id, tg_channel_id, username, title FROM channels WHERE owner_uid=$1 AND source='central'`,
      [adminUid],
    );
    if (rows[0]) {
      await channelsRepo.ensureChannelCanonical(
        rows[0].id,
        adminUid,
        rows[0].tg_channel_id != null
          ? {
              network: 'tg',
              externalId: rows[0].tg_channel_id,
              username: rows[0].username,
              title: rows[0].title,
            }
          : {},
      );
    }
    return true;
  }

  // ── Channels (tenants): видимость/доступ/tg-id → server/repos/channelsRepo (createChannelsRepo, spread в exports).
  // Tenancy-предикаты (sameTenantSource / channelAccessSql / channelAdminAccessSql) → server/db/access.

  // Collector writes (num→BIGINT metric normalization, graphsToDailyRows, upsert daily/posts/mentions, saveSnapshot,
  // ingestCollectorPayload, persistCentralDaily/persistTgBundleTx) → server/repos/collectorRepo.

  // getCollectorStatus (connection-status; writes живут в ingest выше) → server/repos/integrationsRepo.

  // recordAuditEvent + ретеншн audit_events → server/repos/auditRepo (createAuditRepo, spread в exports).

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
  // db.streamUserExport) — routes/account.js вызывает фасад тот же.

  // ── Repo composition (P2 stage 5) — thin re-export so the public `db` API is unchanged ──
  // pool/enabled are scoped to this database instance; each repo owns a domain's queries and its
  // methods are spread into the exports below at their original names.
  // Один transaction-хелпер над пулом, инжектится в репо с составными транзакциями (finding 4:
  // единый способ достать DB-зависимость, без inline-BEGIN'ов в репозиториях).
  const transaction = createTransaction(pool);
  const jobsRepo = createJobsRepo({ pool, enabled });
  const bugsRepo = createBugsRepo({ pool, enabled, transaction });
  const reportsRepo = createReportsRepo({ pool, enabled });
  const usersRepo = createUsersRepo({ pool, enabled, transaction });
  // sourcesRepo — external identity отдельный домен (finding 8); channels/integrations зависят ОТ него,
  // не друг от друга. Инстанцируется ДО channelsRepo (тот инъектит ensureExternalSource).
  const sourcesRepo = createSourcesRepo({ pool, enabled });
  const channelsRepo = createChannelsRepo({
    pool,
    enabled,
    transaction,
    ensureExternalSource: sourcesRepo.ensureExternalSource,
  });
  // ensureExternalSource / transaction — инъекция (repos не импортят друг друга; связывание только тут).
  const integrationsRepo = createIntegrationsRepo({
    pool,
    enabled,
    transaction,
    ensureExternalSource: sourcesRepo.ensureExternalSource,
  });
  // getAccessibleChannel — инъекция (finding 5: ForActor-ридеры гейтят доступ через канонический
  // ownership-check channelsRepo.getChannel; repos не импортят друг друга). ПОСЛЕ channelsRepo (TDZ).
  const analyticsRepo = createAnalyticsRepo({
    pool,
    enabled,
    getAccessibleChannel: channelsRepo.getChannel,
  });
  // setChannelTgId — инъекция (ingestCollectorPayload штампует tg-id в своей транзакции; repos не импортят друг друга).
  const collectorRepo = createCollectorRepo({
    pool,
    enabled,
    transaction,
    setChannelTgId: channelsRepo.setChannelTgId,
  });
  // Audit trail — запись + возрастной ретеншн (auditRepo). Зависит только от pool+enabled.
  const auditRepo = createAuditRepo({ pool, enabled });
  // GDPR — сервис над пулом+transaction (кросс-доменные erasure/export; спека: GDPR=service).
  // pageSize — размер keyset-страницы стриминг-экспорта (из config: services читают только
  // внедрённые deps, не окружение — check:boundaries).
  const gdprService = createGdprService({
    pool, enabled, transaction, exportPageSize: config.database.gdprExportPageSize,
  });
  // Campaign membership performs an atomic lock/count/insert through the shared transaction helper.
  const campaignsRepo = createCampaignsRepo({
    pool,
    enabled,
    transaction,
  });
  // Per-channel mention rules. Читатель гейтится через channelsRepo.getChannel (ForActor), запись
  // (owner/admin) вшивает channelAdminAccessSql в SQL. После channelsRepo (TDZ, как analyticsRepo).
  const mentionSettingsRepo = createMentionSettingsRepo({
    pool,
    enabled,
    getAccessibleChannel: channelsRepo.getChannel,
  });
  // Личные AI-диалоги (027): все методы uid-scoped; аналитика в чат попадает только через
  // ForActor-инструменты aiChatService, не через этот repo.
  const aiChatsRepo = createAiChatsRepo({ pool, enabled });

  // db.js-локальные экспорты (домены, ещё не вынесенные в repos/*): core + collector-writes +
  // analytics-reads + bugs/crashes. По мере распила эти наборы переезжают в свои repo.
  const localExports = {
    enabled,
    init,
    migrate,
    ping,
    close,
    isDbUnavailable,
    adoptOwnerChannel,
  };

  // Публичный фасад db.* — сборка из доменных частей с ГАРДОМ на коллизии имён (finding 3):
  // mergeExports падает на загрузке, если два repo (или локальный набор) экспортируют одно имя —
  // раньше spread `{...a, ...b}` молча оставлял последнее, тихо затирая реализацию.
  return mergeExports({
    local: localExports,
    users: usersRepo,
    channels: channelsRepo,
    sources: sourcesRepo,
    integrations: integrationsRepo,
    bugs: bugsRepo,
    analytics: analyticsRepo,
    collector: collectorRepo,
    reports: reportsRepo, // REPORT_SCHEDULES, listReports, getReport, createReport, updateReport, deleteReport, listDueReports, markReportSent, reserveReportDelivery, clearReportDelivery, listPostsWindow
    campaigns: campaignsRepo, // CAMPAIGN_*, listCampaigns, getCampaign, create/update/deleteCampaign, add/remove/listCampaignPosts, getCampaignSummary
    mentionSettings: mentionSettingsRepo, // getMentionSettingsInternal/ForActor, upsertMentionSettingsForActor
    aiChats: aiChatsRepo, // listAiChats, createAiChat, getAiChat, deleteAiChat, listAiChatMessages, appendAiChatMessage, getAiUsageToday, bumpAiUsage
    jobs: jobsRepo, // claimJob, completeJob, failJob, getJob, runJobOnce, pruneTerminalJobs
    audit: auditRepo, // recordAuditEvent, pruneAuditEvents
    gdpr: gdprService, // deleteUserAccount, streamUserExport (сервис, не repo)
  });
}

module.exports = { createDatabase, isDbUnavailable };
