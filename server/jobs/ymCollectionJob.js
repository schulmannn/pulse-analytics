// ═══════════════════════════════════════════════════════════════
//  Atlavue — дневной сбор Яндекс.Метрики в архив ym_daily (job)
// ═══════════════════════════════════════════════════════════════
// Зеркало msCollectionJob по роли: живые summary-роуты видят только «сейчас», а этот джоб
// раз в день складывает дневные точки визитов/посетителей/просмотров в ym_daily, чтобы копить
// историю («Всё» в summary читается из архива). Это НЕ req/res-путь: resolveYm неприменим
// (нет req и ownership-проверки — крон доверенный), токен дешифруется прямо здесь и живёт
// только в заголовке запроса (ymFetch), в логи/ошибки не попадает по построению.
//
// Ключевые решения:
//   • ПЕРВЫЙ проход после connect (архив пуст) — бэкфилл ВСЕЙ истории счётчика одним отчётом:
//     Метрика отдаёт полный диапазон с dimensions=ym:s:date (потолок limit=100000 строк —
//     это ~270 лет дневных точек, хватает всем). Дальше — окно [сегодня−7 … сегодня]:
//     Метрика допересчитывает свежие дни (дорезка сессий, пересмотр роботности) в обе
//     стороны, поэтому каждый прогон пере-снимает хвост недели, а upsertYmDaily честно
//     ЗАМЕНЯЕТ точки окна (не COALESCE).
//   • Окно дозаполняется нулями (у Метрики строки есть только у дней С трафиком): архив
//     остаётся плотным, «Всё» рисует честные провалы. Бэкфилл нулит только от ПЕРВОГО дня с
//     данными — мёртвую зону до запуска сайта в архив не пишем.
//   • Durable day-gate db.runJobOnce('ym_collect', '<channel>:<counter>:<day>') — recovery-
//     бегунок гоняет проход каждый интервал, но реальный сбор случается раз в день; сбой дня
//     помечается failed → следующий проход добирает. counter_id в ключе — тот же урок, что
//     accountKey МС-прохода: reconnect ДРУГОГО счётчика тем же каналом не наследует succeeded.
//   • Дешифровка — ДО claim'а гейта: битый ключ/блоб не сжигает день (после починки
//     YM_TOKEN_KEY тот же день ещё собираем), ошибка — log.warn и skip, прогон не падает.
//   • accuracy=full — сэмплирование выключено: архив и живые роуты считают одинаково.

'use strict';

// Консервативный якорь бэкфилла, когда дата создания счётчика неизвестна (старые ответы
// management API): раньше любого реального счётчика продукта, лишние пустые годы отчёту
// Метрики не вредят — строк за них просто нет.
const YM_BACKFILL_ANCHOR_DAY = '2015-01-01';

function createYmCollectionJob({ db, ymFetch, ymCrypto, log }) {
  // 'YYYY-MM-DD' по местным часам процесса (Railway = UTC) — та же дисциплина, что periodWindow
  // живых роутов: границы окна и день архивной точки считаются в одной системе координат.
  const fmtDay = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  // Окно дневного сбора: сегодня−7 полных дней + сегодняшний частичный (8 day-точек).
  function collectionWindow(now = new Date()) {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    return { date1: fmtDay(from), date2: fmtDay(now) };
  }

  // День строки отчёта валидируем строго до 'YYYY-MM-DD': одна кривая строка иначе доехала бы
  // до x.day::date и уронила ВЕСЬ батч-upsert (канон dayOf у МС/IG).
  const isDayKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  // Отчёт «по дням» → строки ym_daily. Дни с трафиком приходят из отчёта, остальное окно
  // [fillFrom..fillTo] дозаполняется честными нулями; backfill-режим (fillFrom=null) нулит
  // только от первого дня с данными. Пустой отчёт в backfill-режиме → пустой список (архив
  // не засеивается нулями, решение «бэкфилл или окно» не сгорает зря).
  function reportToRows(body, { fillFrom, fillTo }) {
    const byDay = new Map();
    const rows = body && Array.isArray(body.data) ? body.data : [];
    for (const r of rows) {
      const dim = r && Array.isArray(r.dimensions) && r.dimensions[0];
      const day = dim && typeof dim.name === 'string' ? dim.name.slice(0, 10) : '';
      if (!isDayKey(day)) continue;
      const m = r && Array.isArray(r.metrics) ? r.metrics : [];
      byDay.set(day, {
        // Math.round — страховка от неожиданной дробной точки upstream'а, не конверсия.
        visits: Math.round(Number(m[0]) || 0),
        users: Math.round(Number(m[1]) || 0),
        pageviews: Math.round(Number(m[2]) || 0),
      });
    }
    const start = fillFrom || Array.from(byDay.keys()).sort()[0];
    if (!start || !isDayKey(start) || !isDayKey(fillTo)) return [];
    const out = [];
    // Итерация дней в UTC-полднях — DST-безопасно.
    let cursor = Date.parse(`${start}T12:00:00Z`);
    const end = Date.parse(`${fillTo}T12:00:00Z`);
    while (cursor <= end) {
      const day = new Date(cursor).toISOString().slice(0, 10);
      const row = byDay.get(day) || { visits: 0, users: 0, pageviews: 0 };
      out.push({ day, ...row });
      cursor += 24 * 60 * 60 * 1000;
    }
    return out;
  }

  // Сбор одного счётчика: пустой архив → бэкфилл всей истории, иначе окно с перекрытием.
  // Бросает при любом сбое (fetch или запись) — вызывающий (день-гейт runJobOnce) пометит день
  // failed/retryable; частичной записи не бывает (все три метрики приходят одним отчётом).
  async function collectYmForAccount(acc, token) {
    const backfill = !(await db.hasYmDaily(acc.channel_id));
    const { date1, date2 } = backfill
      ? { date1: acc.counter_created_day || YM_BACKFILL_ANCHOR_DAY, date2: fmtDay(new Date()) }
      : collectionWindow();
    const body = await ymFetch(
      token,
      `/stat/v1/data?ids=${encodeURIComponent(acc.counter_id)}` +
        '&metrics=ym:s:visits,ym:s:users,ym:s:pageviews' +
        '&dimensions=ym:s:date&sort=ym:s:date' +
        `&date1=${date1}&date2=${date2}` +
        '&limit=100000&accuracy=full',
    );
    const rows = reportToRows(body, { fillFrom: backfill ? null : date1, fillTo: date2 });
    if (rows.length) await db.upsertYmDaily(acc.channel_id, rows);
    return rows.length;
  }

  // Один проход по всем подключённым счётчикам живых каналов. Сводка прохода — зеркало МС:
  //   channels — счётчиков реально собрано; days — суммарно upsert'нутых day-строк;
  //   errors — счётчиков со сбоем; skipped — day-gate уже закрыт (не ошибка и не работа).
  async function runYmCollectionPass() {
    const stats = { channels: 0, days: 0, errors: 0, skipped: 0 };
    if (!db.enabled || !ymCrypto.configured()) return stats;   // без YM_TOKEN_KEY токенов нет
    const day = new Date().toISOString().slice(0, 10);
    let accounts = [];
    try { accounts = await db.listYmAccounts(); }
    catch (e) { log('error', 'ym_list_accounts_failed', { error: e.message }); return stats; }
    for (const acc of accounts) {
      let token;
      try {
        token = ymCrypto.decrypt(acc.access_token_enc);
      } catch (e) {
        // Ключ сменили/блоб побит: skip БЕЗ claim'а дня — после починки ключа этот же день ещё
        // соберётся. Ни ciphertext, ни plaintext в лог не попадают (ошибка decrypt — статичная).
        log('warn', 'ym_token_decrypt_failed', { channelId: acc.channel_id, error: e.message });
        stats.errors++;
        continue;
      }
      try {
        const accountKey = `${acc.channel_id}:${acc.counter_id || 'unknown'}:${day}`;
        const out = await db.runJobOnce('ym_collect', accountKey, () => collectYmForAccount(acc, token));
        if (out.skipped) { stats.skipped++; continue; }
        stats.channels++;
        stats.days += Number(out.result) || 0;
      } catch (e) {
        // Один сбойный счётчик не рушит прогон; день остался failed → доберёт следующий проход.
        stats.errors++;
        log('error', 'ym_collect_account_failed', { channelId: acc.channel_id, error: e.message });
      }
    }
    return stats;
  }

  return { runYmCollectionPass, collectYmForAccount, reportToRows, collectionWindow };
}

module.exports = { createYmCollectionJob, YM_BACKFILL_ANCHOR_DAY };
