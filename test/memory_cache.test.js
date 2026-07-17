'use strict';

// Юнит-тесты infrastructure/memoryCache: настоящий bounded LRU (промоция на чтении/записи,
// эвикция least-recently-used на переполнении) и абсолютный TTL (get НЕ продлевает срок).
// Чистый модуль; для TTL/свипа фейкаем Date.now, свип использует реальный setInterval, но
// читает фейковое время внутри колбэка.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryCache } = require('../server/infrastructure/memoryCache');

const HOUR = 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeClock(t, start = 1000) {
  const realNow = Date.now;
  let clock = start;
  Date.now = () => clock;
  t.after(() => { Date.now = realNow; });
  return {
    advance(ms) { clock += ms; },
  };
}

test('true LRU eviction order: least-recently-used entry is dropped at the cap', () => {
  const cache = createMemoryCache({ maxEntries: 3, ttlMs: HOUR });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  // Adding a 4th key at cap evicts the LRU head 'a'.
  cache.set('d', 4);
  assert.equal(cache.get('a'), null, 'a (LRU) evicted');
  assert.equal(cache.size, 3);
  // Read 'b' → promotes it; the LRU is now 'c'.
  assert.equal(cache.get('b'), 2);
  cache.set('e', 5);
  assert.equal(cache.get('c'), null, 'c became LRU after b was promoted → evicted');
  assert.equal(cache.get('b'), 2, 'promoted b survived');
  assert.equal(cache.get('d'), 4);
  assert.equal(cache.get('e'), 5);
});

test('hit promotion: a read moves the entry off the eviction front', () => {
  const cache = createMemoryCache({ maxEntries: 2, ttlMs: HOUR });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');           // promote a → b is now LRU
  cache.set('c', 3);        // evicts b, not the freshly-read a
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('update promotion: re-writing an existing key promotes it (and refreshes value)', () => {
  const cache = createMemoryCache({ maxEntries: 2, ttlMs: HOUR });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 'new');    // update existing → promote a → b is LRU
  cache.set('c', 3);        // evicts b
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a'), 'new');
  assert.equal(cache.get('c'), 3);
});

test('hard cap: size never exceeds maxEntries', () => {
  const cache = createMemoryCache({ maxEntries: 5, ttlMs: HOUR });
  for (let i = 0; i < 50; i += 1) cache.set(`k${i}`, i);
  assert.equal(cache.size, 5);
  // Only the last 5 inserted keys remain.
  assert.equal(cache.get('k44'), null);
  assert.equal(cache.get('k49'), 49);
  assert.equal(cache.get('k45'), 45);
});

test('get does NOT refresh the absolute TTL: a promoted entry still expires on its original deadline', (t) => {
  const clock = fakeClock(t);
  const cache = createMemoryCache({ maxEntries: 10, ttlMs: 1000 });
  cache.set('a', 1);                       // expires at now+1000
  clock.advance(500);
  assert.equal(cache.get('a'), 1, 'still valid at t+500 (promotes, but must not extend expiry)');
  clock.advance(501);                      // t+1001 > original deadline
  assert.equal(cache.get('a'), null, 'expired on the ORIGINAL deadline — get() never refreshed it');
});

test('expired read deletes the entry and returns null', (t) => {
  const clock = fakeClock(t);
  const cache = createMemoryCache({ maxEntries: 10, ttlMs: 1000 });
  cache.set('a', 1);
  assert.equal(cache.size, 1);
  clock.advance(1001);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.size, 0, 'expired entry reaped on read');
});

test('sweep reaps expired entries in the background; stop() clears the timer', async (t) => {
  const clock = fakeClock(t);
  const cache = createMemoryCache({ maxEntries: 10, ttlMs: 50, sweepMs: 10 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.size, 2);
  clock.advance(100);                      // both entries now past their deadline
  cache.start();
  t.after(() => cache.stop());
  // Real timer fires (sweepMs=10), reads the faked clock (100 > expires) and reaps.
  for (let i = 0; i < 20 && cache.size > 0; i += 1) await sleep(10);
  assert.equal(cache.size, 0, 'sweep emptied expired entries');
  cache.stop();
});

test('clear empties the cache', () => {
  const cache = createMemoryCache({ maxEntries: 10, ttlMs: HOUR });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('a'), null);
});

test('keys()/delete(): targeted invalidation primitive for igCachePurge', () => {
  const cache = createMemoryCache({ maxEntries: 10, ttlMs: HOUR });
  cache.set('ig:media:1', 'a');
  cache.set('ig:media:2', 'b');
  cache.set('other:1', 'c');

  const keys = cache.keys();
  assert.ok(Array.isArray(keys), 'keys() returns a snapshot array, not a live iterator');
  assert.deepEqual(keys.sort(), ['ig:media:1', 'ig:media:2', 'other:1']);

  // Deleting while iterating the snapshot is safe (the array is decoupled from the Map).
  for (const k of cache.keys()) if (k.startsWith('ig:')) cache.delete(k);
  assert.equal(cache.get('ig:media:1'), null);
  assert.equal(cache.get('ig:media:2'), null);
  assert.equal(cache.get('other:1'), 'c', 'unrelated key survives targeted purge');

  assert.equal(cache.delete('nope'), false, 'delete() returns false for a missing key');
});
