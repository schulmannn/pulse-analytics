'use strict';

/* ── Channels repo (P2 db-split, PR 3) ───────────────────────────────────────────────────────────
   Каналы-как-тенанты: воркспейсы+членство, видимость (listChannels/getChannel), канонические
   external_sources, TG/IG/QR/collector-линки, api-keys, timeline-аннотации, удаление. Извлечено
   ДОСЛОВНО из db.js — SQL не менялся. Публичный `db.*` API не меняется: db.js спредит методы
   этого репо в module.exports.

   Зависит от общего пула + флага enabled + tenancy-предикатов из ../db/access (workspace-изоляцию
   делят и analytics-ридеры → предикат живёт в общем db-слое) + ensureExternalSource (ИНЪЕКЦИЯ из
   sourcesRepo — external identity отдельный домен, finding 8). Внутренних импортов db.js/других repo
   НЕТ; ensureChannelCanonical/setChannelTgId возвращаются наружу — их зовёт boot/ingest-код в db.js. */

const { sameTenantSource, channelAccessSql, channelAdminAccessSql } = require('../db/access');

const CHANNEL_COLS = 'id, username, title, status, source, tg_channel_id, owner_uid';

// Latest known subscriber count per channel (cheap: newest daily row). Canonical per ADR-001: any
// row of the channel's SOURCE written within the reader's own workspace counts (a same-workspace
// co-follow shares history); channel-scoped rows are the fallback for links without a source yet.
const MEMBER_COUNT_COL =
  `(SELECT cd.subscribers FROM channel_daily cd
      WHERE ((channels.source_id IS NOT NULL AND cd.source_id = channels.source_id
              AND ${sameTenantSource('cd', 'channels')})
             OR cd.channel_id = channels.id)
        AND cd.subscribers IS NOT NULL
      ORDER BY cd.day DESC, cd.captured_at DESC NULLS LAST LIMIT 1) AS "memberCount"`;

function createChannelsRepo({ pool, enabled, transaction, ensureExternalSource }) {
  // ── Channels (tenants): видимость / доступ ───────────────────────
  async function listChannels(user) {
    if (!enabled) return [];
    const uid = user && user.uid;
    if (uid == null) return [];   // defensive: never query ownership with a missing uid
    // Видимость через индексный id-набор (UNION двух ветвей) вместо `owner OR EXISTS(...)`:
    // OR поверх owner_uid и коррелированного EXISTS заставляет планировщик seq-scan'ить channels
    // (capacity-док, hot query), а UNION гонит каждую ветвь своим индексом (channels_owner_idx /
    // workspace_members_uid_idx → channels_workspace_idx) и полуджойнит результат. Набор ТОТ ЖЕ,
    // что у channelAccessSql: создатель (legacy owner_uid) ИЛИ член workspace — JOIN по
    // m.workspace_id = c.workspace_id сам отсекает NULL-workspace строки, как
    // `workspace_id IS NOT NULL AND EXISTS` в предикате; IN дедупит owner+member пересечение.
    const { rows } = await pool.query(
      `SELECT ${CHANNEL_COLS}, ${MEMBER_COUNT_COL},
              EXISTS(SELECT 1 FROM ig_accounts ia WHERE ia.channel_id = channels.id) AS ig_connected
       FROM channels
       WHERE channels.id IN (
               SELECT c.id FROM channels c WHERE c.owner_uid = $1
               UNION
               SELECT c.id FROM channels c
                 JOIN workspace_members m ON m.workspace_id = c.workspace_id
                WHERE m.uid = $1)
         AND status<>'disabled'
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
       WHERE id=$1 AND ${channelAccessSql({ uidParam: '$2' })} AND status<>'disabled'`,
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

  // ── Workspaces + canonical external identity ─────────────────────
  async function ensurePersonalWorkspace(uid, executor = pool) {
    if (!enabled || uid == null) return null;
    // Insert-or-get АТОМАРНО (finding 1): partial-unique (kind='personal', миграция 015) сводит
    // конкурентные коннекты нового юзера к ОДНОЙ строке вместо гонки SELECT→INSERT в два дубля.
    // ON CONFLICT DO NOTHING → при уже существующем воркспейсе достаём его фолбэк-SELECT'ом ниже.
    const ins = await executor.query(
      `INSERT INTO workspaces (name, owner_uid, kind)
       SELECT split_part(u.email,'@',1), u.id, 'personal' FROM users u WHERE u.id=$1
       ON CONFLICT (owner_uid) WHERE kind = 'personal' DO NOTHING
       RETURNING id`, [uid]);
    let wsId = ins.rows[0] ? ins.rows[0].id : null;
    if (wsId == null) {
      // Конфликт (воркспейс уже есть) ИЛИ юзера нет — берём существующий.
      const found = await executor.query(
        `SELECT id FROM workspaces WHERE owner_uid=$1 AND kind='personal' ORDER BY id LIMIT 1`, [uid]);
      wsId = found.rows[0] ? found.rows[0].id : null;
    }
    if (wsId != null) {
      await executor.query(
        `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1,$2,'owner')
         ON CONFLICT (workspace_id, uid) DO NOTHING`, [wsId, uid]);
    }
    return wsId;
  }

  // ensureExternalSource (find-or-create external identity) → server/repos/sourcesRepo (инъекция; см.
  // factory-параметр). ensureChannelCanonical ниже зовёт инъектированный.

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

  // ── Channels (collector onboarding) + API keys — Sprint 1C ───────
  async function createChannel({ owner_uid, username, title }) {
    if (!enabled || owner_uid == null) return null;
    const uname = String(username || '').replace(/^@/, '').trim();
    // Finding 2: канал + его tenant-привязка — ОДНОЙ транзакцией. Иначе падение ensureChannelCanonical
    // оставляло бы активный канал с workspace_id=NULL (legacy owner_uid-fallback скрыл бы порчу).
    return transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO channels (owner_uid, username, title, status, source)
         VALUES ($1,$2,$3,'active','collector') RETURNING ${CHANNEL_COLS}`,
        [owner_uid, uname || null, title || uname || null]);
      const row = rows[0] || null;
      // Workspace now; the canonical source is stamped later, when the platform id becomes known
      // (setChannelTgId for collector channels).
      if (row) await ensureChannelCanonical(row.id, owner_uid, {}, client);
      return row;
    });
  }

  // Standalone Instagram source — a channels row not backed by any Telegram channel
  // (source='ig', no tg_channel_id). Callers dedup by identity FIRST (findIgChannelByIgUser)
  // so reconnecting the same IG account refreshes its token instead of duplicating the source.
  async function createIgChannel({ owner_uid, username }) {
    if (!enabled || owner_uid == null) return null;
    const uname = String(username || '').replace(/^@/, '').trim();
    // Finding 2: канал + workspace-привязка одной транзакцией (см. createChannel).
    return transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO channels (owner_uid, username, title, status, source)
         VALUES ($1,$2,$3,'active','ig') RETURNING ${CHANNEL_COLS}`,
        [owner_uid, uname || null, uname || 'Instagram']);
      const row = rows[0] || null;
      // Workspace now; the IG canonical source lands in saveIgAccount (ig_user_id known there).
      if (row) await ensureChannelCanonical(row.id, owner_uid, {}, client);
      return row;
    });
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
    // Finding 2: канал + tenant/canonical-привязка одной транзакцией (см. createChannel).
    return transaction(async (client) => {
      const { rows } = await client.query(
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
        }, client);
      }
      return row;
    });
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
  // touch=false — read-only аутентификация (GET /api/collector/compatibility): без UPDATE
  // last_used_at, чтобы GET не генерировал WAL на каждом пробнике коллектора. Доставка
  // данных (ingest) идёт с дефолтным touch=true и двигает отметку как раньше.
  async function getChannelByApiKey(keyHash, { touch = true } = {}) {
    if (!enabled) return null;
    const { rows } = touch
      ? await pool.query(
          'UPDATE api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL RETURNING channel_id', [keyHash])
      : await pool.query(
          'SELECT channel_id FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL', [keyHash]);
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
        WHERE k.channel_id=$1 AND ${channelAdminAccessSql({ uidParam: '$2' })}
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
          AND ${channelAdminAccessSql({ uidParam: '$3' })}
          AND k.revoked_at IS NULL`, [keyId, channelId, uid]);
    return rowCount > 0;
  }

  // ── Timeline annotations (per-channel event markers on the trend charts) ──
  async function listAnnotations(channelId) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      // Новейшие 500 под кэпом (LIMIT по ASC ронял бы СВЕЖИЕ), отдаём хронологически (ASC).
      `SELECT id, to_char(day,'YYYY-MM-DD') AS day, label,
              to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
         FROM (SELECT id, day, label, created_at FROM chart_annotations
               WHERE channel_id=$1 ORDER BY day DESC, id DESC LIMIT 500) t
         ORDER BY day ASC, id ASC`, [channelId]);
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

  return {
    listChannels, getChannel, getChannelById, getOwnerChannelId, setChannelTgId,
    ensurePersonalWorkspace, ensureChannelCanonical,
    createChannel, createIgChannel, findIgChannelByIgUser, createTgChannel, deleteChannel,
    createApiKey, getChannelByApiKey, listApiKeys, revokeApiKey,
    listAnnotations, createAnnotation, deleteAnnotation,
  };
}

module.exports = { createChannelsRepo };
