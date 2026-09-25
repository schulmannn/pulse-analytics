// ═══════════════════════════════════════════════════════════════
//  Atlavue — проактивное продление токенов Instagram (job)
// ═══════════════════════════════════════════════════════════════
// Продление токена жило ТОЛЬКО в хвосте чтения (resolveIg → refreshIgIfNeeded) и дневного сбора:
// пока аккаунт читают — он продлевается, а стоит перестать смотреть экран Instagram, и 60-дневный
// токен спокойно доезжает до истечения. Ровно так @bynotem и умер 1 сентября 2026.
// Эта полоса раз в проход operational-бегунка сама обходит все подключённые аккаунты и продлевает
// те, что вошли в окно, ещё до того, как их кто-то откроет. Продление идемпотентно: refreshIgIfNeeded
// повторно проверяет окно, поэтому лишний проход ничего не портит, а разошедшийся тик — не удваивает.
//
// Границы: без БД и без ключа шифрования полоса инертна; ошибка одного аккаунта изолирована
// (boundedAllSettled никогда не реджектит), в лог идут только счётчики и channelId — ни токена,
// ни тела ответа Graph. Причину конкретного отказа пишет сам refreshIgIfNeeded.

'use strict';

const { boundedAllSettled } = require('../lib/boundedSettled');
const { igTokenDueForRefresh } = require('../domain/igToken');

const IG_REFRESH_CONCURRENCY = 2;

function createIgTokenRefreshJob({ db, log = () => {}, igCrypto, refreshIgIfNeeded, clock = Date.now } = {}) {
  // Один проход: { due, refreshed, rejected }. Возвращается наружу — тестируемо и пригодно
  // как ручной триггер; в operational-бегунке это отдельная полоса.
  async function processIgTokenRefresh() {
    const stats = { due: 0, refreshed: 0, rejected: 0 };
    if (!db.enabled || !igCrypto.configured()) return stats;
    let accounts = [];
    try {
      accounts = await db.listIgAccounts();
    } catch (e) {
      log('error', 'ig_list_accounts_failed', { error: e.message });
      return stats;
    }
    const now = clock();
    // Истёкшие сюда НЕ попадают: продлить их нельзя (Graph отдаст OAuthException), их состояние
    // уже видно пользователю как «переподключите». Далёкие от истечения не жгут вызов зря.
    const due = (Array.isArray(accounts) ? accounts : []).filter(
      (acc) => acc && acc.access_token_enc && igTokenDueForRefresh(acc.token_expires_at, now),
    );
    stats.due = due.length;
    if (!due.length) return stats;

    const settled = await boundedAllSettled(due, async (acc) => {
      const token = igCrypto.decrypt(acc.access_token_enc);
      const next = await refreshIgIfNeeded(acc.channel_id, token, acc.token_expires_at);
      // refreshIgIfNeeded НИКОГДА не бросает и возвращает старый токен при отказе — смена значения
      // и есть единственный честный признак успеха, не требующий второго чтения из БД.
      return next !== token;
    }, IG_REFRESH_CONCURRENCY);

    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value === true) { stats.refreshed++; return; }
      stats.rejected++;
      if (r.status === 'rejected') {
        log('warn', 'ig_token_refresh_account_failed', {
          channelId: due[i] && due[i].channel_id,
          error: r.reason && r.reason.message,
        });
      }
    });
    log('info', 'ig_token_refresh_pass', stats);
    return stats;
  }

  return { processIgTokenRefresh };
}

module.exports = { createIgTokenRefreshJob };
