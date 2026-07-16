'use strict';

// Unit tests for the centralized metric-counter helper (BIGINT release, migration 023). No DB.
// Proves the honest-missing semantics that replace the old INT4 saturating clamp: safe >INT4 values
// pass, zero/null are preserved, and anything outside the exact safe range becomes null — never a
// saturated invented number.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_SAFE_METRIC, toMetricInt, toMetricNumber } = require('../server/lib/metricNumber');

const INT4_MAX = 2_147_483_647;
const BIG = 3_000_000_000; // > INT4_MAX, still an exact safe JS integer

test('MAX_SAFE_METRIC stays within JS exact-integer range', () => {
  assert.equal(MAX_SAFE_METRIC, 9_000_000_000_000_000);
  assert.ok(MAX_SAFE_METRIC <= Number.MAX_SAFE_INTEGER);
});

test('toMetricInt: null/empty/garbage → null (honest missing)', () => {
  assert.equal(toMetricInt(null), null);
  assert.equal(toMetricInt(undefined), null);
  assert.equal(toMetricInt(''), null);
  assert.equal(toMetricInt(NaN), null);
  assert.equal(toMetricInt(Infinity), null);
  assert.equal(toMetricInt('abc'), null);
});

test('toMetricInt: zero and negatives are preserved, not treated as missing', () => {
  assert.equal(toMetricInt(0), 0);
  assert.equal(toMetricInt('0'), 0);
  assert.equal(toMetricInt(-5), -5);
});

test('toMetricInt: rounds, and accepts safe >INT4 values (no clamp)', () => {
  assert.equal(toMetricInt(3.7), 4);
  assert.equal(toMetricInt(BIG), BIG);
  assert.equal(toMetricInt(String(BIG)), BIG);
  assert.ok(BIG > INT4_MAX, 'BIG is genuinely beyond the old INT4 ceiling');
});

test('toMetricInt: boundary — accepts exactly MAX_SAFE_METRIC, rejects beyond as null', () => {
  assert.equal(toMetricInt(MAX_SAFE_METRIC), MAX_SAFE_METRIC);
  assert.equal(toMetricInt(MAX_SAFE_METRIC + 1_000_000), null);
  assert.equal(toMetricInt(-(MAX_SAFE_METRIC + 1_000_000)), null);
});

test('toMetricNumber: pg BIGINT strings → JS numbers, null preserved', () => {
  assert.equal(toMetricNumber(null), null);
  assert.equal(toMetricNumber(undefined), null);
  assert.equal(toMetricNumber('0'), 0);
  assert.equal(toMetricNumber(String(BIG)), BIG);
  assert.equal(typeof toMetricNumber(String(BIG)), 'number');
  assert.equal(toMetricNumber(String(MAX_SAFE_METRIC)), MAX_SAFE_METRIC);
});

test('toMetricNumber: a stored value beyond the safe bound reads as null, never lossy', () => {
  // Both are valid PostgreSQL BIGINT values beyond Number.MAX_SAFE_INTEGER. They must not surface
  // as silently rounded JS numbers.
  assert.equal(toMetricNumber('9007199254740992'), null);
  assert.equal(toMetricNumber('9223372036854775807'), null);
});
