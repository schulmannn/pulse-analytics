'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreByMidRank, segmentOf, buildMsRfm, SEGMENT_ORDER } = require('../server/domain/msRfm');

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
