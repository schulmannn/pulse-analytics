'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMentionsRange, rangeDayCount } = require('../server/lib/mentionsRange');

test('parseMentionsRange: both valid -> inclusive range', () => {
  assert.deepEqual(parseMentionsRange({ from: '2026-06-01', to: '2026-06-30' }), {
    from: '2026-06-01',
    to: '2026-06-30',
  });
});

test('parseMentionsRange: equal from/to -> single-day window is valid', () => {
  assert.deepEqual(parseMentionsRange({ from: '2026-06-15', to: '2026-06-15' }), {
    from: '2026-06-15',
    to: '2026-06-15',
  });
});

test('parseMentionsRange: missing one bound -> null', () => {
  assert.equal(parseMentionsRange({ from: '2026-06-01' }), null);
  assert.equal(parseMentionsRange({ to: '2026-06-30' }), null);
  assert.equal(parseMentionsRange({}), null);
  assert.equal(parseMentionsRange(undefined), null);
});

test('parseMentionsRange: malformed or impossible dates -> null', () => {
  assert.equal(parseMentionsRange({ from: '2026-6-1', to: '2026-06-30' }), null);
  assert.equal(parseMentionsRange({ from: '2026-06-01', to: 'abc' }), null);
  assert.equal(parseMentionsRange({ from: '', to: '' }), null);
  assert.equal(parseMentionsRange({ from: '20260601', to: '20260630' }), null);
  assert.equal(parseMentionsRange({ from: '2026-02-30', to: '2026-03-01' }), null);
  assert.equal(parseMentionsRange({ from: '2026-13-01', to: '2026-13-02' }), null);
  assert.equal(parseMentionsRange({ from: '0000-01-01', to: '0000-01-02' }), null);
});

test('parseMentionsRange: from > to -> null', () => {
  assert.equal(parseMentionsRange({ from: '2026-07-01', to: '2026-06-01' }), null);
});

test('parseMentionsRange: non-string bounds -> null (no coercion)', () => {
  assert.equal(parseMentionsRange({ from: 20260601, to: 20260630 }), null);
});

test('rangeDayCount: inclusive day count', () => {
  assert.equal(rangeDayCount({ from: '2026-06-01', to: '2026-06-30' }), 30);
  assert.equal(rangeDayCount({ from: '2026-06-15', to: '2026-06-15' }), 1);
  assert.equal(rangeDayCount({ from: '2026-06-01', to: '2026-06-07' }), 7);
});
