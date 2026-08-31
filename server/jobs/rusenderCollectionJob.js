// ═══════════════════════════════════════════════════════════════
//  Atlavue — дневной сбор Rusender в архив (job)
// ═══════════════════════════════════════════════════════════════
// Зеркало ymCollectionJob по роли: живые роуты видят только «сейчас», а этот проход раз в день
// складывает в архив три вещи, каждую по своей причине:
//
//   1. СНИМОК БАЗЫ КОНТАКТОВ (rusender_daily) — единственный способ вообще иметь эту историю:
//      /contacts/statistics отдаёт только текущее число, истории у API НЕТ. Поэтому график
//      роста базы начинается с даты подключения, и дорисовать прошлое нечем. Бэкфилла здесь
//      не бывает и быть не может — это свойство источника, а не недоделка.
//   2. РАССЫЛКИ (rusender_campaigns) — контент-единицы. Снимок пере-снимается ЦЕЛИКОМ: у живой
//      рассылки растут открытия, меняется статус, её переименовывают и архивируют.
//   3. ДНЕВНАЯ АКТИВНОСТЬ (rusender_campaign_activity) — единственный настоящий временной ряд
//      во всём API, и он ПОШТУЧНЫЙ: один запрос на рассылку. Отсюда ограниченная пачка +
//      ротация, а не «обойти все» (см. listRusenderCampaignsForActivity).
//
// Это НЕ req/res-путь: ownership-проверки неприменимы (крон доверенный), ключ дешифруется прямо
// здесь и живёт только в заголовке запроса (rusenderFetch), в логи/ошибки не попадает.
//
// ДВЕ ЛОВУШКИ, ЗАЛОЖЕННЫЕ В КОД, А НЕ В НАДЕЖДУ:
//   • A/B-СЕМЬЯ. Спека предупреждает: stats базовой рассылки В СПИСКЕ — агрегат по семье. Если
//     варианты приезжают ещё и отдельными строками, наивная сумма посчитает семью дважды (класс
//     альбомов Telegram). Проход проставляет parts[] → parent_id, а витрины суммируют только
//     базовые строки (миграция 040). Обе возможные реальности безопасны.
//   • ПАГИНАЦИЯ. Имена query-параметров не документированы; fetchAllPages ведёт цикл ПО ОТВЕТУ
//     и честно встаёт, если сервер их игнорирует, вместо вечного кружения с дублями.
//
// Durable day-gate: db.runJobOnce('rusender_collect', '<channel>:<account>:v1:<day>') — recovery-
// бегунок гоняет проход каждый интервал, но реальный сбор случается раз в день; сбой дня
// помечается failed → следующий проход добирает. account_id в ключе — тот же урок, что у ЯМ:
// reconnect ДРУГОГО аккаунта тем же каналом не наследует сегодняшний succeeded.

'use strict';

// Сколько рассылок за один проход обновляют дневную активность. Каждая — отдельный HTTP-запрос,
// поэтому число небольшое: свежие обновляются всегда, архив вращается по кругу.
const ACTIVITY_PER_PASS = 40;

/** 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — та же дисциплина, что у ЯМ/МС. */
function fmtDay(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const isDayKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Целое или null: «поля нет» ≠ «ноль». Витрины отличают отсутствие статистики от нулевой. */
function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Строка или null, с обрезкой: имена/темы рассылок приходят от пользователя Rusender. */
function strOrNull(v, max = 500) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** ISO-время или null. Кривую строку отбрасываем здесь, чтобы не уронить jsonb-каст батча. */
function tsOrNull(v) {
  if (typeof v !== 'string' || !v) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Счётчик из формы Rusender. У кампании метрики приходят объектом { count, rate } (кроме total —
 * он голое число). Берём ТОЛЬКО count: rate пересчитывается витриной из count/delivered, потому
 * что знаменатель у нас должен быть один и тот же во всех местах.
 */
const metricCount = (m) => (m && typeof m === 'object' ? intOrNull(m.count) : intOrNull(m));

/** Элемент списка рассылок → строка rusender_campaigns. */
function campaignRow(item, { parentId = null, familyRole = null } = {}) {
  if (!item || item.id == null) return null;
  const stats = item.stats && typeof item.stats === 'object' ? item.stats : null;
  const lists = Array.isArray(item.lists)
    ? item.lists.map((l) => strOrNull(l && l.name, 120)).filter(Boolean).slice(0, 25)
    : null;
  return {
    campaign_id: intOrNull(item.id),
    name: strOrNull(item.name),
    subject: strOrNull(item.subject),
    preview_title: strOrNull(item.previewTitle),
    type: strOrNull(item.type, 40),
    status: strOrNull(item.status, 40),
    sender_email: strOrNull(item.senderEmail, 200),
    sender_name: strOrNull(item.senderName, 200),
    list_names: lists && lists.length ? lists : null,
    is_archived: !!item.isArchived,
    scheduled_at: tsOrNull(item.scheduledAt),
    started_at: tsOrNull(item.startedAt),
    finished_at: tsOrNull(item.finishedAt),
    remote_created_at: tsOrNull(item.createdAt),
    total: stats ? intOrNull(stats.total) : null,
    sending: stats ? metricCount(stats.sending) : null,
    delivered: stats ? metricCount(stats.delivered) : null,
    opens: stats ? metricCount(stats.open) : null,
    clicks: stats ? metricCount(stats.click) : null,
    errors: stats ? metricCount(stats.error) : null,
    unsubscribes: stats ? metricCount(stats.unsubscribe) : null,
    complaints: stats ? metricCount(stats.complaint) : null,
    parent_id: parentId,
    family_role: familyRole,
  };
}

/**
 * Список рассылок (обе выборки) → строки архива, с раскрытием семей.
 *
 * Каждая базовая рассылка с непустым parts[] порождает: свою строку (parent_id=NULL) И строки
 * частей. Часть могла приехать и самостоятельным элементом списка — тогда её строка из parts[]
 * и её же строка из списка схлопнутся по (channel_id, campaign_id), а parent_id переживёт
 * благодаря COALESCE в upsert'е (порядок страниц не гарантирован).
 *
 * Дедуп по campaign_id ОБЯЗАТЕЛЕН: две выборки (архивные/не архивные) могут пересечься, а
 * jsonb_to_recordset + ON CONFLICT в одном батче на дублирующем ключе падает
 * («ON CONFLICT DO UPDATE command cannot affect row a second time»).
 */
function campaignRowsFromLists(items) {
  const byId = new Map();
  const put = (row) => {
    if (!row || row.campaign_id == null) return;
    const prev = byId.get(row.campaign_id);
    if (!prev) { byId.set(row.campaign_id, row); return; }
    // Уже видели: сохраняем ЗНАНИЕ О СЕМЬЕ, откуда бы оно ни пришло, и предпочитаем строку со
    // статистикой (у элемента списка она есть, у заглушки из parts[] — нет).
    const merged = row.total != null || prev.total == null ? { ...prev, ...row } : { ...row, ...prev };
    merged.parent_id = prev.parent_id ?? row.parent_id ?? null;
    merged.family_role = prev.family_role ?? row.family_role ?? null;
    byId.set(row.campaign_id, merged);
  };
  for (const item of items) {
    put(campaignRow(item));
    const parts = Array.isArray(item && item.parts) ? item.parts : [];
    for (const part of parts) {
      if (!part || part.id == null) continue;
      put(campaignRow(part, { parentId: intOrNull(item.id), familyRole: strOrNull(part.role, 40) }));
    }
  }
  return Array.from(byId.values());
}

/** Ответ /contacts/statistics → строка снимка базы за день. */
function contactsRow(data, day) {
  if (!data || typeof data !== 'object') return null;
  return {
    day,
    contacts_total: intOrNull(data.total),
    contacts_active: intOrNull(data.active),
    contacts_unsubscribed: intOrNull(data.unsubscribed),
    contacts_unavailable: intOrNull(data.unavailable),
  };
}

/** Ответ /campaigns/{id}/activity → дневные точки. Кривой день отбрасываем (канон dayOf). */
function activityRows(data) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const out = [];
  for (const p of items) {
    const day = p && typeof p.date === 'string' ? p.date.slice(0, 10) : '';
    if (!isDayKey(day)) continue;
    out.push({ day, opens: intOrNull(p.opens) || 0, clicks: intOrNull(p.clicks) || 0 });
  }
  return out;
}

function createRusenderCollectionJob({ db, rusenderFetch, fetchAllPages, rusenderCrypto, log }) {
  /**
   * Сбор одного аккаунта. Фазы идут по возрастанию цены и по убыванию важности, и КАЖДАЯ
   * последующая не отменяет предыдущую: сбой активности не должен стирать уже собранные
   * рассылки. Бросает только если упала первая (существенная) фаза — тогда день retryable.
   */
  async function collectRusenderForAccount(acc, apiKey) {
    const channelId = acc.channel_id;
    const today = fmtDay(new Date());
    const stats = { contacts: 0, campaigns: 0, activity: 0, activityDays: 0, errors: 0 };

    // ── Фаза 1: снимок базы контактов ──────────────────────────────────────────────────────
    // Один запрос. Падение здесь пробрасывается: если аккаунт вообще не отвечает, нет смысла
    // жечь квоту остальными фазами, и день честно остаётся retryable.
    const { data: contacts } = await rusenderFetch(apiKey, '/v1/public/contacts/statistics');
    const row = contactsRow(contacts, today);
    if (row && row.contacts_total != null) {
      stats.contacts = await db.upsertRusenderDaily(channelId, [row]);
    }

    // ── Фаза 2: рассылки ───────────────────────────────────────────────────────────────────
    // ДВЕ выборки: по умолчанию Rusender ПРЯЧЕТ архивные (`archived=false`), а `archived=true`
    // возвращает ТОЛЬКО их. Без второй выборки история молча обрывалась бы на архивации.
    const items = [];
    items.push(...await fetchAllPages(apiKey, '/v1/public/campaigns?withStats=true'));
    items.push(...await fetchAllPages(apiKey, '/v1/public/campaigns?withStats=true&archived=true'));
    const rows = campaignRowsFromLists(items);
    if (rows.length) stats.campaigns = await db.upsertRusenderCampaigns(channelId, rows);

    // ── Фаза 3: дневная активность ограниченной пачки ──────────────────────────────────────
    // Поштучные запросы, поэтому сбой ОДНОЙ рассылки не рушит проход: её курсор не двинется, и
    // следующий проход возьмёт её снова. Иначе одна битая рассылка навсегда блокировала бы
    // ротацию всех остальных.
    let ids = [];
    try {
      ids = await db.listRusenderCampaignsForActivity(channelId, { cap: ACTIVITY_PER_PASS });
    } catch (e) {
      log('warn', 'rusender_activity_pick_failed', { channelId, error: e.message });
    }
    for (const campaignId of ids) {
      try {
        const { data } = await rusenderFetch(apiKey, `/v1/public/campaigns/${campaignId}/activity`);
        const points = activityRows(data);
        // Пустой ряд — ЗАКОННЫЙ результат (рассылку ещё не открывали): курсор всё равно
        // двигается внутри upsert'а, иначе такая рассылка вечно занимала бы место в пачке.
        const n = await db.upsertRusenderCampaignActivity(channelId, campaignId, points);
        stats.activity += 1;
        stats.activityDays += n;
      } catch (e) {
        stats.errors += 1;
        log('warn', 'rusender_activity_failed', { channelId, campaignId, status: e && e.status, error: e && e.message });
      }
    }
    return stats;
  }

  /**
   * Один проход по всем подключённым аккаунтам живых каналов. Сводка зеркалит ЯМ/МС:
   *   channels — аккаунтов собрано; campaigns/activity — сколько строк тронуто;
   *   errors — аккаунтов со сбоем; skipped — day-gate уже закрыт (не ошибка и не работа).
   */
  async function runRusenderCollectionPass() {
    const out = { channels: 0, campaigns: 0, activity: 0, errors: 0, skipped: 0 };
    if (!db.enabled || !rusenderCrypto.configured()) return out;   // без RUSENDER_KEY ключей нет
    const day = new Date().toISOString().slice(0, 10);
    let accounts = [];
    try {
      accounts = await db.listRusenderAccounts();
    } catch (e) {
      log('error', 'rusender_list_accounts_failed', { error: e.message });
      return out;
    }
    for (const acc of accounts) {
      let apiKey;
      try {
        apiKey = rusenderCrypto.decrypt(acc.api_key_enc);
      } catch (e) {
        // Ключ шифрования сменили / блоб побит: skip БЕЗ claim'а дня — после починки
        // RUSENDER_KEY этот же день ещё соберётся. Ни ciphertext, ни plaintext в лог не идут.
        log('warn', 'rusender_key_decrypt_failed', { channelId: acc.channel_id, error: e.message });
        out.errors += 1;
        continue;
      }
      try {
        const gateKey = `${acc.channel_id}:${acc.account_id || 'unknown'}:v1:${day}`;
        const res = await db.runJobOnce('rusender_collect', gateKey, () => collectRusenderForAccount(acc, apiKey));
        if (res.skipped) { out.skipped += 1; continue; }
        out.channels += 1;
        const r = res.result || {};
        out.campaigns += Number(r.campaigns) || 0;
        out.activity += Number(r.activity) || 0;
      } catch (e) {
        // Один сбойный аккаунт не рушит проход; день остался failed → доберёт следующий проход.
        out.errors += 1;
        log('error', 'rusender_collect_account_failed', { channelId: acc.channel_id, error: e.message });
      }
    }
    return out;
  }

  return {
    runRusenderCollectionPass,
    collectRusenderForAccount,
    campaignRowsFromLists,
    contactsRow,
    activityRows,
  };
}

module.exports = {
  createRusenderCollectionJob,
  campaignRow,
  campaignRowsFromLists,
  contactsRow,
  activityRows,
  ACTIVITY_PER_PASS,
};
