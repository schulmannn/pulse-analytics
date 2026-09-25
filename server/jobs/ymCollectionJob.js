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
//   • ПЕРВЫЙ проход после connect (маркер качества не проставлен) — бэкфилл ВСЕЙ истории
//     счётчика одним отчётом: Метрика отдаёт полный диапазон с dimensions=ym:s:date (потолок
//     limit=100000 строк — это ~270 лет дневных точек, хватает всем). Тот же одноразовый бэкфилл
//     докапывает КАЧЕСТВО существующим непустым архивам слайсов 1–3 (визиты уже есть, полей
//     качества нет): решает durable per-account маркер quality_backfilled_at (034), а не пустота
//     архива. Дальше — окно [сегодня−7 … сегодня]: Метрика допересчитывает свежие дни (дорезка
//     сессий, пересмотр роботности) в обе стороны, поэтому каждый прогон пере-снимает хвост
//     недели, а upsertYmDaily честно ЗАМЕНЯЕТ точки окна (не COALESCE).
//   • Отчёт — 10 метрик СТАБИЛЬНОГО порядка (YM_DAILY_METRICS_ORDER): визиты/посетители/
//     просмотры + отказы/длительность/глубина/новые/доля новых + роботность (robotVisits/
//     robotPercentage). 10 ≤ лимита метрик на запрос. Счётчики — целые; доли/средние — nullable
//     («нет данных» ≠ «0»), округляются как живые summary-роуты.
//   • Окно дозаполняется нулями У СЧЁТЧИКОВ и NULL У ДОЛЕЙ (у Метрики строки есть только у дней
//     С трафиком): архив остаётся плотным, «Всё» рисует честные провалы, а фиктивных 0% отказов
//     в дни без трафика нет. Бэкфилл нулит только от ПЕРВОГО дня с данными — мёртвую зону до
//     запуска сайта в архив не пишем.
//   • Durable day-gate db.runJobOnce('ym_collect', '<channel>:<counter>:q2:<day>') — recovery-
//     бегунок гоняет проход каждый интервал, но реальный сбор случается раз в день; сбой дня
//     помечается failed → следующий проход добирает. counter_id в ключе — тот же урок, что
//     accountKey МС-прохода: reconnect ДРУГОГО счётчика тем же каналом не наследует succeeded.
//     Версия `q2` в ключе — чтобы деплой нового 10-метричного сбора не ждал завтра, если старый
//     3-метричный день уже помечен succeeded: у нового ключа свой claim и он соберёт сегодня же.
//   • Маркер качества ставится ТОЛЬКО после успешного НЕПУСТОГО upsert'а полного бэкфилла и
//     guarded channel+counter (markYmQualityBackfilled): пустой upstream / ошибка НЕ сжигают
//     маркер — история качества добирается следующим проходом (retryable).
//   • Дешифровка — ДО claim'а гейта: битый ключ/блоб не сжигает день (после починки
//     YM_TOKEN_KEY тот же день ещё собираем), ошибка — log.warn и skip, прогон не падает.
//   • accuracy=full — сэмплирование выключено: архив и живые роуты считают одинаково.

'use strict';

// Консервативный якорь бэкфилла, когда дата создания счётчика неизвестна (старые ответы
// management API): раньше любого реального счётчика продукта, лишние пустые годы отчёту
// Метрики не вредят — строк за них просто нет.
const YM_BACKFILL_ANCHOR_DAY = '2015-01-01';

// СТАБИЛЬНЫЙ порядок метрик дневного отчёта — контракт: reportToRows читает metrics[] по этим
// индексам, и порядок покрыт тестом. Первые три — счётчики визитов/посетителей/просмотров
// (слайсы 1–3), дальше качество и явная роботность (слайс качества). 10 метрик ≤ лимита API.
const YM_DAILY_METRICS_ORDER = [
  'ym:s:visits',
  'ym:s:users',
  'ym:s:pageviews',
  'ym:s:bounceRate',
  'ym:s:avgVisitDurationSeconds',
  'ym:s:pageDepth',
  'ym:s:newUsers',
  'ym:s:percentNewVisitors',
  'ym:s:robotVisits',
  'ym:s:robotPercentage',
];
const YM_DAILY_METRICS_PARAM = YM_DAILY_METRICS_ORDER.join(',');

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
// Число или null («нет данных» ≠ «0»): доли/средние без знаменателя честно недоступны.
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Плотная строка дня без трафика: счётчики — честный 0, доли/средние — NULL (не фиктивный 0%).
const ZERO_QUALITY_ROW = {
  visits: 0,
  users: 0,
  pageviews: 0,
  bounce_rate: null,
  avg_visit_duration_seconds: null,
  page_depth: null,
  new_users: 0,
  percent_new_visitors: null,
  robot_visits: 0,
  robot_percentage: null,
};

// metrics[] отчёта (порядок = YM_DAILY_METRICS_ORDER) → дневная строка ym_daily. Счётчики
// округляем (страховка от дробной точки upstream'а); доли/средние — nullable с тем же
// знаменательным гейтом и округлением, что у живых summary-роутов: отказ/длительность/глубина/
// роботность считаются при visits>0, доля новых — при users>0. Иначе — NULL.
function qualityRowFromMetrics(m) {
  const visits = Math.round(Number(m[0]) || 0);
  const users = Math.round(Number(m[1]) || 0);
  const pageviews = Math.round(Number(m[2]) || 0);
  const bounce = numOrNull(m[3]);
  const dur = numOrNull(m[4]);
  const depth = numOrNull(m[5]);
  const newUsers = numOrNull(m[6]);
  const pctNew = numOrNull(m[7]);
  const robotVisits = numOrNull(m[8]);
  const robotPct = numOrNull(m[9]);
  return {
    visits,
    users,
    pageviews,
    bounce_rate: visits > 0 && bounce != null ? round2(bounce) : null,
    avg_visit_duration_seconds: visits > 0 && dur != null ? round1(dur) : null,
    page_depth: visits > 0 && depth != null ? round2(depth) : null,
    // Missing metric is not a measured zero. Filled zero-traffic days are handled separately by
    // ZERO_QUALITY_ROW, while a partial/malformed upstream row must preserve unknown as NULL.
    new_users: newUsers == null ? null : Math.round(newUsers),
    percent_new_visitors: users > 0 && pctNew != null ? round2(pctNew) : null,
    robot_visits: robotVisits == null ? null : Math.round(robotVisits),
    robot_percentage: visits > 0 && robotPct != null ? round2(robotPct) : null,
  };
}

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
      byDay.set(day, qualityRowFromMetrics(m));
    }
    const start = fillFrom || Array.from(byDay.keys()).sort()[0];
    if (!start || !isDayKey(start) || !isDayKey(fillTo)) return [];
    const out = [];
    // Итерация дней в UTC-полднях — DST-безопасно.
    let cursor = Date.parse(`${start}T12:00:00Z`);
    const end = Date.parse(`${fillTo}T12:00:00Z`);
    while (cursor <= end) {
      const day = new Date(cursor).toISOString().slice(0, 10);
      const row = byDay.get(day) || { ...ZERO_QUALITY_ROW };
      out.push({ day, ...row });
      cursor += 24 * 60 * 60 * 1000;
    }
    return out;
  }

  // Сбор одного счётчика: пока маркер качества не проставлен — бэкфилл ВСЕЙ истории (покрывает и
  // пустой архив нового счётчика, и существующий непустой архив без полей качества), иначе окно с
  // перекрытием. Бросает при любом сбое (fetch или запись) — вызывающий (день-гейт runJobOnce)
  // пометит день failed/retryable; частичной записи не бывает (все метрики приходят одним отчётом).
  async function collectYmForAccount(acc, token) {
    const backfill = !acc.quality_backfilled_at;
    const { date1, date2 } = backfill
      ? { date1: acc.counter_created_day || YM_BACKFILL_ANCHOR_DAY, date2: fmtDay(new Date()) }
      : collectionWindow();
    const body = await ymFetch(
      token,
      `/stat/v1/data?ids=${encodeURIComponent(acc.counter_id)}` +
        `&metrics=${YM_DAILY_METRICS_PARAM}` +
        '&dimensions=ym:s:date&sort=ym:s:date' +
        `&date1=${date1}&date2=${date2}` +
        '&limit=100000&accuracy=full',
    );
    const rows = reportToRows(body, { fillFrom: backfill ? null : date1, fillTo: date2 });
    if (rows.length) await db.upsertYmDaily(acc.channel_id, rows);
    // Маркер — ТОЛЬКО на успешном НЕПУСТОМ бэкфилле, guarded channel+counter. Пустой upstream
    // (rows=0) не сжигает маркер: следующий проход добьёт историю качества. Ошибка fetch/записи
    // бросается выше (сюда управление не доходит), поэтому маркер и день остаются retryable.
    if (backfill && rows.length) {
      await db.markYmQualityBackfilled(acc.channel_id, acc.counter_id);
    }
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
        const accountKey = `${acc.channel_id}:${acc.counter_id || 'unknown'}:q2:${day}`;
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

module.exports = { createYmCollectionJob, YM_BACKFILL_ANCHOR_DAY, YM_DAILY_METRICS_ORDER };
