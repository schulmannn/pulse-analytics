'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreByMidRank, segmentOf, buildMsRfm, buildMsRfmCustomers, SEGMENT_ORDER,
} = require('../server/domain/msRfm');

test('RFM mid-rank: ties share a score and an all-tied dimension is neutral', () => {
  assert.deepEqual(scoreByMidRank([{ v: 10 }, { v: 10 }, { v: 10 }], (row) => row.v), [3, 3, 3]);
  const tied = scoreByMidRank([{ v: 1 }, { v: 1 }, { v: 2 }, { v: 3 }], (row) => row.v);
  assert.equal(tied[0], tied[1]);
  assert.ok(tied[0] < tied[2] && tied[2] < tied[3]);
  assert.deepEqual(scoreByMidRank([{ v: 1 }, { v: 2 }, { v: 3 }], (row) => row.v, { lowerIsBetter: true }), [5, 3, 1]);
});

test('RFM segments are mutually exclusive with stable business precedence', () => {
  assert.equal(segmentOf({ r: 5, f: 5, m: 5, orders: 8 }), 'champions');
  assert.equal(segmentOf({ r: 3, f: 3, m: 3, orders: 2 }), 'loyal');
  assert.equal(segmentOf({ r: 5, f: 3, m: 5, orders: 1 }), 'new');
  assert.equal(segmentOf({ r: 1, f: 5, m: 2, orders: 4 }), 'at_risk');
  assert.equal(segmentOf({ r: 1, f: 1, m: 1, orders: 1 }), 'hibernating');
  assert.equal(segmentOf({ r: 3, f: 2, m: 4, orders: 1 }), 'potential');
});

test('RFM aggregate reconciles customers, orders, money and excluded anonymous orders', () => {
  const result = buildMsRfm([
    { agent_id: 'a', recency_days: 0, orders: 4, sum_kopecks: 9000 },
    { agent_id: 'b', recency_days: 5, orders: 2, sum_kopecks: 3000 },
    { agent_id: 'c', recency_days: 20, orders: 1, sum_kopecks: 500 },
  ], { asOf: '2026-07-18', noAgentOrders: 2 });
  assert.equal(result.as_of, '2026-07-18');
  assert.equal(result.customers, 3);
  assert.equal(result.no_agent_orders, 2);
  assert.equal(result.total_orders, 7);
  assert.equal(result.total_sum_kopecks, 12500);
  assert.deepEqual(result.segments.map((segment) => segment.key), SEGMENT_ORDER);
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.customers, 0), 3);
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.orders, 0), 7);
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.sum_kopecks, 0), 12500);
});

test('RFM empty population keeps a stable zero shape without invented averages', () => {
  const result = buildMsRfm([], { asOf: '2026-07-18', noAgentOrders: 4 });
  assert.equal(result.customers, 0);
  assert.equal(result.no_agent_orders, 4);
  assert.equal(result.total_orders, 0);
  assert.equal(result.total_sum_kopecks, 0);
  assert.equal(result.segments.length, 6);
  assert.ok(result.segments.every((segment) => segment.customers === 0 && segment.average_recency_days === null));
});

test('RFM does not invent loyalty for a one-order single-customer population', () => {
  const result = buildMsRfm([
    { agent_id: 'only', recency_days: 0, orders: 1, sum_kopecks: 1000 },
  ], { asOf: '2026-07-18' });
  assert.equal(result.segments.find((segment) => segment.key === 'potential').customers, 1);
  assert.equal(result.segments.find((segment) => segment.key === 'loyal').customers, 0);
});

test('RFM fails explicitly instead of converting an unsafe monetary value to zero', () => {
  assert.throws(
    () => buildMsRfm([{ agent_id: 'bad', recency_days: 0, orders: 1, sum_kopecks: null }]),
    { code: 'ms_rfm_metric_out_of_range' },
  );
});

// Популяция с представителями большинства сегментов + спроектированными ничьими для сортировки:
// w1/w2 — champions с равной суммой (тай-брейк orders), h1/h2/h3 — hibernating с равными
// суммами/orders (тай-брейк agent_id) и меньшей суммой у h3.
const RFM_CUSTOMERS_FIXTURE = [
  { agent_id: 'w1', recency_days: 0, orders: 6, sum_kopecks: 90000, last_day: '2026-07-18', city: 'Москва' },
  { agent_id: 'w2', recency_days: 1, orders: 5, sum_kopecks: 90000, last_day: '2026-07-17', city: null },
  { agent_id: 'n1', recency_days: 0, orders: 1, sum_kopecks: 15000, last_day: '2026-07-18', city: 'Тверь' },
  { agent_id: 'n2', recency_days: 2, orders: 1, sum_kopecks: 14000, last_day: '2026-07-16', city: null },
  { agent_id: 'mid', recency_days: 30, orders: 3, sum_kopecks: 30000, last_day: '2026-06-18', city: 'Казань' },
  { agent_id: 'mid2', recency_days: 45, orders: 2, sum_kopecks: 25000, last_day: '2026-06-03', city: null },
  { agent_id: 'h1', recency_days: 200, orders: 1, sum_kopecks: 2000, last_day: '2025-12-31', city: null },
  { agent_id: 'h2', recency_days: 220, orders: 1, sum_kopecks: 2000, last_day: '2025-12-11', city: 'Сочи' },
  { agent_id: 'h3', recency_days: 240, orders: 1, sum_kopecks: 1000, last_day: '2025-11-21', city: null },
  { agent_id: 'h4', recency_days: 260, orders: 2, sum_kopecks: 2000, last_day: '2025-11-01', city: null },
];

test('RFM customers listing: parity-инвариант с агрегатом на тех же rows', () => {
  const rows = RFM_CUSTOMERS_FIXTURE;
  const aggregate = buildMsRfm(rows, { asOf: '2026-07-18' });
  // Эталонное присвоение сегментов — напрямую теми же примитивами (scoreByMidRank + segmentOf).
  const rScores = scoreByMidRank(rows, (row) => row.recency_days, { lowerIsBetter: true });
  const fScores = scoreByMidRank(rows, (row) => row.orders);
  const mScores = scoreByMidRank(rows, (row) => row.sum_kopecks);
  const expected = new Map(SEGMENT_ORDER.map((key) => [key, []]));
  rows.forEach((row, index) => {
    const key = segmentOf({ r: rScores[index], f: fScores[index], m: mScores[index], orders: row.orders });
    expected.get(key).push(row.agent_id);
  });

  let totalAcross = 0;
  for (const segment of SEGMENT_ORDER) {
    const listing = buildMsRfmCustomers(rows, { segment, asOf: '2026-07-18' });
    assert.equal(listing.as_of, '2026-07-18');
    assert.equal(listing.customers.length, listing.total_customers,
      'customers — полный отфильтрованный список (пагинация — забота роута)');
    assert.equal(
      listing.total_customers,
      aggregate.segments.find((s) => s.key === segment).customers,
      `счётчик листинга ${segment} обязан равняться segments[].customers агрегата`,
    );
    assert.deepEqual(
      listing.customers.map((c) => c.agent_id).sort(),
      expected.get(segment).sort(),
      `состав сегмента ${segment} обязан совпадать с segmentOf-присвоением`,
    );
    // Каждая строка несёт scores того же присвоения.
    for (const c of listing.customers) {
      const index = rows.findIndex((row) => row.agent_id === c.agent_id);
      assert.deepEqual({ r: c.r, f: c.f, m: c.m }, { r: rScores[index], f: fScores[index], m: mScores[index] });
    }
    totalAcross += listing.total_customers;
  }
  assert.equal(totalAcross, aggregate.customers, 'сумма total_customers по сегментам == customers агрегата');
});

test('RFM customers listing: контрактная сортировка и прозрачный пропуск city/last_day', () => {
  const champions = buildMsRfmCustomers(RFM_CUSTOMERS_FIXTURE, { segment: 'champions', asOf: '2026-07-18' });
  // Равная сумма 90000 → тай-брейк orders DESC: w1 (6) впереди w2 (5).
  assert.deepEqual(champions.customers.map((c) => c.agent_id), ['w1', 'w2']);
  const hibernating = buildMsRfmCustomers(RFM_CUSTOMERS_FIXTURE, { segment: 'hibernating', asOf: '2026-07-18' });
  // h1/h2 — полная ничья по сумме и orders → agent_id ASC; h3 с меньшей суммой — последним.
  assert.deepEqual(hibernating.customers.map((c) => c.agent_id), ['h1', 'h2', 'h3']);
  // city/last_day проходят насквозь без числового контракта (null — тоже честное значение).
  assert.equal(champions.customers[0].last_day, '2026-07-18');
  assert.equal(champions.customers[0].city, 'Москва');
  assert.equal(champions.customers[1].city, null);
  assert.deepEqual(hibernating.customers[1], {
    agent_id: 'h2', recency_days: 220, orders: 1, sum_kopecks: 2000,
    r: hibernating.customers[1].r, f: hibernating.customers[1].f, m: hibernating.customers[1].m,
    last_day: '2025-12-11', city: 'Сочи',
  });
});

test('RFM customers listing: пустая популяция и неизвестный сегмент', () => {
  const empty = buildMsRfmCustomers([], { segment: 'loyal', asOf: '2026-07-18' });
  assert.deepEqual(empty, { as_of: '2026-07-18', total_customers: 0, customers: [] });
  assert.throws(
    () => buildMsRfmCustomers([], { segment: 'vip' }),
    { code: 'ms_rfm_unknown_segment' },
  );
});
