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

// Fake tgCrypto whose decryptDetailed reports the ACTIVE key authenticated (no rewrite needed). The
// stored blob passes straight through as plaintext, matching how the real crypto round-trips.
const activeCrypto = () => ({
  configured: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (s) => s,
  decryptDetailed: (blob) => ({ plaintext: blob, usedPreviousKey: false }),
});

// Fake tgCrypto whose decryptDetailed reports a PREVIOUS (rotated-out) key authenticated → the shared
// helper must re-encrypt under the active key and rewrite the row once.
const previousKeyCrypto = () => ({
  configured: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (s) => s,
  decryptDetailed: (blob) => ({ plaintext: blob, usedPreviousKey: true }),
});

// Build a job whose collectQrChannel outcome is driven per-channel-ref via `responses`
// (ref -> Error to throw, or undefined -> succeed). Records every health call for assertions.
// `rotate` drives the fake db.rotateTgSessionCiphertext: false → no row matched (reconnect race),
// a thrown value → DB error, otherwise → matched. Every call is recorded in calls.rotate.
function makeJob({ responses = {}, runJobOnce, health = {}, tgCrypto, tgQrChannelsPerPass, rotate } = {}) {
  const calls = { post: [], postLanes: [], health: [], persisted: [], logs: [], sessions: [], rotate: [] };
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    persistTgBundleTx: async (channelId) => { calls.persisted.push(channelId); return { channel_daily: 3, posts: 5 }; },
    runJobOnce: runJobOnce || (async (_kind, _key, fn) => ({ skipped: false, result: await fn() })),
    recordTgSessionAttempt: async (uid, _version) => { calls.health.push(['attempt', uid]); return health.attempt !== false; },
    recordTgSessionSuccess: async (uid, _version) => { calls.health.push(['success', uid]); return health.success !== false; },
    recordTgSessionFailure: async (uid, _version, arg) => { calls.health.push(['failure', uid, arg]); return health.failure !== false; },
    rotateTgSessionCiphertext: async (uid, version, enc) => {
      calls.rotate.push({ uid, version, enc });
      if (rotate === undefined) return true;
      if (typeof rotate === 'function') return rotate(uid, version, enc);
      if (rotate instanceof Error) throw rotate;
      return rotate;
    },
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
    tgCrypto: tgCrypto || activeCrypto(),
    mtprotoPost,
    MTPROTO_TOKEN: 'tok',
    MTPROTO_TIMEOUT_HEAVY_MS: 1000,
    tgPostToRow: (p) => p,
    ...(tgQrChannelsPerPass != null ? { tgQrChannelsPerPass } : {}),
  });
  return { job, db, calls };
}

const ch = (id, username, ownerUid = 1) => ({
  id, username, tg_channel_id: 1000 + id, source: 'qr', owner_uid: ownerUid,
});

// ── processTgQrCollection (nightly) ────────────────────────────────────────────

test('auth failure → reauth_required, остальные каналы юзера пропущены, другие юзеры продолжают', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: authErr() } });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's1', session_version: '1' }, { uid: 2, session_enc: 's2', session_version: '1' }];
  db.listChannels = async ({ uid }) => (uid === 1
    ? [ch(1, 'a1'), ch(2, 'a2')]
    : [ch(3, 'b1', 2)]);

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
  db.listChannels = async () => [ch(1, 'a1', 7), ch(2, 'a2', 7)];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1']); // a2 not attempted
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'mtproto_session_unauthorized' });
});

test('auth failure wins even after an earlier channel succeeded', async () => {
  const { job, db, calls } = makeJob({ responses: { a2: authErr() } });
  db.listTgSessions = async () => [{ uid: 12, session_enc: 's', session_version: '3' }];
  db.listChannels = async () => [ch(1, 'a1', 12), ch(2, 'a2', 12), ch(3, 'a3', 12)];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1', 'a2']);
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
  assert.ok(!calls.health.some((c) => c[0] === 'success'));
});

test('все runJobOnce skipped → не считается попыткой, health не трогается', async () => {
  const { job, db, calls } = makeJob({ runJobOnce: async () => ({ skipped: true }) });
  db.listTgSessions = async () => [{ uid: 5, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1', 5), ch(2, 'a2', 5)];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, []);   // fn never invoked
  assert.deepEqual(calls.health, []); // no attempt/success/failure recorded
});

test('успех выигрывает у не-auth сбоя → healthy', async () => {
  // a1 succeeds, a2 times out (non-auth). Final state must be healthy.
  const { job, db, calls } = makeJob({ responses: { a2: timeoutErr() } });
  db.listTgSessions = async () => [{ uid: 9, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1', 9), ch(2, 'a2', 9)];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1', 'a2']); // non-auth does NOT short-circuit
  assert.deepEqual(calls.health[0], ['attempt', 9]);
  assert.deepEqual(calls.health[1], ['success', 9]);
  assert.ok(!calls.health.some((c) => c[0] === 'failure'));
});

test('успех выигрывает даже если сбой был ПЕРВЫМ', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: timeoutErr() } });
  db.listTgSessions = async () => [{ uid: 4, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1', 4), ch(2, 'a2', 4)];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1', 'a2']);
  assert.deepEqual(calls.health[1], ['success', 4]);
});

test('только не-auth сбои → degraded с безопасным кодом', async () => {
  const { job, db, calls } = makeJob({ responses: { a1: timeoutErr(), a2: floodErr() } });
  db.listTgSessions = async () => [{ uid: 3, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1', 3), ch(2, 'a2', 3)];

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
  db.listChannels = async () => [ch(1, 'a1', 8)];

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
  await job.collectQrChannelsNow(
    { uid: 2, session_enc: 's', session_version: '1' }, [ch(1, 'a1', 2), ch(2, 'a2', 2)]);

  assert.deepEqual(calls.post, ['a1']); // a2 short-circuited
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
});

test('collectQrChannelsNow: успех выигрывает у не-auth сбоя → healthy', async () => {
  const { job, calls } = makeJob({ responses: { a2: timeoutErr() } });
  await job.collectQrChannelsNow(
    { uid: 6, session_enc: 's', session_version: '1' }, [ch(1, 'a1', 6), ch(2, 'a2', 6)]);

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
  const { job, calls } = makeJob({ tgCrypto: { configured: () => true, encrypt: (p) => `enc:${p}`, decryptDetailed: () => { throw new Error('bad key'); } } });
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
    tgCrypto: { configured: () => true, encrypt: (p) => `enc:${p}`, decryptDetailed: () => ({ plaintext: SECRET, usedPreviousKey: false }) },
  });
  await assert.rejects(job.collectManagedChannelNow({ uid: 2, session_enc: 'enc', session_version: '4' }, central()));

  assert.deepEqual(calls.sessions, [SECRET]);   // the collect body carried the plaintext session
  const logBlob = JSON.stringify(calls.logs);
  assert.equal(logBlob.includes(SECRET), false, 'plaintext session must never appear in any log');
});

// ── Key rotation: previous-key sessions are lazily re-encrypted under the active key ────────────

test('processTgQrCollection: previous-key session is collected AND rewritten once under the same version', async () => {
  const { job, db, calls } = makeJob({ tgCrypto: previousKeyCrypto() });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 'old-blob', session_version: '2' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];

  await job.processTgQrCollection();

  // Collection still happens for every channel of the session.
  assert.deepEqual(calls.post, ['a1', 'a2']);
  // The row was rewritten exactly once (not per-channel), re-encrypted under the active key and
  // generation-guarded on the SAME session_version. No version bump is possible via this path.
  assert.deepEqual(calls.rotate, [{ uid: 1, version: '2', enc: 'enc:old-blob' }]);
});

test('processTgQrCollection: current-key session causes NO rewrite', async () => {
  const { job, db, calls } = makeJob();   // default activeCrypto → usedPreviousKey:false
  db.listTgSessions = async () => [{ uid: 1, session_enc: 'cur', session_version: '5' }];
  db.listChannels = async () => [ch(1, 'a1')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1']);
  assert.deepEqual(calls.rotate, [], 'active-key session must never trigger a ciphertext rewrite');
});

test('processTgQrCollection: a rewrite DB throw does NOT block collection', async () => {
  const SECRET_ERROR = 'db error carrying OLD-SESSION-CIPHERTEXT';
  const { job, db, calls } = makeJob({
    tgCrypto: previousKeyCrypto(),
    rotate: new Error(SECRET_ERROR),
  });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 'old', session_version: '2' }];
  db.listChannels = async () => [ch(1, 'a1')];

  await assert.doesNotReject(job.processTgQrCollection());
  assert.deepEqual(calls.post, ['a1']);       // collection completed
  assert.deepEqual(calls.persisted, [1]);     // bundle persisted despite the failed rewrite
  assert.equal(calls.rotate.length, 1);       // rewrite was attempted once
  assert.ok(calls.logs.some((l) => l.event === 'tg_session_key_reencrypt_failed' && l.level === 'warn'));
  assert.equal(JSON.stringify(calls.logs).includes(SECRET_ERROR), false, 'arbitrary rewrite error text is never logged');
});

test('processTgQrCollection: a rewrite rowCount=0 (reconnect race) is normal, not an error, and does not block', async () => {
  const { job, db, calls } = makeJob({
    tgCrypto: previousKeyCrypto(),
    rotate: false,   // no row matched the generation guard
  });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 'old', session_version: '2' }];
  db.listChannels = async () => [ch(1, 'a1')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.post, ['a1']);
  assert.equal(calls.rotate.length, 1);
  // rowCount=0 is a benign reconnect race: no error/warn is logged for it.
  assert.ok(!calls.logs.some((l) => l.event === 'tg_session_key_reencrypt_failed'));
  assert.ok(!calls.logs.some((l) => l.level === 'warn' || l.level === 'error'));
});

test('collectManagedChannelNow: previous-key session is collected AND rewritten once under the same version', async () => {
  const { job, calls } = makeJob({ tgCrypto: previousKeyCrypto() });
  const out = await job.collectManagedChannelNow(
    { uid: 2, session_enc: 'old-central', session_version: '4' }, central(), '2026-07-15');

  assert.equal(out.channel_daily, 3);
  assert.deepEqual(calls.rotate, [{ uid: 2, version: '4', enc: 'enc:old-central' }]);
  assert.deepEqual(calls.health[1], ['success', 2]);   // health flow unchanged
});

test('collectQrChannelsNow: previous-key session is rewritten once, rewrite failure never throws', async () => {
  const { job, calls } = makeJob({ tgCrypto: previousKeyCrypto(), rotate: new Error('db down') });
  await assert.doesNotReject(
    job.collectQrChannelsNow({ uid: 6, session_enc: 'old', session_version: '1' }, [ch(1, 'a1', 6)]));

  assert.deepEqual(calls.post, ['a1']);
  assert.deepEqual(calls.rotate, [{ uid: 6, version: '1', enc: 'enc:old' }]);
});

// ── Access-hash warm path: persist entity identity, reuse it, self-heal, 64-bit safe, no leak ────
// A private QR channel (no username) is addressed by its numeric tg_channel_id. On a fresh managed
// StringSession that id has no cached access_hash, so mtproto would scan iter_dialogs(limit=1000)
// each collect just to recover it. These tests cover the fix on the Node side: the persisted hash is
// sent so the scan is skipped, the resolved hash is written back generation-guarded, a refreshed hash
// self-heals, unsafe int64 values survive byte-exact, and the hash never blocks a collect or leaks.

// Build a job whose fake db implements getTgChannelIdentity/saveTgChannelAccessHash (feature-present).
// `stored` maps channel id -> stored identity row; mtproto returns `entityByRef` for the collected ref
// so a test can drive "resolved a fresh/refreshed hash". Records every access_hash sent + persisted.
function makeWarmJob({ stored = {}, entityByRef = {}, saveThrows = false } = {}) {
  const calls = { post: [], accessHashSent: [], hashWrites: [], persisted: [], logs: [] };
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    persistTgBundleTx: async (channelId) => { calls.persisted.push(channelId); return { channel_daily: 1, posts: 1 }; },
    runJobOnce: async (_kind, _key, fn) => ({ skipped: false, result: await fn() }),
    recordTgSessionAttempt: async () => true,
    recordTgSessionSuccess: async () => true,
    recordTgSessionFailure: async () => true,
    rotateTgSessionCiphertext: async () => true,
    listTgSessions: async () => [],
    listChannels: async () => [],
    getTgChannelIdentity: async (channelId, ownerUid) => {
      const row = channelId in stored ? stored[channelId] : null;
      return row && String(ownerUid) === '1' ? row : null;
    },
    saveTgChannelAccessHash: async (channelId, ownerUid, hash, gen) => {
      calls.hashWrites.push({ channelId, ownerUid, hash, gen });
      if (saveThrows) throw new Error('db down carrying SECRET-HASH-9998887776665554443');
      return true;
    },
  };
  const mtprotoPost = async (_path, { body }) => {
    calls.post.push(body.channel);
    calls.accessHashSent.push(body.access_hash);   // undefined when nothing was stored
    const entity = entityByRef[body.channel];
    return { channel: {}, views_summary: null, posts: [], stats: null, graphs: null,
             ...(entity !== undefined ? { entity } : {}) };
  };
  const job = createTgQrCollectionJob({
    db,
    log: (level, event, meta) => { calls.logs.push({ level, event, meta }); },
    tgCrypto: activeCrypto(),
    mtprotoPost,
    MTPROTO_TOKEN: 'tok',
    MTPROTO_TIMEOUT_HEAVY_MS: 1000,
    tgPostToRow: (p) => p,
  });
  return { job, db, calls };
}

// A private channel row: numeric id ref, NO username → addressed by tg_channel_id.
const priv = (id, tgId) => ({ id, username: null, tg_channel_id: tgId, source: 'qr', owner_uid: 1 });

test('warm path: a stored access_hash is sent to /qr/collect (so mtproto skips the dialog scan)', async () => {
  const HASH = '7345987012345678901';   // > 2**53 → must survive as an exact string
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-1001234567890', tg_access_hash: HASH, tg_access_hash_version: '3' } },
    entityByRef: { '-1001234567890': { id: '-1001234567890', access_hash: HASH } },
  });

  await job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '3' }, [priv(1, '-1001234567890')]);

  assert.deepEqual(calls.post, ['-1001234567890']);          // addressed by numeric id (private channel)
  assert.deepEqual(calls.accessHashSent, [HASH]);            // stored hash forwarded, byte-exact
  assert.deepEqual(calls.hashWrites, [], 'an unchanged warm hash does not pay for a no-op UPDATE');
});

test('cold legacy row (no stored hash) sends none, then persists the resolved hash generation-guarded', async () => {
  const RESOLVED = '-8674665223082153551';   // negative int64 from the dialog resync
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-1009876543210', tg_access_hash: null, tg_access_hash_version: null } },
    entityByRef: { '-1009876543210': { id: '-1009876543210', access_hash: RESOLVED } },
  });

  await job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '5' }, [priv(1, '-1009876543210')]);

  assert.deepEqual(calls.accessHashSent, [undefined]);                          // cold → nothing sent
  assert.deepEqual(calls.hashWrites, [{ channelId: 1, ownerUid: 1, hash: RESOLVED, gen: '5' }]); // resolved hash cached
});

test('stale hash self-heals: a refreshed hash from mtproto is persisted, replacing the old one', async () => {
  const STALE = '1111111111111111111';
  const FRESH = '2222222222222222222';
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-1001111111111', tg_access_hash: STALE, tg_access_hash_version: '2' } },
    // mtproto retried via the cold path and returns the REAL (refreshed) hash.
    entityByRef: { '-1001111111111': { id: '-1001111111111', access_hash: FRESH } },
  });

  await job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '2' }, [priv(1, '-1001111111111')]);

  assert.deepEqual(calls.accessHashSent, [STALE]);                              // stale hash was tried first
  assert.deepEqual(calls.hashWrites, [{ channelId: 1, ownerUid: 1, hash: FRESH, gen: '2' }]); // refreshed, same generation
});

test('64-bit access_hash is preserved byte-exact in the JSON body (never via Number)', async () => {
  const HASH = '9223372036854775807';   // 2**63 - 1: rounds if coerced through a JS double
  assert.notEqual(String(Number(HASH)), HASH, 'sanity: this value is unsafe as a JS Number');
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-1002222222222', tg_access_hash: HASH, tg_access_hash_version: '1' } },
    entityByRef: { '-1002222222222': { id: '-1002222222222', access_hash: HASH } },
  });

  await job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '1' }, [priv(1, '-1002222222222')]);

  assert.equal(calls.accessHashSent[0], HASH);       // exact string out
  assert.deepEqual(calls.hashWrites, [], 'unchanged warm value is already persisted');
});

test('public username channel never reads, sends or stores an access_hash', async () => {
  const { job, db, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '1001', tg_access_hash: '777', tg_access_hash_version: '1' } },
    entityByRef: { public_channel: { id: '1001', access_hash: '777' } },
  });
  db.getTgChannelIdentity = async () => { throw new Error('public channel must not read identity'); };

  await job.collectQrChannelsNow(
    { uid: 1, session_enc: 's', session_version: '1' }, [ch(1, 'public_channel')]);

  assert.deepEqual(calls.accessHashSent, [undefined]);
  assert.deepEqual(calls.hashWrites, []);
});

test('warm path generation guard: the collecting session_version is threaded as the write generation', async () => {
  // processTgQrCollection carries s.session_version; the repo requires THAT generation to still be
  // current for the owner and refuses any older-generation clobber.
  const { job, db, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-100333', tg_access_hash: null, tg_access_hash_version: null } },
    entityByRef: { '-100333': { id: '-100333', access_hash: '4242' } },
  });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '9' }];
  db.listChannels = async () => [priv(1, '-100333')];

  await job.processTgQrCollection();

  assert.deepEqual(calls.hashWrites, [{ channelId: 1, ownerUid: 1, hash: '4242', gen: '9' }]); // generation from the session
});

test('reconnect generation never reuses an access_hash from the previous session', async () => {
  const OLD = '1111111111111111111';
  const FRESH = '2222222222222222222';
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-100777', tg_access_hash: OLD, tg_access_hash_version: '4' } },
    entityByRef: { '-100777': { id: '-100777', access_hash: FRESH } },
  });

  await job.collectQrChannelsNow(
    { uid: 1, session_enc: 's', session_version: '5' }, [priv(1, '-100777')]);

  assert.deepEqual(calls.accessHashSent, [undefined], 'new credential takes one cold resolution');
  assert.deepEqual(calls.hashWrites, [{ channelId: 1, ownerUid: 1, hash: FRESH, gen: '5' }]);
});

test('foreign workspace channel is never collected or stamped with the caller session identity', async () => {
  const { job, calls } = makeWarmJob({
    stored: { 2: { tg_channel_id: '-100888', tg_access_hash: '888', tg_access_hash_version: '1' } },
    entityByRef: { '-100888': { id: '-100888', access_hash: '888' } },
  });
  const foreign = { ...priv(2, '-100888'), owner_uid: 2 };

  await job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '1' }, [foreign]);

  assert.deepEqual(calls.post, []);
  assert.deepEqual(calls.hashWrites, []);
});

test('entity identity mismatch fails closed before product persistence and logs only a fixed safe code', async () => {
  const HASH = '999999999999999999';
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-100999', tg_access_hash: null, tg_access_hash_version: null } },
    entityByRef: { '-100999': { id: '123456', access_hash: HASH } },
  });

  await job.collectQrChannelsNow(
    { uid: 1, session_enc: 's', session_version: '1' }, [priv(1, '-100999')]);

  assert.deepEqual(calls.hashWrites, []);
  assert.deepEqual(calls.persisted, [], 'wrong-channel bundle never reaches the product archive');
  const warn = calls.logs.find((l) => l.event === 'tg_access_hash_identity_mismatch');
  assert.deepEqual(warn.meta, { channelId: 1, error: 'identity_mismatch' });
  assert.equal(JSON.stringify(calls.logs).includes(HASH), false);
});

test('persist failure never blocks the collect and never logs the hash', async () => {
  const HASH = '5555555555555555555';
  const { job, calls } = makeWarmJob({
    stored: { 1: { tg_channel_id: '-100444', tg_access_hash: null, tg_access_hash_version: null } },
    entityByRef: { '-100444': { id: '-100444', access_hash: HASH } },
    saveThrows: true,
  });

  await assert.doesNotReject(
    job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '1' }, [priv(1, '-100444')]));

  assert.deepEqual(calls.persisted, [1]);   // the bundle was still persisted despite the hash-write throw
  const warn = calls.logs.find((l) => l.event === 'tg_access_hash_persist_failed');
  assert.equal(warn.level, 'warn');
  assert.equal(warn.meta.error, 'write_failed');
  const blob = JSON.stringify(calls.logs);
  assert.equal(blob.includes(HASH), false, 'the resolved access_hash must never appear in a log');
  assert.equal(blob.includes('SECRET-HASH'), false, 'arbitrary DB error text must never be logged');
});

test('feature-detect: a db without the identity methods sends no access_hash and never throws (old-schema safe)', async () => {
  // The shared makeJob fake db has NO getTgChannelIdentity/saveTgChannelAccessHash — the job must
  // gracefully fall back to the cold path (current behaviour) rather than crash on the missing method.
  const { job, calls } = makeJob();
  await assert.doesNotReject(
    job.collectQrChannelsNow({ uid: 1, session_enc: 's', session_version: '1' }, [priv(1, '-100555')]));
  assert.deepEqual(calls.post, ['-100555']);   // still collected, addressed by id, no access_hash attached
});
