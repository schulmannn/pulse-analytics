'use strict';

// Focused unit tests for the managed-central preference in the daily ingest (fake db + fake
// collect/mtproto — no PG, no network). Exercises: managed success uses the returned counts and
// SKIPS the global live pass; a decrypt/upstream/auth failure falls back to the unchanged global
// mtprotoFetch/persistCentralDaily path; a missing owner session keeps the global path untouched; and
// no session material ever reaches the logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyIngestJob } = require('../server/jobs/dailyIngestJob');

const CENTRAL = { id: 7, source: 'central', owner_uid: 2, tg_channel_id: 999 };

function makeJob({
  session = { uid: 2, session_enc: 'ENC', session_version: '4', connection_state: 'healthy' },
  central = CENTRAL,
  managed,               // (session, channel, day) => result | throws
} = {}) {
  const calls = { fetch: [], fetchLanes: [], persistCentral: [], managed: [], logs: [] };
  const db = {
    enabled: true,
    getOwnerChannelId: async () => (central ? central.id : null),
    getChannelById: async (id) => (central && central.id === id ? central : null),
    getTgSession: async (uid) => (session && session.uid === uid ? session : null),
    graphsToDailyRows: (g) => (g ? [{ day: '2026-07-15' }] : []),
    persistCentralDaily: async (channelId, payload) => {
      calls.persistCentral.push({ channelId, payload });
      return { channel_daily: (payload.dailyRows || []).length, posts: (payload.postRows || []).length, velocity: !!payload.velocity };
    },
    runJobOnce: async (_kind, _key, fn) => ({ skipped: false, result: await fn() }),
  };
  const mtprotoFetch = async (path, _params, _timeoutMs, lane) => {
    calls.fetch.push(path);
    calls.fetchLanes.push(lane);
    if (path === '/graphs') return { available: true };
    if (path === '/posts') return { posts: [{ id: 1 }] };
    if (path === '/velocity') return { available: true };
    return null;
  };
  const collectManagedChannelNow = managed
    ? async (sess, channel, day) => { calls.managed.push({ sess, channel, day }); return managed(sess, channel, day); }
    : undefined;
  const job = createDailyIngestJob({
    db,
    log: (level, event, meta) => { calls.logs.push({ level, event, meta }); },
    mtprotoFetch,
    MTPROTO_TIMEOUT_STATS_MS: 1000,
    MTPROTO_TIMEOUT_HEAVY_MS: 2000,
    tgPostToRow: (p) => p,
    collectManagedChannelNow,
    processReportSchedules: async () => {},
    processPersistence: async () => {},
    processTgQrCollection: async () => {},
  });
  return { job, db, calls };
}

test('managed-central success uses returned counts and skips the global live pass', async () => {
  const { job, calls } = makeJob({
    managed: () => ({ bundle: { graphs: { available: true } }, channel_daily: 4, posts: 2 }),
  });

  const out = await job.run({ requestId: 'r1', base: 'https://x' });

  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.channel_daily, 4);
  assert.equal(out.body.posts, 2);
  assert.equal(out.body.velocity, false);           // this managed result carried no velocity → false
  assert.equal(calls.managed.length, 1);
  assert.deepEqual(calls.fetch, []);                // NO global mtprotoFetch
  assert.deepEqual(calls.persistCentral, []);       // NO persistCentralDaily — managed already persisted
});

test('managed-central success with a persisted velocity reports velocity:true and still skips the global pass', async () => {
  const { job, calls } = makeJob({
    managed: () => ({ bundle: { graphs: { available: true } }, channel_daily: 4, posts: 2, velocity: true }),
  });

  const out = await job.run({ requestId: 'rv', base: 'https://x' });

  assert.equal(out.status, 200);
  assert.equal(out.body.velocity, true, 'velocity flows through from the managed collect');
  assert.deepEqual(calls.fetch, [], 'managed success runs NO global /graphs /posts /velocity');
  assert.deepEqual(calls.persistCentral, []);
});

test('managed-central success without velocity reports velocity:false (never fabricated)', async () => {
  const { job } = makeJob({
    managed: () => ({ bundle: { graphs: { available: true } }, channel_daily: 4, posts: 2, velocity: false }),
  });

  const out = await job.run({ requestId: 'rv0', base: 'https://x' });
  assert.equal(out.body.velocity, false);
});

test('managed-central failure falls back to the unchanged global path (and logs only safe context)', async () => {
  const { job, calls } = makeJob({
    managed: () => { const e = new Error('boom'); e.code = 'session_unauthorized'; throw e; },
  });

  const out = await job.run({ requestId: 'r2', base: 'https://x' });

  assert.equal(out.status, 200);
  assert.equal(calls.managed.length, 1);
  assert.ok(calls.fetch.includes('/graphs') && calls.fetch.includes('/posts'), 'global live pass ran');
  assert.ok(calls.fetchLanes.every((lane) => lane === 'background'), 'global fallback stays on background lane');
  assert.equal(calls.persistCentral.length, 1, 'global persistCentralDaily ran');
  const fb = calls.logs.find((l) => l.event === 'daily_ingest_managed_fallback');
  assert.ok(fb, 'fallback was logged');
  assert.deepEqual(fb.meta, { request_id: 'r2', uid: 2, channel_id: 7, code: 'session_unauthorized' });
  // No session material anywhere in the logs.
  assert.equal(JSON.stringify(calls.logs).includes('ENC'), false);
});

test('managed-central fallback never logs an arbitrary upstream error code', async () => {
  const { job, calls } = makeJob({
    managed: () => { const e = new Error('secret upstream detail'); e.code = 'raw_account_identifier'; throw e; },
  });

  const out = await job.run({ requestId: 'r-safe', base: 'https://x' });

  assert.equal(out.status, 200);
  const fb = calls.logs.find((l) => l.event === 'daily_ingest_managed_fallback');
  assert.equal(fb.meta.code, 'collect_failed');
  assert.equal(JSON.stringify(fb).includes('raw_account_identifier'), false);
  assert.equal(JSON.stringify(fb).includes('secret upstream detail'), false);
});

test('no owner session → managed skipped, unchanged global path', async () => {
  const { job, calls } = makeJob({
    session: null,
    managed: () => { throw new Error('should not be called'); },
  });

  const out = await job.run({ requestId: 'r3', base: 'https://x' });

  assert.equal(out.status, 200);
  assert.deepEqual(calls.managed, []);              // helper never invoked
  assert.ok(calls.fetch.includes('/graphs'), 'global path ran');
  assert.equal(calls.persistCentral.length, 1);
});

test('reauth_required session → managed skipped (do not attempt a known-dead session)', async () => {
  const { job, calls } = makeJob({
    session: { uid: 2, session_enc: 'ENC', session_version: '4', connection_state: 'reauth_required' },
    managed: () => { throw new Error('should not be called'); },
  });

  await job.run({ requestId: 'r4', base: 'https://x' });
  assert.deepEqual(calls.managed, []);
  assert.ok(calls.fetch.includes('/graphs'));
});

test('managed success but channel_daily=0 still trips the degraded guard (same-day retry)', async () => {
  const { job } = makeJob({
    managed: () => ({ bundle: { graphs: null }, channel_daily: 0, posts: 0 }),
  });

  const out = await job.run({ requestId: 'r5', base: 'https://x' });
  assert.equal(out.status, 503);
  assert.equal(out.body.degraded, true);
  assert.equal(out.body.retryable, true);
});
