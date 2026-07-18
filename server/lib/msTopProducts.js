'use strict';

// Сводка концентрации товаров для /api/ms/top-products. Считается по ПОЛНОМУ нормализованному
// raw-отчёту профита (копейки) ДО сортировки и limit — это единственный честный знаменатель
// «доли нескольких SKU». Величины наружу — в РУБЛЯХ (как и rows роута). Ничего не выдумываем:
//   • truncated/incomplete raw → сводки нет (null): доля по частичному знаменателю была бы враньём;
//   • доля отдельной метрики = null, если её положительный знаменатель <= 0 (пустой/убыточный срез);
//   • чистая маржа = null при неположительной чистой выручке (канон «маржа только при выручке > 0»);
//   • отрицательные/нулевые строки НЕ уменьшают знаменатель и не дают >100% или отрицательных долей.
const crypto = require('crypto');
const { kopecksToRub } = require('./msClient');

// Заголовок «топ-N доля»: сколько выручки/прибыли дают N крупнейших позиций.
const TOP_SHARE_N = 10;

// Сколько позиций показываем в каждом решающем списке сравнения (рост/падение/появились/пропали).
// Держим коротким, чтобы четыре списка + счётчики умещались в общий metric-page shell без клиппинга;
// counts отдаются отдельно — пользователь честно видит, что позиций может быть больше.
const COMPARE_MOVERS_LIMIT = 5;

// Стабильная непрозрачная identity строки ассортимента для сопоставления окон. Приоритет —
// assortment.meta.href (канонический ресурс товара/модификации у МС): его SHA-256-хэш даёт стабильный
// ключ, не раскрывая наружу сам href. href НАРУЖУ не уходит: сравнение целиком считается на сервере,
// а в ответе только имена и числа. Малформленные/legacy/фикстурные строки без href получают
// консервативный фолбэк по имени в ОТДЕЛЬНОМ пространстве имён ('n:') — он никогда не сольётся с
// href-товаром (пространство 'h:'), поэтому два разных товара с одинаковым отображаемым именем, но
// разными href, остаются разными позициями и НЕ объединяются.
function assortmentIdentity(reportRow) {
  const meta = reportRow && reportRow.assortment && reportRow.assortment.meta;
  const href = meta && typeof meta.href === 'string' ? meta.href.trim() : '';
  if (href) return `h:${crypto.createHash('sha256').update(href).digest('hex')}`;
  const name = reportRow && reportRow.assortment && typeof reportRow.assortment.name === 'string'
    ? reportRow.assortment.name.trim()
    : '';
  return `n:${name || '∅'}`;
}

// 'YYYY-MM-DD' → та же строка, сдвинутая на offset дней по МЕСТНОМУ календарю (как fmtDay роутов).
function shiftDayKey(key, offset) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(y, m - 1, d + offset);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

// Число календарных дней в инклюзивном окне [fromKey..toKey] (UTC-арифметика над днями безопасна от DST).
function inclusiveDayLength(fromKey, toKey) {
  const [fy, fm, fd] = String(fromKey).split('-').map(Number);
  const [ty, tm, td] = String(toKey).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/**
 * Ровно предыдущее равное непересекающееся окно к инклюзивному [sinceDay..untilDay].
 * Для «Всё» (sinceDay/untilDay отсутствуют) предыдущего равного окна не существует → null:
 * честнее вернуть недоступность, чем выдумать несопоставимый диапазон.
 * @returns {{ sinceDay:string, untilDay:string, momentFrom:string, momentTo:string, periodKey:string }|null}
 */
function previousWindow(sinceDay, untilDay) {
  if (!sinceDay || !untilDay) return null;
  const len = inclusiveDayLength(sinceDay, untilDay);
  if (!(len > 0)) return null;
  const prevTo = shiftDayKey(sinceDay, -1);
  const prevFrom = shiftDayKey(sinceDay, -len);
  return {
    sinceDay: prevFrom,
    untilDay: prevTo,
    momentFrom: `${prevFrom} 00:00:00`,
    momentTo: `${prevTo} 23:59:59`,
    periodKey: `r:${prevFrom}:${prevTo}`,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Доля N крупнейших положительных вкладов в положительном знаменателе (в процентах, 0.1% точность).
// denomKop — сумма положительных вкладов по той же метрике; <= 0 → доля недоступна.
function topSharePct(rows, key, denomKop) {
  if (!(denomKop > 0)) return null;
  const topKop = rows
    .map((r) => Math.round(Number(r && r[key]) || 0))
    .filter((v) => v > 0)
    .sort((a, b) => b - a)
    .slice(0, TOP_SHARE_N)
    .reduce((acc, v) => acc + v, 0);
  return round1((topKop / denomKop) * 100);
}

/**
 * @param {{ rows: Array<{revenueKopecks:number, profitKopecks:number}>, total:number, truncated:boolean }} raw
 * @returns {object|null} additive-сводка в рублях, либо null при усечённом/неполном отчёте.
 */
function summarizeTopProducts(raw) {
  if (!raw || !Array.isArray(raw.rows) || raw.truncated) return null;
  const reportedTotal = Number(raw.total);
  if (Number.isFinite(reportedTotal) && reportedTotal > raw.rows.length) return null;
  const { rows } = raw;

  let posRevenueKop = 0; // знаменатель доли выручки — только положительная выручка
  let posProfitKop = 0; // знаменатель доли прибыли — только положительная прибыль
  let netRevenueKop = 0; // чистая выручка (со знаком) — знаменатель общей маржи
  let netProfitKop = 0; // чистая прибыль (со знаком) — числитель общей маржи
  let lossCount = 0;
  let lossKop = 0; // абсолютная сумма убытка по убыточным позициям
  for (const r of rows) {
    const revKop = Math.round(Number(r && r.revenueKopecks) || 0);
    const profKop = Math.round(Number(r && r.profitKopecks) || 0);
    netRevenueKop += revKop;
    netProfitKop += profKop;
    if (revKop > 0) posRevenueKop += revKop;
    if (profKop > 0) posProfitKop += profKop;
    if (profKop < 0) {
      lossCount += 1;
      lossKop += -profKop;
    }
  }

  return {
    complete: true, // raw дошёл до конца (не упёрся в page-cap) — знаменатели полные
    product_count: rows.length, // товаров в полном отчёте (до limit)
    top_n: TOP_SHARE_N,
    revenue_positive_total: kopecksToRub(posRevenueKop), // знаменатель доли выручки, ₽
    profit_positive_total: kopecksToRub(posProfitKop), // знаменатель доли прибыли, ₽
    revenue_top10_share_pct: topSharePct(rows, 'revenueKopecks', posRevenueKop),
    profit_top10_share_pct: topSharePct(rows, 'profitKopecks', posProfitKop),
    net_margin_pct: netRevenueKop > 0 ? round1((netProfitKop / netRevenueKop) * 100) : null,
    loss_making_count: lossCount,
    loss_making_amount: kopecksToRub(lossKop), // абсолютный убыток, ₽ (>= 0)
  };
}

// Метрика изменения из нормализованной raw-строки (копейки для денег, целые штуки для units).
function rowMetricValue(row, metric) {
  if (metric === 'units') return Math.round(Number(row && row.quantity) || 0);
  if (metric === 'profit') return Math.round(Number(row && row.profitKopecks) || 0);
  return Math.round(Number(row && row.revenueKopecks) || 0);
}

// Наружу: деньги → рубли на границе, units — целым числом как есть.
function metricOut(value, metric) {
  return metric === 'units' ? value : kopecksToRub(value);
}

// Процентная дельта честна только при ПОЛОЖИТЕЛЬНОЙ предыдущей базе. Нулевая база не даёт конечного
// процента, а отрицательная валовая прибыль не имеет однозначной процентной интерпретации. В обоих
// случаях наружу null, и UI показывает абсолютную дельту. Переход с положительной базы в ноль
// остаётся настоящим −100% по формуле.
function deltaPctOf(current, previous) {
  if (!(previous > 0) || !Number.isFinite(previous) || !Number.isFinite(current)) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function moverEntry(name, current, previous, metric) {
  return {
    name: name || '',
    current: metricOut(current, metric),
    previous: metricOut(previous, metric),
    delta: metricOut(current - previous, metric),
    deltaPct: deltaPctOf(current, previous),
  };
}

// Детерминированный tie-break имён (как в рейтинге роута) — стабильный порядок при равных дельтах.
function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
}

// Списки изменения по одной метрике. Разбиение решающее: рост/падение считаются только по товарам,
// присутствующим в ОБОИХ окнах (настоящая динамика), а появившиеся/пропавшие — отдельные списки
// присутствия. Так один товар не попадает и в «рост», и в «появились».
function metricComparison(pairs, metric, limit) {
  const both = [];
  const appeared = [];
  const disappeared = [];
  for (const p of pairs) {
    if (p.cur && p.prev) {
      const c = rowMetricValue(p.cur, metric);
      const v = rowMetricValue(p.prev, metric);
      both.push({ name: p.name, c, v, delta: c - v });
    } else if (p.cur) {
      const c = rowMetricValue(p.cur, metric);
      if (c !== 0) appeared.push({ name: p.name, c });
    } else if (p.prev) {
      const v = rowMetricValue(p.prev, metric);
      if (v !== 0) disappeared.push({ name: p.name, v });
    }
  }
  const gainers = both
    .filter((e) => e.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.c - a.c || byName(a, b))
    .slice(0, limit)
    .map((e) => moverEntry(e.name, e.c, e.v, metric));
  const losers = both
    .filter((e) => e.delta < 0)
    .sort((a, b) => a.delta - b.delta || a.c - b.c || byName(a, b))
    .slice(0, limit)
    .map((e) => moverEntry(e.name, e.c, e.v, metric));
  const appearedOut = appeared
    .sort((a, b) => b.c - a.c || byName(a, b))
    .slice(0, limit)
    .map((e) => moverEntry(e.name, e.c, 0, metric));
  const disappearedOut = disappeared
    .sort((a, b) => b.v - a.v || byName(a, b))
    .slice(0, limit)
    .map((e) => moverEntry(e.name, 0, e.v, metric));
  return {
    unit: metric === 'units' ? 'count' : 'rub',
    gainers,
    losers,
    appeared: appearedOut,
    disappeared: disappearedOut,
  };
}

/**
 * Сравнение ассортимента текущего окна с предыдущим равным. Сопоставление — по стабильной
 * непрозрачной identity (assortmentIdentity), проставленной при загрузке raw. Возвраты в отчёт
 * profit не входят и здесь НЕ вычитаются (о чём честно сообщает about-копия страницы).
 * Отдаём сразу три метрики (выручка/прибыль/штуки), чтобы фронт переключал показатель без нового
 * запроса, а counts присутствия метрик-независимы.
 * @param {{rows:Array, truncated?:boolean, total?:number}} currentRaw
 * @param {{rows:Array, truncated?:boolean, total?:number}} previousRaw
 * @param {{current:{from:string,to:string}, previous:{from:string,to:string}, limit?:number}} windows
 */
function buildAssortmentComparison(currentRaw, previousRaw, windows) {
  const limit = windows && Number.isFinite(windows.limit) ? windows.limit : COMPARE_MOVERS_LIMIT;
  const curRows = currentRaw && Array.isArray(currentRaw.rows) ? currentRaw.rows : [];
  const prevRows = previousRaw && Array.isArray(previousRaw.rows) ? previousRaw.rows : [];
  // Один товар = одна строка отчёта за окно; при дубле ключа (теоретически) агрегируем в первую,
  // чтобы сопоставление оставалось 1:1 и не задваивало вклад.
  const merged = new Map();
  const combineSide = (existing, incoming) => {
    if (!existing) return incoming;
    return {
      ...existing,
      name: (incoming && incoming.name) || existing.name,
      quantity: (Number(existing.quantity) || 0) + (Number(incoming && incoming.quantity) || 0),
      revenueKopecks:
        (Number(existing.revenueKopecks) || 0) + (Number(incoming && incoming.revenueKopecks) || 0),
      profitKopecks:
        (Number(existing.profitKopecks) || 0) + (Number(incoming && incoming.profitKopecks) || 0),
    };
  };
  const ingest = (rows, side) => {
    for (const r of rows) {
      const key = r && r.key ? r.key : 'n:∅';
      let entry = merged.get(key);
      if (!entry) {
        entry = { name: r && r.name ? r.name : '', cur: null, prev: null };
        merged.set(key, entry);
      }
      if (side === 'cur') {
        entry.cur = combineSide(entry.cur, r);
        if (r && r.name) entry.name = r.name;
      } else {
        entry.prev = combineSide(entry.prev, r);
        if (!entry.name && r && r.name) entry.name = r.name;
      }
    }
  };
  ingest(curRows, 'cur');
  ingest(prevRows, 'prev');
  const pairs = [...merged.values()];
  let currentOnly = 0;
  let previousOnly = 0;
  let bothCount = 0;
  for (const p of pairs) {
    if (p.cur && p.prev) bothCount += 1;
    else if (p.cur) currentOnly += 1;
    else previousOnly += 1;
  }
  return {
    available: true,
    // Любая сторона усечена по cap либо meta.size раскрывает short page → сравнение основано на
    // частичных данных: крупный сдвиг мог остаться на недобранной странице. Результат отдаём только
    // вместе с явной пометкой неполноты.
    partial: [currentRaw, previousRaw].some((raw) => {
      if (!raw || raw.truncated) return true;
      const total = Number(raw.total);
      return Number.isFinite(total) && total > (Array.isArray(raw.rows) ? raw.rows.length : 0);
    }),
    // Нормальный live-ответ МС всегда содержит assortment.meta.href. Если его нет, fallback по
    // имени остаётся детерминированным, но потенциально неоднозначным — UI обязан показать оговорку.
    identity_fallback_count: [...merged.keys()].filter((key) => key.startsWith('n:')).length,
    current: windows.current,
    previous: windows.previous,
    counts: { current_only: currentOnly, previous_only: previousOnly, both: bothCount },
    metrics: {
      revenue: metricComparison(pairs, 'revenue', limit),
      profit: metricComparison(pairs, 'profit', limit),
      units: metricComparison(pairs, 'units', limit),
    },
    limit,
  };
}

module.exports = {
  summarizeTopProducts,
  TOP_SHARE_N,
  COMPARE_MOVERS_LIMIT,
  assortmentIdentity,
  previousWindow,
  buildAssortmentComparison,
};
