'use strict';

/* ── Per-channel mention settings repo (channel_mention_settings, миграция 018) ───────────────────
   Одна строка на канал: что искать в упоминаниях (include), что отсеивать (exclude/sources),
   режим совпадения. Скоуп — КАНАЛ (не workspace): правила живут ровно на channels.id.

   Контракт доступа (как в analyticsRepo, finding 5) — намерение в имени метода:
     • getMentionSettingsInternal(channelId)      — БЕЗ проверки доступа (cron/service).
     • getMentionSettingsForActor(channelId, actor) — сперва gate доступа читателя
       (getAccessibleChannel — инъекция channelsRepo.getChannel), иначе null. Читать может любой,
       кто ВИДИТ канал (в т.ч. viewer).
     • upsertMentionSettingsForActor(channelId, actor, rules) — ПИШЕТ только owner/admin, причём
       предикат channelAdminAccessSql ВШИТ в SQL-boundary (WHERE в подзапросе EXISTS): route-only
       проверка роли не доверяется (defense in depth против TOCTOU/забытого гейта).

   Каналы независимы: и чтение, и запись всегда скоупятся по channel_id — правила одного канала
   никогда не видны/не перезаписываются через другой.

   Форма ответа (нормализованная): { configured, include_terms, exclude_terms, exclude_sources,
   match_mode, updated_at, updated_by }. configured = есть хотя бы один include-термин.

   Валидация/санитизация правил — НЕ здесь: их делает чистый server/lib/mentionRules перед вызовом
   upsert (роут), репо доверяет уже-нормализованным массивам, но защитно приводит к массивам.

   Зависит от pool + enabled + channelAdminAccessSql (../db/access) + getAccessibleChannel (инъекция;
   repos не импортят друг друга). Возвращаемые null трактуются роутом как «нет доступа/не найдено». */

const { channelAdminAccessSql } = require('../db/access');

const ISO = `'YYYY-MM-DD"T"HH24:MI:SSOF'`;

function toArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function shape(row) {
  if (!row) return null;
  const include = toArray(row.include_terms);
  return {
    configured: include.length > 0,
    include_terms: include,
    exclude_terms: toArray(row.exclude_terms),
    exclude_sources: toArray(row.exclude_sources),
    match_mode: row.match_mode === 'word' ? 'word' : 'contains',
    revision: Number(row.revision || 0),
    updated_at: row.updated_at || null,
    updated_by: row.updated_by == null ? null : row.updated_by,
  };
}

// «Пусто, но существует канал» vs «строки нет» роут не различает — в обоих случаях unconfigured.
// Возвращаем null только когда СТРОКИ настроек нет; сам факт доступа к каналу проверяет caller/ForActor.
const EMPTY = () => ({
  configured: false, include_terms: [], exclude_terms: [], exclude_sources: [],
  match_mode: 'contains', revision: 0, updated_at: null, updated_by: null,
});

function createMentionSettingsRepo({ pool, enabled, getAccessibleChannel }) {
  const SELECT_COLS = `channel_id, include_terms, exclude_terms, exclude_sources, match_mode,
    revision, updated_by, to_char(updated_at,${ISO}) AS updated_at`;

  // ── Internal read (БЕЗ access-check — ТОЛЬКО cron/service) ──────────────────────────────────────
  async function getMentionSettingsInternal(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM channel_mention_settings WHERE channel_id = $1`, [channelId]);
    return rows[0] ? shape(rows[0]) : EMPTY();
  }

  // ── Actor-gated read (viewer+ может читать) ─────────────────────────────────────────────────────
  async function getMentionSettingsForActor(channelId, actor) {
    if (!enabled || !channelId) return null;
    // Deny outsiders: getAccessibleChannel (channelsRepo.getChannel) вернёт null без доступа →
    // не раскрываем даже существование строки настроек чужого канала.
    const channel = await getAccessibleChannel(channelId, actor);
    if (!channel) return null;
    return getMentionSettingsInternal(channelId);
  }

  // ── Actor-gated write (owner/admin) — предикат вшит в SQL-boundary ───────────────────────────────
  // Роль проверяется НЕ доверием к route, а EXISTS-подзапросом channelAdminAccessSql в самом INSERT:
  // если актор не owner/admin канала (или канал недоступен/disabled), подзапрос вернёт 0 строк →
  // INSERT ничего не вставит → RETURNING пуст → возвращаем null (роут → 403).
  async function upsertMentionSettingsForActor(channelId, actor, rules) {
    if (!enabled || !channelId) return null;
    const uid = actor && actor.uid;
    if (uid == null) return null;
    const include = toArray(rules && rules.include_terms);
    const exclude = toArray(rules && rules.exclude_terms);
    const sources = toArray(rules && rules.exclude_sources);
    const matchMode = rules && rules.match_mode === 'word' ? 'word' : 'contains';

    const { rows } = await pool.query(
      `INSERT INTO channel_mention_settings
         (channel_id, include_terms, exclude_terms, exclude_sources, match_mode, updated_by, created_at, updated_at)
       SELECT c.id, $3::text[], $4::text[], $5::text[], $6, $2, now(), now()
         FROM channels c
        WHERE c.id = $1 AND c.status <> 'disabled'
          AND ${channelAdminAccessSql({ channelAlias: 'c', uidParam: '$2' })}
       ON CONFLICT (channel_id) DO UPDATE SET
         include_terms = EXCLUDED.include_terms,
         exclude_terms = EXCLUDED.exclude_terms,
         exclude_sources = EXCLUDED.exclude_sources,
         match_mode = EXCLUDED.match_mode,
         revision = channel_mention_settings.revision + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING ${SELECT_COLS}`,
      [channelId, uid, include, exclude, sources, matchMode]);
    return rows[0] ? shape(rows[0]) : null;
  }

  return {
    getMentionSettingsInternal,
    getMentionSettingsForActor,
    upsertMentionSettingsForActor,
  };
}

module.exports = { createMentionSettingsRepo };
