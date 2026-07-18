'use strict';

// Сводка концентрации товаров для /api/ms/top-products. Считается по ПОЛНОМУ нормализованному
// raw-отчёту профита (копейки) ДО сортировки и limit — это единственный честный знаменатель
// «доли нескольких SKU». Величины наружу — в РУБЛЯХ (как и rows роута). Ничего не выдумываем:
//   • truncated/incomplete raw → сводки нет (null): доля по частичному знаменателю была бы враньём;
//   • доля отдельной метрики = null, если её положительный знаменатель <= 0 (пустой/убыточный срез);
//   • чистая маржа = null при неположительной чистой выручке (канон «маржа только при выручке > 0»);
//   • отрицательные/нулевые строки НЕ уменьшают знаменатель и не дают >100% или отрицательных долей.
const { kopecksToRub } = require('./msClient');

// Заголовок «топ-N доля»: сколько выручки/прибыли дают N крупнейших позиций.
const TOP_SHARE_N = 10;

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

module.exports = { summarizeTopProducts, TOP_SHARE_N };
