'use strict';

// ═══════════════════════════════════════════════════════════════
//  Atlavue — доставка новых упоминаний в личку Telegram (job)
// ═══════════════════════════════════════════════════════════════
// Ежедневный хвост дня (dailyIngestJob.tails): для каждой включённой подписки с завершённой
// привязкой бота, живой managed-сессией подписчика и настроенными правилами канала — прогнать
// существующий приватный /mentions/search (сессия ПОДПИСЧИКА, его квота searchPosts), вычислить
// новые относительно архива упоминания и отправить их карточками через бота.
//
// Идемпотентность: runJobOnce('mention_notify', `${channel_id}:${uid}:${day}`) — дубль-тик дня
// не повторит ни поиск (квота!), ни отправку. Порядок внутри прогона сознательный:
//   filterNew → send → upsert → mark:
// сбой ОТПРАВКИ оставляет архив нетронутым (упоминания придут следующим прогоном — не теряем
// алерты); сбой upsert ПОСЛЕ отправки в худшем случае продублирует карточку завтра (дубль
// дешевле потери). Первый прогон подписки (last_notified_at IS NULL) СИДИРУЕТСЯ: одна сводка
// вместо пачки карточек — свежая подписка не выплёвывает весь архив.
//
// Сессии дешифруются ТОЛЬКО здесь (createTgSessionDecryptor — с lazy-rewrite под активный ключ)
// и уходят исключительно в тело приватного mtproto-вызова. Ошибки в БД/логах — только safe-коды.

const { createTgSessionDecryptor } = require('../lib/tgSessionDecrypt');
const { formatMentionCard, formatSeedMessage, formatOverflowMessage } = require('../lib/tgNotifyText');

const MAX_SUBSCRIPTIONS_PER_RUN = 30;   // страховка от бесконечного прогона (лог capped)
const MAX_CARDS_PER_RUN = 8;            // карточек за прогон; остальное — одной сводкой

const SAFE_ERROR_CODES = new Set([
  'reauth_required', 'session_decrypt_failed', 'search_failed', 'send_failed', 'bot_blocked',
]);
const safeCode = (code) => (SAFE_ERROR_CODES.has(code) ? code : 'search_failed');

function createMentionNotifyJob({
  db, log, tgCrypto, tgBot, mtprotoPost, MTPROTO_TOKEN, MTPROTO_TIMEOUT_HEAVY_MS, appUrl = '',
}) {
  const { decryptTgSession } = createTgSessionDecryptor({ tgCrypto, db, log });

  // Один прогон одной подписки. Бросает с e.notifyCode для last_error; успешный выход — объект
  // счётчиков для результата runJobOnce.
  async function runSubscription(sub) {
    let sessionStr;
    try {
      sessionStr = await decryptTgSession({ uid: sub.uid, session_version: sub.session_version, session_enc: sub.session_enc });
    } catch {
      db.recordTgSessionFailure(sub.uid, sub.session_version, { state: 'reauth_required', errorCode: 'session_decrypt_failed' })
        .catch(() => {});
      const e = new Error('session decrypt failed');
      e.notifyCode = 'session_decrypt_failed';
      throw e;
    }

    // Авто-исключение собственного канала — как в routes/mentions.js (живой поиск): единый
    // эффективный фильтр, чтобы джоб не слал «упоминания» из своего же канала.
    const excludeSources = sub.channel_username
      ? [...(sub.exclude_sources || []), String(sub.channel_username).replace(/^@/, '')]
      : (sub.exclude_sources || []).slice();
    const excludeChannelIds = sub.tg_channel_id != null ? [Number(sub.tg_channel_id)] : [];

    let data;
    try {
      data = await mtprotoPost('/mentions/search', {
        body: {
          session: sessionStr,
          include_terms: sub.include_terms || [],
          exclude_terms: sub.exclude_terms || [],
          exclude_sources: excludeSources,
          exclude_channel_ids: excludeChannelIds,
          match_mode: sub.match_mode || 'contains',
        },
        timeoutMs: MTPROTO_TIMEOUT_HEAVY_MS,
      });
    } catch (e) {
      if (e && (e.status === 401 || e.code === 'session_unauthorized' || e.code === 'mtproto_session_unauthorized')) {
        db.recordTgSessionFailure(sub.uid, sub.session_version, { state: 'reauth_required', errorCode: 'session_unauthorized' })
          .catch(() => {});
        const err = new Error('session unauthorized');
        err.notifyCode = 'reauth_required';
        throw err;
      }
      const err = new Error('mentions search failed');
      err.notifyCode = 'search_failed';
      throw err;
    }
    if (!data || data.available === false) {
      const err = new Error('mentions search unavailable');
      err.notifyCode = 'search_failed';
      throw err;
    }
    // Реальный успешный поиск — сессия жива (тот же health-контракт, что у живого поиска).
    db.recordTgSessionSuccess(sub.uid, sub.session_version).catch(() => {});

    const all = Array.isArray(data.all) ? data.all : [];
    const isSeed = !sub.last_notified_at;
    const fresh = isSeed ? [] : await db.filterNewMentions(sub.channel_id, all);

    let sent = 0;
    const send = async (text) => {
      const out = await tgBot.sendMessage(sub.chat_id, text);
      if (out && out.blocked) {
        // Пользователь заблокировал бота: сносим привязку, чтобы не долбить 403 каждый день.
        await db.unbindMentionNotifyChat(sub.chat_id).catch(() => {});
        const err = new Error('bot blocked by user');
        err.notifyCode = 'bot_blocked';
        throw err;
      }
      sent += 1;
    };

    try {
      if (isSeed) {
        await send(formatSeedMessage(sub.channel_title || sub.channel_username, all.length));
      } else {
        // Стабильный порядок — старые раньше (как читается лента).
        const ordered = [...fresh].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
        for (const mention of ordered.slice(0, MAX_CARDS_PER_RUN)) {
          await send(formatMentionCard(mention));
        }
        if (ordered.length > MAX_CARDS_PER_RUN) {
          await send(formatOverflowMessage(ordered.length - MAX_CARDS_PER_RUN, appUrl));
        }
      }
    } catch (e) {
      if (e && e.notifyCode) throw e;
      const err = new Error('bot send failed');
      err.notifyCode = 'send_failed';
      throw err;
    }

    // Архив прирастает ПОСЛЕ успешной доставки (см. шапку про порядок). Ошибка записи роняет
    // прогон в failed — ретрай следующего тика доставит дубль, но не потеряет упоминания.
    await db.upsertMentions(sub.channel_id, all);
    return { seed: isSeed, found: all.length, fresh: fresh.length, sent };
  }

  // Обход всех выполнимых подписок. Последовательно: каждая подписка — своя сессия, но бот один,
  // и параллельный фан-аут в mtproto упирается в его семафор; объёмы малы, простота важнее.
  async function processMentionNotify() {
    if (!db.enabled || !tgBot.configured() || !tgCrypto.configured() || !MTPROTO_TOKEN) return;
    let subs;
    try { subs = await db.listRunnableMentionNotifySubscriptions(); }
    catch (e) { log('error', 'mention_notify_list_failed', { error: e.message }); return; }
    if (!subs.length) return;

    const day = new Date().toISOString().slice(0, 10);
    let done = 0, notified = 0, failed = 0, skipped = 0, capped = false;
    for (const sub of subs) {
      if (done >= MAX_SUBSCRIPTIONS_PER_RUN) { capped = true; break; }
      let started = false;
      try {
        const outcome = await db.runJobOnce('mention_notify', `${sub.channel_id}:${sub.uid}:${day}`, () => {
          started = true;
          return runSubscription(sub);
        });
        if (outcome.skipped) { skipped++; continue; }
        done++;
        notified += outcome.result && outcome.result.sent ? 1 : 0;
        await db.markMentionNotifyRun(sub.channel_id, sub.uid, { notified: true, errorCode: null });
      } catch (e) {
        if (started) done++;
        failed++;
        const code = safeCode(e && e.notifyCode);
        db.markMentionNotifyRun(sub.channel_id, sub.uid, { notified: false, errorCode: code }).catch(() => {});
        // Только safe-код + идентификаторы — ни текста апстрима, ни правил, ни сессий.
        log('error', 'mention_notify_failed', { channel_id: sub.channel_id, uid: sub.uid, code });
      }
    }
    log(capped ? 'warn' : 'info', 'mention_notify_done', { total: subs.length, done, notified, failed, skipped, capped });
  }

  return { processMentionNotify };
}

module.exports = { createMentionNotifyJob };
