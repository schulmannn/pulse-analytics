'use strict';

// Focused unit tests for the TG QR-collection health bookkeeping (fake db + fake mtproto — no PG,
// no network). Exercises the state machine: auth short-circuit, skipped-idempotent-runs-are-not-
// attempts, success-wins-over-non-auth, all-non-auth-become-degraded, and the collectQrChannelsNow
// equivalent. The collection plumbing (persistTgBundle) is stubbed to a no-op so the tests isolate
// the health transitions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTgQrCollectionJob } = require('../server/jobs/tgQrCollectionJob');

const OK_BUNDLE = { channel: {}, views_summary: null, posts: [], stats: null, graphs: null };
const authErr = () => Object.assign(new Error('session unauthorized'), { code: 'session_unauthorized' });
const authErr503 = () => Object.assign(new Error('mtproto session unauthorized'), { code: 'mtproto_session_unauthorized' });
const timeoutErr = () => Object.assign(new Error('too slow'), { code: 'mtproto_timeout' });
const floodErr = () => Object.assign(new Error('flood'), { floodWait: true });
const oddErr = () => new Error('boom without code');

// Build a job whose collectQrChannel outcome is driven per-channel-ref via `responses`
// (ref -> Error to throw, or undefined -> succeed). Records every health call for assertions.
function makeJob({ responses = {}, runJobOnce, health = {}, tgCrypto, tgQrChannelsPerPass } = {}) {
  const calls = { post: [], postLanes: [], health: [], persisted: [], logs: [], sessions: [] };
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    persistTgBundleTx: async (channelId) => { calls.persisted.push(channelId); return { channel_daily: 3, posts: 5 }; },
    runJobOnce: runJobOnce || (async (_kind, _key, fn) => ({ skipped: false, result: await fn() })),
    recordTgSessionAttempt: async (uid, _version) => { calls.health.push(['attempt', uid]); return health.attempt !== false; },
    recordTgSessionSuccess: async (uid, _version) => { calls.health.push(['success', uid]); return health.success !== false; },
    recordTgSessionFailure: async (uid, _version, arg) => { calls.health.push(['failure', uid, arg]); return health.failure !== false; },
    listTgSessions: async () => [],
    listChannels: async () => [],
  };
  const mtprotoPost = async (_path, { body, lane }) => {
    calls.post.push(body.channel);
    calls.postLanes.push(lane);
    calls.sessions.push(body.session);   // record the plaintext session the collect actually sent
    const err = responses[body.channel];
    if (err) throw err;
    return OK_BUNDLE;
  };
  const job = createTgQrCollectionJob({
    db,
    log: (level, event, meta) => { calls.logs.push({ level, event, meta }); },
    tgCrypto: tgCrypto || { configured: () => true, decrypt: (s) => s },
    mtprotoPost,
    MTPROTO_TOKEN: 'tok',
    MTPROTO_TIMEOUT_HEAVY_MS: 1000,
    tgPostToRow: (p) => p,
    ...(tgQrChannelsPerPass != null ? { tgQrChannelsPerPass } : {}),
  });
  return { job, db, calls };
}

const ch = (id, username) => ({ id, username, tg_channel_id: 1000 + id, source: 'qr' });

// ── processTgQrCollection (nightly) ────────────────────────────────────────────

test('auth failure → reauth_required, остальные каналы юзера пропущены, другие юзеры продолжают', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: authErr() } });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's1', session_version: '1' }, { uid: 2, session_enc: 's2', session_version: '1' }];
  db.listChannels = async ({ uid }) => (uid === 1
    ? [ch(1, 'a1'), ch(2, 'a2')]
    : [ch(3, 'b1')]);

  await job.processTgQrCollection();

  // user 1: only a1 attempted (a2 short-circuited); user 2: b1 collected.
  assert.deepEqual(calls.post, ['a1', 'b1']);
  assert.deepEqual(calls.postLanes, ['background', 'background']);
  const u1 = calls.health.filter((c) => c[1] === 1);
  assert.deepEqual(u1[0], ['attempt', 1]);
  assert.equal(u1[1][0], 'failure');
  assert.deepEqual(u1[1][2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
  const u2 = calls.health.filter((c) => c[1] === 2);
  assert.deepEqual(u2[1], ['success', 2]);
});

test('503 mtproto_session_unauthorized тоже трактуется как auth (reauth_required)', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: authErr503() } });
  db.listTgSessions = async () => [{ uid: 7, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1']); // a2 not attempted
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'mtproto_session_unauthorized' });
});

test('auth failure wins even after an earlier channel succeeded', async () => {
  const { job, db, calls } = makeJob({ responses: { a2: authErr() } });
  db.listTgSessions = async () => [{ uid: 12, session_enc: 's', session_version: '3' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2'), ch(3, 'a3')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1', 'a2']);
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
  assert.ok(!calls.health.some((c) => c[0] === 'success'));
});

test('все runJobOnce skipped → не считается попыткой, health не трогается', async () => {
  const { job, db, calls } = makeJob({ runJobOnce: async () => ({ skipped: true }) });
  db.listTgSessions = async () => [{ uid: 5, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, []);   // fn never invoked
  assert.deepEqual(calls.health, []); // no attempt/success/failure recorded
});

test('успех выигрывает у не-auth сбоя → healthy', async () => {
  // a1 succeeds, a2 times out (non-auth). Final state must be healthy.
  const { job, db, calls } = makeJob({ responses: { a2: timeoutErr() } });
  db.listTgSessions = async () => [{ uid: 9, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1', 'a2']); // non-auth does NOT short-circuit
  assert.deepEqual(calls.health[0], ['attempt', 9]);
  assert.deepEqual(calls.health[1], ['success', 9]);
  assert.ok(!calls.health.some((c) => c[0] === 'failure'));
});

test('успех выигрывает даже если сбой был ПЕРВЫМ', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: timeoutErr() } });
  db.listTgSessions = async () => [{ uid: 4, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1', 'a2']);
  assert.deepEqual(calls.health[1], ['success', 4]);
});

test('только не-auth сбои → degraded с безопасным кодом', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: timeoutErr(), a2: floodErr() } });
  db.listTgSessions = async () => [{ uid: 3, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.health[0], ['attempt', 3]);
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.equal(fail[2].state, 'degraded');
  // last error was flood → 'flood_wait'; a code-less error would fall back to 'collect_failed'.
  assert.equal(fail[2].errorCode, 'flood_wait');
});

test('не-auth сбой без .code → collect_failed', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: oddErr() } });
  db.listTgSessions = async () => [{ uid: 8, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1')];

  await job.processTgQrCollection();

  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'degraded', errorCode: 'collect_failed' });
});

test('сбой health-bookkeeping логируется и НЕ роняет сбор', async () => {
  const { job, db, calls } = makeJob({ health: { attempt: undefined } });
  db.recordTgSessionAttempt = async () => { throw new Error('db down'); };
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1')];

  await assert.doesNotReject(job.processTgQrCollection());
  assert.deepEqual(calls.persisted, [1]); // collection itself still happened
});

// ── processTgQrCollection: возвращаемая статистика прохода + инъекция cap ──────────

test('processTgQrCollection: возвращает { collected, skipped, failed, capped }', async () => {
  // a1 succeeds, a2 skipped (idempotent), a3 fails (non-auth).
  const { job, db } = makeJob({
    responses: { a3: timeoutErr() },
    runJobOnce: async (_kind, key, fn) => (key.startsWith('2:')
      ? { skipped: true }                     // channel id 2 already done today
      : { skipped: false, result: await fn() }),
  });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2'), ch(3, 'a3')];

  const stats = await job.processTgQrCollection();

  assert.deepEqual(stats, { collected: 1, skipped: 1, failed: 1, capped: false });
});

test('processTgQrCollection: инъектированный per-pass cap ограничивает НОВОСТАРТОВАННЫЕ каналы, skipped не тратят cap', async () => {
  // cap=1: первый реально стартовавший канал занимает cap, дальше capped. Но канал, skipped
  // идемпотентно, cap НЕ тратит — следующий проход добирает остаток.
  const { job, db, calls } = makeJob({
    tgQrChannelsPerPass: 1,
    // channel id 1 already done today → skipped (не тратит cap); 2 и 3 стартуют.
    runJobOnce: async (_kind, key, fn) => (key.startsWith('1:')
      ? { skipped: true }
      : { skipped: false, result: await fn() }),
  });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2'), ch(3, 'a3')];

  const stats = await job.processTgQrCollection();

  // a1 skipped (cap не тронут), a2 collected (cap исчерпан), a3 не тронут → capped.
  assert.deepEqual(calls.post, ['a2']); // только реально стартовавший a2 дошёл до upstream
  assert.equal(stats.skipped, 1);
  assert.equal(stats.collected, 1);
  assert.equal(stats.capped, true);
});

test('processTgQrCollection: cap-параметр вызова переопределяет инъектированный дефолт', async () => {
  const { job, db, calls } = makeJob({ tgQrChannelsPerPass: 5 });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2'), ch(3, 'a3')];

  const stats = await job.processTgQrCollection({ cap: 2 });

  assert.deepEqual(calls.post, ['a1', 'a2']); // третий не тронут
  assert.equal(stats.collected, 2);
  assert.equal(stats.capped, true);
});

test('processTgQrCollection: БД выключена → пустая статистика, без обхода', async () => {
  const { job, db, calls } = makeJob();
  db.enabled = false;
  const stats = await job.processTgQrCollection();
  assert.deepEqual(stats, { collected: 0, skipped: 0, failed: 0, capped: false });
  assert.deepEqual(calls.post, []);
});

// ── collectQrChannelsNow (immediate post-add) ─────────────────────────────────

test('collectQrChannelsNow: auth-сбой короткозамыкает и пишет reauth_required', async () => {
  const { job, calls } = makeJob({ responses: { a1: authErr() } });
  await job.collectQrChannelsNow({ uid: 2, session_enc: 's', session_version: '1' }, [ch(1, 'a1'), ch(2, 'a2')]);

  assert.deepEqual(calls.post, ['a1']); // a2 short-circuited
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
});

test('collectQrChannelsNow: успех выигрывает у не-auth сбоя → healthy', async () => {
  const { job, calls } = makeJob({ responses: { a2: timeoutErr() } });
  await job.collectQrChannelsNow({ uid: 6, session_enc: 's', session_version: '1' }, [ch(1, 'a1'), ch(2, 'a2')]);

  assert.deepEqual(calls.post, ['a1', 'a2']);
  assert.deepEqual(calls.health[1], ['success', 6]);
});

test('collectQrChannelsNow: пустой список → без попытки/health', async () => {
  const { job, calls } = makeJob();
  await job.collectQrChannelsNow({ uid: 6, session_enc: 's', session_version: '1' }, []);
  assert.deepEqual(calls.health, []);
});

// ── collectManagedChannelNow (managed central, ONE channel, rethrows for fallback) ─────────────

const central = (over = {}) => ({ id: 50, username: 'central', tg_channel_id: 999, source: 'central', owner_uid: 2, ...over });

test('collectManagedChannelNow: success → healthy, returns bundle + persisted counts', async () => {
  const { job, calls } = makeJob();
  const out = await job.collectManagedChannelNow({ uid: 2, session_enc: 'plain-secret', session_version: '4' }, central(), '2026-07-15');

  assert.deepEqual(calls.post, ['central']);          // collected the central ref via /qr/collect
  assert.deepEqual(calls.persisted, [50]);            // persisted the bundle for the central channel id
  assert.equal(out.channel_daily, 3);                 // returned counts flow from persistTgBundleTx
  assert.equal(out.posts, 5);
  assert.equal(out.bundle, OK_BUNDLE);
  assert.deepEqual(calls.health[0], ['attempt', 2]);
  assert.deepEqual(calls.health[1], ['success', 2]);  // generation-guarded via session_version
});

test('collectManagedChannelNow: auth failure → reauth_required health then RETHROWS for fallback', async () => {
  const { job, calls } = makeJob({ responses: { central: authErr() } });
  await assert.rejects(
    job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central()),
    (e) => e.code === 'session_unauthorized',
  );
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
});

test('collectManagedChannelNow: non-auth failure → degraded health then RETHROWS for fallback', async () => {
  const { job, calls } = makeJob({ responses: { central: timeoutErr() } });
  await assert.rejects(
    job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central()),
    (e) => e.code === 'mtproto_timeout',
  );
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'degraded', errorCode: 'mtproto_timeout' });
});

test('collectManagedChannelNow: decrypt failure rethrows a safe code and does NOT record an attempt', async () => {
  const { job, calls } = makeJob({ tgCrypto: { configured: () => true, decrypt: () => { throw new Error('bad key'); } } });
  await assert.rejects(
    job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central()),
    (e) => e.code === 'session_decrypt_failed',
  );
  assert.deepEqual(calls.post, []);     // never reached upstream
  assert.deepEqual(calls.health, []);   // no attempt recorded for a crypto-config failure
});

test('collectManagedChannelNow: missing tg id → throws prereq, no upstream call', async () => {
  const { job, calls } = makeJob();
  await assert.rejects(
    job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central({ tg_channel_id: null })),
    (e) => e.code === 'managed_prereq',
  );
  assert.deepEqual(calls.post, []);
});

test('collectManagedChannelNow: plaintext session goes ONLY in the collect body, never into logs', async () => {
  const SECRET = 'STRING-SESSION-SECRET';
  const { job, calls } = makeJob({
    responses: { central: timeoutErr() },
    // decrypt returns the plaintext secret from the encrypted blob
    tgCrypto: { configured: () => true, decrypt: () => SECRET },
  });
  await assert.rejects(job.collectManagedChannelNow({ uid: 2, session_enc: 'enc', session_version: '4' }, central()));

  assert.deepEqual(calls.sessions, [SECRET]);   // the collect body carried the plaintext session
  const logBlob = JSON.stringify(calls.logs);
  assert.equal(logBlob.includes(SECRET), false, 'plaintext session must never appear in any log');
});
