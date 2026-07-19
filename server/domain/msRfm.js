'use strict';

const SEGMENT_ORDER = ['champions', 'loyal', 'potential', 'new', 'at_risk', 'hibernating'];

function scoreByMidRank(rows, valueOf, { lowerIsBetter = false } = {}) {
  const indexed = rows.map((row, index) => ({ index, value: Number(valueOf(row)) }));
  if (indexed.length === 0) return [];
  const unique = new Set(indexed.map((item) => item.value));
  if (unique.size === 1) return indexed.map(() => 3);

  indexed.sort((a, b) => a.value - b.value || a.index - b.index);
  const scores = Array(indexed.length).fill(3);
  for (let start = 0; start < indexed.length;) {
    let end = start;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[start].value) end += 1;
    const midRank = (start + end) / 2;
    const ascendingScore = Math.round(1 + (4 * midRank) / (indexed.length - 1));
    const score = lowerIsBetter ? 6 - ascendingScore : ascendingScore;
    for (let i = start; i <= end; i += 1) scores[indexed[i].index] = score;
    start = end + 1;
  }
  return scores;
}

function segmentOf({ r, f, m, orders = 0 }) {
  if (orders >= 2 && r >= 4 && f >= 4 && m >= 4) return 'champions';
  if (r >= 4 && (orders === 1 || f <= 2)) return 'new';
  if (orders >= 2 && r >= 3 && f >= 3 && m >= 3) return 'loyal';
  if (r <= 2 && (f >= 3 || m >= 3)) return 'at_risk';
  if (r <= 2 && f <= 2 && m <= 2) return 'hibernating';
  return 'potential';
}

const round1 = (value) => Math.round(value * 10) / 10;

// ЕДИНСТВЕННОЕ место присвоения scores/сегмента строке: и агрегат (buildMsRfm), и листинг
// (buildMsRfmCustomers) проходят здесь, поэтому инвариант «счётчики сегмента листинга ==
// segments[].customers агрегата на тех же rows» держится кодом, а не дисциплиной. Exact numeric
// contract проверяет ТОЛЬКО скоринговые метрики; сервисные поля листинга (city/last_day)
// пропускаются прозрачно, как есть.
function scoreAndSegment(rows) {
  const clean = rows.map((row) => {
    const recency = Number(row.recency_days);
    const orders = Number(row.orders);
    const monetary = Number(row.sum_kopecks);
    if (row.recency_days == null || row.orders == null || row.sum_kopecks == null
      || !Number.isSafeInteger(recency) || recency < 0
      || !Number.isSafeInteger(orders) || orders < 0
      || !Number.isSafeInteger(monetary)) {
      const error = new Error('RFM metric is outside the exact numeric contract');
      error.code = 'ms_rfm_metric_out_of_range';
      throw error;
    }
    const out = {
      agent_id: String(row.agent_id),
      recency_days: recency,
      orders,
      sum_kopecks: monetary,
    };
    if (row.last_day !== undefined) out.last_day = row.last_day;
    if (row.city !== undefined) out.city = row.city;
    return out;
  });
  const rScores = scoreByMidRank(clean, (row) => row.recency_days, { lowerIsBetter: true });
  const fScores = scoreByMidRank(clean, (row) => row.orders);
  const mScores = scoreByMidRank(clean, (row) => row.sum_kopecks);
  return clean.map((row, index) => ({
    ...row,
    r: rScores[index],
    f: fScores[index],
    m: mScores[index],
    segment: segmentOf({ r: rScores[index], f: fScores[index], m: mScores[index], orders: row.orders }),
  }));
}

/**
 * Build aggregate-only RFM output. Scores are relative to the selected customer population;
 * mid-ranks keep ties identical and an all-tied dimension neutral at 3.
 */
function buildMsRfm(rows, { asOf, noAgentOrders = 0 } = {}) {
  const scored = scoreAndSegment(rows);
  const buckets = new Map(SEGMENT_ORDER.map((key) => [key, {
    key, customers: 0, orders: 0, sum_kopecks: 0,
    recency_days_total: 0, frequency_total: 0, monetary_kopecks_total: 0,
  }]));

  scored.forEach((row) => {
    const bucket = buckets.get(row.segment);
    bucket.customers += 1;
    bucket.orders += row.orders;
    bucket.sum_kopecks += row.sum_kopecks;
    bucket.recency_days_total += row.recency_days;
    bucket.frequency_total += row.orders;
    bucket.monetary_kopecks_total += row.sum_kopecks;
  });

  const segments = SEGMENT_ORDER.map((key) => {
    const bucket = buckets.get(key);
    const denominator = bucket.customers;
    return {
      key,
      customers: denominator,
      orders: bucket.orders,
      sum_kopecks: bucket.sum_kopecks,
      average_recency_days: denominator ? round1(bucket.recency_days_total / denominator) : null,
      average_frequency: denominator ? round1(bucket.frequency_total / denominator) : null,
      average_monetary_kopecks: denominator ? bucket.monetary_kopecks_total / denominator : null,
    };
  });

  return {
    as_of: asOf || null,
    customers: scored.length,
    no_agent_orders: Math.max(0, Number(noAgentOrders) || 0),
    total_orders: scored.reduce((sum, row) => sum + row.orders, 0),
    total_sum_kopecks: scored.reduce((sum, row) => sum + row.sum_kopecks, 0),
    segments,
  };
}

/**
 * Листинг покупателей ОДНОГО сегмента: тот же скоринг/присвоение (scoreAndSegment), что у
 * buildMsRfm — по построению счётчик сегмента здесь всегда равен segments[].customers агрегата
 * на тех же rows. rows — ВСЯ популяция окна (scores относительны популяции, фильтровать до
 * скоринга нельзя). Сортировка контрактная: sum_kopecks DESC → orders DESC → agent_id ASC.
 */
function buildMsRfmCustomers(rows, { segment, asOf } = {}) {
  if (!SEGMENT_ORDER.includes(segment)) {
    const error = new Error('unknown RFM segment');
    error.code = 'ms_rfm_unknown_segment';
    throw error;
  }
  const picked = scoreAndSegment(rows)
    .filter((row) => row.segment === segment)
    .sort((a, b) => b.sum_kopecks - a.sum_kopecks
      || b.orders - a.orders
      || (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0));
  return {
    as_of: asOf || null,
    total_customers: picked.length,
    customers: picked.map((row) => {
      const out = {
        agent_id: row.agent_id,
        recency_days: row.recency_days,
        orders: row.orders,
        sum_kopecks: row.sum_kopecks,
        r: row.r,
        f: row.f,
        m: row.m,
      };
      if (row.last_day !== undefined) out.last_day = row.last_day;
      if (row.city !== undefined) out.city = row.city;
      return out;
    }),
  };
}

module.exports = { SEGMENT_ORDER, scoreByMidRank, segmentOf, buildMsRfm, buildMsRfmCustomers };
