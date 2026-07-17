// ═══════════════════════════════════════════════════════════════
//  Atlavue — дневной сбор МойСклада в архив ms_daily (job)
// ═══════════════════════════════════════════════════════════════
// Зеркало instagramCollectionJob по роли: живые summary-роуты видят только «сейчас», а этот
// джоб раз в день складывает дневные точки продаж/заказов в ms_daily, чтобы копить историю
// («Всё» в summary читается из архива). Это НЕ req/res-путь: resolveMs неприменим (нет req и
// ownership-проверки — крон доверенный), токен дешифруется прямо здесь и живёт только в
// заголовке запроса (msFetch), в логи/ошибки не попадает по построению.
//
// Ключевые решения:
//   • Окно = [сегодня−7 00:00:00 … сегодня 23:59:00] — 7-дневное ПЕРЕКРЫТИЕ сознательно:
//     документы МС правят задним числом (в обе стороны), поэтому каждый прогон пере-снимает
//     хвост недели целиком, а upsertMsDaily честно ЗАМЕНЯЕТ точки окна (не COALESCE).
//   • День аккаунта пишется только когда пришли ОБА отчёта (sales + orders plotseries):
//     частичная строка обнулила бы вторую половину метрик — лучше честный retry всего окна.
//   • Durable day-gate db.runJobOnce('ms_collect', '<channel>:<account>:<day>') — recovery-
//     бегунок гоняет проход каждый интервал, но реальный сбор случается раз в день; сбой дня
//     помечается failed → следующий проход добирает. ms_account_id в ключе — тот же урок, что
//     accountKey IG-прохода: reconnect ДРУГОГО склада тем же каналом не наследует succeeded.
//   • Дешифровка — ДО claim'а гейта: битый ключ/блоб не сжигает день (после починки
//     MS_TOKEN_KEY тот же день ещё собираем), ошибка — log.warn и skip, прогон не падает.
//   • Лимит МС (45 запросов/3с) — per-account, поэтому ошибка одного аккаунта не тормозит
//     остальные (в отличие от app-level gate IG); msFetch сам делает один ретрай на 429.

'use strict';

function createMsCollectionJob({ db, msFetch, msCrypto, log }) {
  // 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — та же дисциплина, что periodWindow
  // живых роутов: границы окна и день архивной точки считаются в одной системе координат.
  const fmtDay = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  // Окно сбора: сегодня−7 полных дней + сегодняшний частичный (8 day-точек plotseries).
  function collectionWindow(now = new Date()) {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    return { momentFrom: `${fmtDay(from)} 00:00:00`, momentTo: `${fmtDay(now)} 23:59:00` };
  }

  // Слить series двух отчётов в строки ms_daily. Точка plotseries: { date:'YYYY-MM-DD HH:MM:SS',
  // sum: КОПЕЙКИ, quantity }. Суммы держим в копейках до самой БД (никаких рублей/float);
  // Math.round — страховка от неожиданной дробной копейки upstream'а, не конверсия.
  // День валидируем строго до 'YYYY-MM-DD': одна кривая date-строка иначе доехала бы до
  // x.day::date и уронила ВЕСЬ батч-upsert (у IG аналог — isNaN-гейт в graphsToDailyRows).
  const dayOf = (p) => {
    const day = String((p && p.date) || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  };
  function seriesToRows(sales, orders) {
    const byDay = new Map();
    const ensure = (day) => {
      let row = byDay.get(day);
      if (!row) {
        row = { day, revenue_kopecks: 0, orders_count: 0, orders_sum_kopecks: 0 };
        byDay.set(day, row);
      }
      return row;
    };
    const points = (r) => (r && Array.isArray(r.series) ? r.series : []);
    for (const p of points(sales)) {
      const day = dayOf(p);
      if (!day) continue;
      ensure(day).revenue_kopecks += Math.round(Number(p && p.sum) || 0);
    }
    for (const p of points(orders)) {
      const day = dayOf(p);
      if (!day) continue;
      const row = ensure(day);
      row.orders_sum_kopecks += Math.round(Number(p && p.sum) || 0);
      row.orders_count += Math.round(Number(p && p.quantity) || 0);
    }
    // Детерминированный порядок дней — стабильный jsonb-батч (диагностика/тесты).
    return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  // Сбор одного аккаунта: оба отчёта окна → строки → upsert. Бросает при любом сбое (fetch или
  // запись) — вызывающий (день-гейт runJobOnce) пометит день failed/retryable; частичной записи
  // не бывает по построению (upsert строго после обоих ответов).
  async function collectMsForAccount(acc, token) {
    const { momentFrom, momentTo } = collectionWindow();
    const q = `momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}&interval=day`;
    const [sales, orders] = await Promise.all([
      msFetch(token, `/report/sales/plotseries?${q}`),
      msFetch(token, `/report/orders/plotseries?${q}`),
    ]);
    const rows = seriesToRows(sales, orders);
    if (rows.length) await db.upsertMsDaily(acc.channel_id, rows);
    return rows.length;
  }

  // Один проход по всем подключённым складам живых каналов. Сводка прохода:
  //   channels — аккаунтов реально собрано в этом проходе;
  //   days     — суммарно upsert'нутых day-строк;
  //   errors   — аккаунтов со сбоем (недешифруемый токен / упавший fetch / запись);
  //   skipped  — day-gate уже закрыт (сегодня собрано или под lease) — не ошибка и не работа.
  async function runMsCollectionPass() {
    const stats = { channels: 0, days: 0, errors: 0, skipped: 0 };
    if (!db.enabled || !msCrypto.configured()) return stats;   // без MS_TOKEN_KEY токенов нет
    const day = new Date().toISOString().slice(0, 10);
    let accounts = [];
    try { accounts = await db.listMsAccounts(); }
    catch (e) { log('error', 'ms_list_accounts_failed', { error: e.message }); return stats; }
    for (const acc of accounts) {
      let token;
      try {
        token = msCrypto.decrypt(acc.access_token_enc);
      } catch (e) {
        // Ключ сменили/блоб побит: skip БЕЗ claim'а дня — после починки ключа этот же день ещё
        // соберётся. Ни ciphertext, ни plaintext в лог не попадают (ошибка decrypt — статичная).
        log('warn', 'ms_token_decrypt_failed', { channelId: acc.channel_id, error: e.message });
        stats.errors++;
        continue;
      }
      try {
        const accountKey = `${acc.channel_id}:${acc.ms_account_id || 'unknown'}:${day}`;
        const out = await db.runJobOnce('ms_collect', accountKey, () => collectMsForAccount(acc, token));
        if (out.skipped) { stats.skipped++; continue; }
        stats.channels++;
        stats.days += Number(out.result) || 0;
      } catch (e) {
        // Один сбойный склад не рушит прогон; день остался failed → доберёт следующий проход.
        stats.errors++;
        log('error', 'ms_collect_account_failed', { channelId: acc.channel_id, error: e.message });
      }
    }
    return stats;
  }

  return { runMsCollectionPass, collectMsForAccount, seriesToRows, collectionWindow };
}

module.exports = { createMsCollectionJob };
