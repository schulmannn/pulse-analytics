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
function makeJob({ responses = {}, runJobOnce, health = {}, tgCrypto, tgQrChannelsPerPass, rotate, velocity = {}, thumbs = {}, mediaError = null, postStats = {}, postStatsEntity = {}, channelPhotos = {}, previousPhoto = null } = {}) {
  const calls = {
    post: [], postLanes: [], health: [], persisted: [], logs: [], sessions: [], rotate: [],
    includeVelocity: [], includeMedia: [], persistedVelocity: [], persistedMedia: [],
    postStatsBodies: [], persistedSnapshots: [], savedHashes: [], candidateQueries: [],
  };
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    getSnapshotInternal: async () => previousPhoto ? { data: { channel_photo: previousPhoto } } : null,
    persistTgBundleTx: async (channelId, payload) => {
      calls.persisted.push(channelId);
      calls.persistedSnapshots.push(payload && payload.snapshot);
      calls.persistedVelocity.push(payload && payload.velocity ? payload.velocity : null);
      // Mirror the real repo: velocity is saved (and counted true) ONLY on a real available payload.
      const v = !!(payload && payload.velocity && payload.velocity.available);
      return { channel_daily: 3, posts: 5, velocity: v };
    },
    upsertPostMedia: async (channelId, rows) => {
      calls.persistedMedia.push({ channelId, rows });
      if (mediaError) throw mediaError;
      return rows.length;
    },
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
    saveTgChannelAccessHash: async (channelId, ownerUid, hash, gen) => {
      calls.savedHashes.push({ channelId, ownerUid, hash, gen });
      return true;
    },
    listTgSessions: async () => [],
    listChannels: async () => [],
    // Fake of the single indexed candidate query. Derives (session, channel) rows from the same
    // listTgSessions/listChannels a test configures, applying the SAME filters the real SQL does
    // (active qr channel with tg id owned by the uid, session not reauth_required), ordered by uid
    // then channel id, capped to `limit`. Job-state exclusion (succeeded/live-running) is covered by
    // the Postgres integration test; here runJobOnce drives the claim/skip races.
    listTgQrCollectCandidates: async (day, limit) => {
      calls.candidateQueries.push({ day, limit });
      const sessions = await db.listTgSessions();
      const out = [];
      for (const s of sessions) {
        if (s.connection_state === 'reauth_required') continue;
        let chans = [];
        try { chans = await db.listChannels({ uid: s.uid }); } catch { chans = []; }
        for (const c of chans) {
          if (c.source !== 'qr' || c.tg_channel_id == null || String(c.owner_uid) !== String(s.uid)) continue;
          out.push({
            uid: s.uid, session_enc: s.session_enc, session_version: s.session_version,
            id: c.id, username: c.username, tg_channel_id: c.tg_channel_id, owner_uid: c.owner_uid, source: c.source,
          });
        }
      }
      out.sort((a, b) => (Number(a.uid) - Number(b.uid)) || (a.id - b.id));
      return out.slice(0, Math.max(1, limit));
    },
  };
  const mtprotoPost = async (path, { body, lane }) => {
    // Managed per-post stats travels the SAME breaker client but a distinct path + body (msg_id, no
    // include_*). Driven by `postStats` (ref → payload) and `postStatsEntity` (ref → identity); errors
    // reuse `responses` keyed by ref, exactly like the collect path.
    if (path === '/qr/post_stats') {
      calls.post.push(body.channel);
      calls.postLanes.push(lane);
      calls.sessions.push(body.session);
      calls.postStatsBodies.push(body);
      const err = responses[body.channel];
      if (err) throw err;
      const payload = postStats[body.channel] || { available: true, views_graph: null, reactions: null };
      const defaultEntity = { id: '999', access_hash: null };
      return (body.channel in postStatsEntity)
        ? { ...payload, entity: postStatsEntity[body.channel] }
        : { ...payload, entity: defaultEntity };
    }
    calls.post.push(body.channel);
    calls.postLanes.push(lane);
    calls.sessions.push(body.session);   // record the plaintext session the collect actually sent
    calls.includeVelocity.push(body.include_velocity);   // undefined for ordinary QR, true for central
    calls.includeMedia.push(body.include_media);         // undefined for ordinary QR, true for central
    const err = responses[body.channel];
    if (err) throw err;
    // Central collect opts into velocity → the mtproto bundle carries a velocity payload; ordinary QR
    // never requests it, so the bundle stays exactly OK_BUNDLE (identity preserved for those tests).
    const vel = velocity[body.channel];
    const covers = thumbs[body.channel];
    const photo = channelPhotos[body.channel];
    return vel || covers || photo
      ? { ...OK_BUNDLE, ...(vel ? { velocity: vel } : {}), ...(covers ? { thumbs: covers } : {}), ...(photo ? { channel_photo: photo } : {}) }
      : OK_BUNDLE;
  };
  const job = createTgQrCollectionJob({
    db,
    log: (level, event, meta) => { calls.logs.push({ level, event, meta }); },
    tgCrypto: tgCrypto || activeCrypto(),
    mtprotoPost,
    MTPROTO_TOKEN: 'tok',
    MTPROTO_TIMEOUT_STATS_MS: 500,
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

  // user 1: only a1 attempted (a2 short-circuited); user 2: b1 collected. Different uids now run
  // concurrently, so cross-uid post ORDER is not asserted — only the exact set + that a2 never ran.
  assert.deepEqual([...calls.post].sort(), ['a1', 'b1']);
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

test('processTgQrCollection: cap отбирает cap+1 кандидатов, обрабатывает ровно cap; capped честен', async () => {
  // cap=1: candidate-запрос берёт cap+1=2 кандидата (a1,a2). Обрабатывается ровно cap=1 (a1); наличие
  // второго кандидата честно поднимает capped. a2/a3 добирает следующий проход.
  const { job, db, calls } = makeJob({ tgQrChannelsPerPass: 1 });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2'), ch(3, 'a3')];

  const stats = await job.processTgQrCollection();

  assert.deepEqual(calls.candidateQueries, [{ day: calls.candidateQueries[0].day, limit: 2 }], 'fetches cap+1');
  assert.deepEqual(calls.post, ['a1']); // ровно cap=1 канал обработан
  assert.equal(stats.collected, 1);
  assert.equal(stats.skipped, 0);
  assert.equal(stats.capped, true);
});

test('processTgQrCollection: a skipped race consumes a cap slot and leaves it unused until the next pass', async () => {
  // cap=1, кандидат a1 выбран, но runJobOnce проигрывает гонку claim → skipped. По контракту это НЕ
  // добирается безлимитным сканом: слот cap потрачен, a2 остаётся на следующий 15-минутный проход.
  const { job, db, calls } = makeJob({
    tgQrChannelsPerPass: 1,
    runJobOnce: async (_kind, key, fn) => (key.startsWith('1:')
      ? { skipped: true }                          // lost the atomic claim to a concurrent pass
      : { skipped: false, result: await fn() }),
  });
  db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2'), ch(3, 'a3')];

  const stats = await job.processTgQrCollection();

  assert.deepEqual(calls.post, [], 'the skipped channel never reached upstream; no unbounded refill scan');
  assert.equal(stats.skipped, 1);
  assert.equal(stats.collected, 0);
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

test('processTgQrCollection: resolves candidates via the single indexed query, never the legacy scan', async () => {
  const { job, db, calls } = makeJob();
  let candidateCalls = 0;
  // The O(N) legacy fan-out must be gone: touching either method is a hard failure.
  db.listTgSessions = async () => { throw new Error('legacy listTgSessions scan must not run'); };
  db.listChannels = async () => { throw new Error('legacy listChannels scan must not run'); };
  db.listTgQrCollectCandidates = async (_day, _limit) => {
    candidateCalls += 1;
    return [{ uid: 1, session_enc: 's', session_version: '1', id: 1, username: 'a1', tg_channel_id: 1001, owner_uid: 1, source: 'qr' }];
  };

  const stats = await job.processTgQrCollection();

  assert.equal(candidateCalls, 1, 'exactly one candidate query per pass');
  assert.deepEqual(calls.post, ['a1']);
  assert.equal(stats.collected, 1);
});

test('processTgQrCollection: candidate query DB failure → empty stats, nothing collected', async () => {
  const { job, db, calls } = makeJob();
  db.listTgQrCollectCandidates = async () => { throw new Error('db down'); };
  const stats = await job.processTgQrCollection();
  assert.deepEqual(stats, { collected: 0, skipped: 0, failed: 0, capped: false });
  assert.deepEqual(calls.post, []);
  assert.ok(calls.logs.some((l) => l.event === 'tg_qr_list_candidates_failed'));
});

test('processTgQrCollection: different uids overlap, channels within one uid never overlap', async () => {
  // Two sessions × two channels each. Bounded concurrency runs the two uids in parallel (session
  // decrypt → plaintext = session_enc, so body.session identifies the uid), but a uid's own channels
  // stay strictly serialized inside its group.
  const activeSessions = new Set();
  let maxConcurrentUids = 0;
  const inflightBySession = new Map();
  let maxPerUid = 0;
  const mtprotoPost = async (_path, { body }) => {
    const sk = body.session;
    activeSessions.add(sk);
    maxConcurrentUids = Math.max(maxConcurrentUids, activeSessions.size);
    const n = (inflightBySession.get(sk) || 0) + 1;
    inflightBySession.set(sk, n);
    maxPerUid = Math.max(maxPerUid, n);
    // Yield a couple of turns so genuinely-concurrent requests observe each other in-flight.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const left = inflightBySession.get(sk) - 1;
    inflightBySession.set(sk, left);
    if (left === 0) activeSessions.delete(sk);
    return OK_BUNDLE;
  };
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    persistTgBundleTx: async () => ({ channel_daily: 1, posts: 1 }),
    runJobOnce: async (_kind, _key, fn) => ({ skipped: false, result: await fn() }),
    recordTgSessionAttempt: async () => true,
    recordTgSessionSuccess: async () => true,
    recordTgSessionFailure: async () => true,
    rotateTgSessionCiphertext: async () => true,
    listTgQrCollectCandidates: async () => ([
      { uid: 1, session_enc: 's1', session_version: '1', id: 1, username: 'u1a', tg_channel_id: 1001, owner_uid: 1, source: 'qr' },
      { uid: 1, session_enc: 's1', session_version: '1', id: 2, username: 'u1b', tg_channel_id: 1002, owner_uid: 1, source: 'qr' },
      { uid: 2, session_enc: 's2', session_version: '1', id: 3, username: 'u2a', tg_channel_id: 1003, owner_uid: 2, source: 'qr' },
      { uid: 2, session_enc: 's2', session_version: '1', id: 4, username: 'u2b', tg_channel_id: 1004, owner_uid: 2, source: 'qr' },
    ]),
  };
  const job = createTgQrCollectionJob({
    db,
    log: () => {},
    tgCrypto: activeCrypto(),
    mtprotoPost,
    MTPROTO_TOKEN: 'tok',
    MTPROTO_TIMEOUT_HEAVY_MS: 1000,
    tgPostToRow: (p) => p,
    tgQrSessionConcurrency: 4,
  });

  const stats = await job.processTgQrCollection();

  assert.equal(stats.collected, 4);
  assert.equal(maxConcurrentUids, 2, 'the two different sessions ran concurrently');
  assert.equal(maxPerUid, 1, 'a single session never runs two channels at once');
});

test('processTgQrCollection: session concurrency of 1 serializes all sessions', async () => {
  const activeSessions = new Set();
  let maxConcurrentUids = 0;
  const mtprotoPost = async (_path, { body }) => {
    activeSessions.add(body.session);
    maxConcurrentUids = Math.max(maxConcurrentUids, activeSessions.size);
    await new Promise((r) => setImmediate(r));
    activeSessions.delete(body.session);
    return OK_BUNDLE;
  };
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    persistTgBundleTx: async () => ({ channel_daily: 1, posts: 1 }),
    runJobOnce: async (_kind, _key, fn) => ({ skipped: false, result: await fn() }),
    recordTgSessionAttempt: async () => true,
    recordTgSessionSuccess: async () => true,
    recordTgSessionFailure: async () => true,
    rotateTgSessionCiphertext: async () => true,
    listTgQrCollectCandidates: async () => ([
      { uid: 1, session_enc: 's1', session_version: '1', id: 1, username: 'u1a', tg_channel_id: 1001, owner_uid: 1, source: 'qr' },
      { uid: 2, session_enc: 's2', session_version: '1', id: 2, username: 'u2a', tg_channel_id: 1002, owner_uid: 2, source: 'qr' },
    ]),
  };
  const job = createTgQrCollectionJob({
    db, log: () => {}, tgCrypto: activeCrypto(), mtprotoPost,
    MTPROTO_TOKEN: 'tok', MTPROTO_TIMEOUT_HEAVY_MS: 1000, tgPostToRow: (p) => p,
    tgQrSessionConcurrency: 1,
  });

  await job.processTgQrCollection();
  assert.equal(maxConcurrentUids, 1, 'concurrency=1 keeps sessions strictly serial');
});

test('processTgQrCollection: auth failure stops ONLY its uid, the other uid still collects', async () => {
  // uid 1 hits an auth failure on its first channel (short-circuits its second); uid 2 is unaffected.
  const { job, db, calls } = makeJob({ responses: { u1a: authErr() } });
  db.listTgSessions = async () => [
    { uid: 1, session_enc: 's1', session_version: '1' },
    { uid: 2, session_enc: 's2', session_version: '1' },
  ];
  db.listChannels = async ({ uid }) => (uid === 1
    ? [ch(1, 'u1a', 1), ch(2, 'u1b', 1)]
    : [ch(3, 'u2a', 2), ch(4, 'u2b', 2)]);

  await job.processTgQrCollection();

  // uid 1: only u1a attempted (u1b short-circuited); uid 2: both channels collected.
  assert.deepEqual([...calls.post].sort(), ['u1a', 'u2a', 'u2b']);
  const u1fail = calls.health.filter((c) => c[1] === 1).find((c) => c[0] === 'failure');
  assert.deepEqual(u1fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
  const u2 = calls.health.filter((c) => c[1] === 2);
  assert.ok(u2.some((c) => c[0] === 'success'), 'uid 2 stayed healthy');
  assert.ok(!u2.some((c) => c[0] === 'failure'), 'uid 2 never failed');
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

test('collectManagedChannelNow: sends include_velocity=true and persists+returns a real velocity payload', async () => {
  const VEL = { available: true, posts_used: 3, by_day: [{ day: 0, share: 50, cum: 50 }], day1_share: 50, t80_days: 2 };
  const { job, calls } = makeJob({ velocity: { central: VEL } });
  const out = await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');

  assert.deepEqual(calls.includeVelocity, [true], 'central collect explicitly opts into the velocity fanout');
  assert.deepEqual(calls.persistedVelocity, [VEL], 'the velocity payload was threaded into persistTgBundleTx');
  assert.equal(out.velocity, true, 'velocity=true reflects a real persisted available payload');
});

test('collectManagedChannelNow: opts into media and persists returned covers best-effort', async () => {
  const covers = [{ post_id: 1241, size: 'sm', jpeg_b64: '/9j/2Q==' }];
  const { job, calls } = makeJob({ thumbs: { central: covers } });
  await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');

  assert.deepEqual(calls.includeMedia, [true], 'central collect explicitly opts into cover download');
  assert.deepEqual(calls.persistedMedia, [{ channelId: 50, rows: covers }]);
});

test('thumbnail persistence failure never rolls back or fails fresh product metrics', async () => {
  const covers = [{ post_id: 1241, size: 'sm', jpeg_b64: '/9j/2Q==' }];
  const { job, calls } = makeJob({ thumbs: { central: covers }, mediaError: new Error('db details') });
  const out = await job.collectManagedChannelNow(
    { uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');

  assert.equal(out.channel_daily, 3);
  assert.equal(out.posts, 5);
  assert.deepEqual(calls.persisted, [50], 'core transaction still committed');
  const log = calls.logs.find((row) => row.event === 'tg_post_media_persist_failed');
  assert.deepEqual(log?.meta, { channelId: 50, error: 'write_failed' });
  assert.equal(JSON.stringify(calls.logs).includes('db details'), false, 'raw DB error is never logged');
});

test('collectManagedChannelNow: an available:false velocity is NOT reported as success', async () => {
  const { job, calls } = makeJob({ velocity: { central: { available: false, posts_used: 0 } } });
  const out = await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');

  assert.deepEqual(calls.includeVelocity, [true]);
  assert.equal(out.velocity, false, 'no eligible posts → velocity is never fabricated as true');
});

test('collectManagedChannelNow: a bundle with no velocity key returns velocity=false', async () => {
  const { job, calls } = makeJob();   // OK_BUNDLE carries no velocity
  const out = await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');
  assert.deepEqual(calls.includeVelocity, [true]);
  assert.equal(out.velocity, false);
});

test('ordinary QR (nightly + immediate) NEVER sets central velocity/media fanout flags', async () => {
  const nightly = makeJob();
  nightly.db.listTgSessions = async () => [{ uid: 1, session_enc: 's', session_version: '1' }];
  nightly.db.listChannels = async () => [ch(1, 'a1'), ch(2, 'a2')];
  await nightly.job.processTgQrCollection();
  assert.deepEqual(nightly.calls.includeVelocity, [undefined, undefined], 'nightly QR omits velocity opt-in');
  assert.deepEqual(nightly.calls.includeMedia, [undefined, undefined], 'nightly QR omits media opt-in');

  const now = makeJob();
  await now.job.collectQrChannelsNow({ uid: 6, session_enc: 's', session_version: '1' }, [ch(1, 'a1', 6)]);
  assert.deepEqual(now.calls.includeVelocity, [undefined], 'immediate post-add QR omits velocity opt-in');
  assert.deepEqual(now.calls.includeMedia, [undefined], 'immediate post-add QR omits media opt-in');
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

// ── Managed avatar (channel photo) persistence — best-effort, bounded, top-level snapshot field ──

test('collectManagedChannelNow: persists a valid bounded channel photo as a TOP-LEVEL snapshot field', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb]).toString('base64');
  const { job, calls } = makeJob({ channelPhotos: { central: jpeg } });
  await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');

  // Sibling of `channel`, never inside it, so /api/tg/full keeps shipping only d.channel.
  assert.equal(calls.persistedSnapshots[0].channel_photo, jpeg);
  assert.equal('channel_photo' in calls.persistedSnapshots[0].channel, false);
});

test('collectManagedChannelNow: a malformed/oversized photo is dropped, snapshot + metrics survive', async () => {
  const notJpeg = Buffer.from('not-a-jpeg-payload').toString('base64');
  const { job, calls } = makeJob({ channelPhotos: { central: notJpeg } });
  const out = await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');

  assert.equal('channel_photo' in calls.persistedSnapshots[0], false, 'a non-JPEG avatar is not stored');
  assert.equal(out.channel_daily, 3, 'core metrics are never affected by the best-effort avatar');
  assert.equal(out.posts, 5);
});

test('collectManagedChannelNow: no channel photo in the bundle → snapshot has no channel_photo key', async () => {
  const { job, calls } = makeJob();   // OK_BUNDLE carries no channel_photo
  await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');
  assert.equal('channel_photo' in calls.persistedSnapshots[0], false);
});

test('collectManagedChannelNow: transient photo miss preserves the last valid snapshot avatar', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x10, 0x20]).toString('base64');
  const { job, calls } = makeJob({ previousPhoto: jpeg });
  await job.collectManagedChannelNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), '2026-07-15');
  assert.equal(calls.persistedSnapshots[0].channel_photo, jpeg);
});

// ── collectManagedPostStatsNow (managed central per-post stats, LIVE lane, rethrows for fallback) ──

test('collectManagedPostStatsNow: success → live lane, healthy, returns the payload with entity stripped', async () => {
  const { job, calls } = makeJob({
    postStats: { central: { available: true, views_graph: { x: [1], series: [] }, reactions: [] } },
    postStatsEntity: { central: { id: '999', access_hash: '5' } },   // matches central().tg_channel_id
  });
  const out = await job.collectManagedPostStatsNow({ uid: 2, session_enc: 'plain-secret', session_version: '4' }, central(), 777);

  assert.deepEqual(out, { available: true, views_graph: { x: [1], series: [] }, reactions: [] });
  assert.equal(out.entity, undefined, 'the private entity identity never reaches the route/cache');
  assert.deepEqual(calls.post, ['central']);
  assert.deepEqual(calls.postLanes, ['live'], 'a per-post dashboard read uses the LIVE breaker lane');
  const body = calls.postStatsBodies[0];
  assert.equal(body.msg_id, 777);
  assert.equal(body.session, 'plain-secret');    // decrypted plaintext, only in the body
  assert.equal(body.access_hash, undefined, 'a username channel needs no access_hash');
  assert.deepEqual(calls.health[0], ['attempt', 2]);
  assert.deepEqual(calls.health[1], ['success', 2]);   // generation-guarded via session_version
});

test('collectManagedPostStatsNow: an available:false (too-few-views) 200 is returned and counts as healthy', async () => {
  const { job, calls } = makeJob({ postStats: { central: { available: false, error: 'not enough data' } } });
  const out = await job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 5);

  assert.equal(out.available, false, 'available=false is passed through, never fabricated to true');
  assert.deepEqual(calls.health[1], ['success', 2], 'a 200 proves the session works, even with no post stats');
});

test('collectManagedPostStatsNow: private central channel forwards the stored access_hash (warm path)', async () => {
  const HASH = '7345987012345678901';   // > 2**53 → must survive as an exact string
  const { job, db, calls } = makeJob({
    postStats: { '-1001234567890': { available: true } },
    postStatsEntity: { '-1001234567890': { id: '1234567890', access_hash: HASH } },
  });
  db.getTgChannelIdentity = async (channelId, ownerUid) => (channelId === 50 && String(ownerUid) === '2'
    ? { tg_channel_id: '-1001234567890', tg_access_hash: HASH, tg_access_hash_version: '4' } : null);
  const ch = central({ username: null, tg_channel_id: '-1001234567890' });

  await job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, ch, 9);

  assert.equal(calls.postStatsBodies[0].access_hash, HASH, 'stored hash forwarded byte-exact, no dialog scan');
  assert.deepEqual(calls.savedHashes, [], 'unchanged warm hash does not write');
});

test('collectManagedPostStatsNow: refreshed private access_hash self-heals generation-guarded', async () => {
  const OLD = '7345987012345678901';
  const FRESH = '7345987012345678999';
  const ref = '-1001234567890';
  const { job, db, calls } = makeJob({
    postStats: { [ref]: { available: true } },
    postStatsEntity: { [ref]: { id: '1234567890', access_hash: FRESH } },
  });
  db.getTgChannelIdentity = async () => ({
    tg_channel_id: ref, tg_access_hash: OLD, tg_access_hash_version: '4',
  });
  const channel = central({ username: null, tg_channel_id: ref });
  await job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, channel, 9);
  assert.equal(calls.postStatsBodies[0].access_hash, OLD);
  assert.deepEqual(calls.savedHashes, [{ channelId: 50, ownerUid: 2, hash: FRESH, gen: '4' }]);
});

test('collectManagedPostStatsNow: auth failure → reauth_required health then RETHROWS for fallback', async () => {
  const { job, calls } = makeJob({ responses: { central: authErr() } });
  await assert.rejects(
    job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 9),
    (e) => e.code === 'session_unauthorized',
  );
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
});

test('collectManagedPostStatsNow: 503 mtproto_session_unauthorized is also auth → reauth_required', async () => {
  const { job, calls } = makeJob({ responses: { central: authErr503() } });
  await assert.rejects(
    job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 9),
    (e) => e.code === 'mtproto_session_unauthorized',
  );
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'mtproto_session_unauthorized' });
});

test('collectManagedPostStatsNow: non-auth failure (timeout) → degraded then RETHROWS for fallback', async () => {
  const { job, calls } = makeJob({ responses: { central: timeoutErr() } });
  await assert.rejects(
    job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 9),
    (e) => e.code === 'mtproto_timeout',
  );
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'degraded', errorCode: 'mtproto_timeout' });
});

test('collectManagedPostStatsNow: entity mismatch fails closed (degraded) and never serves foreign stats', async () => {
  const { job, calls } = makeJob({
    postStats: { central: { available: true } },
    postStatsEntity: { central: { id: '888', access_hash: '5' } },   // != central().tg_channel_id (999)
  });
  await assert.rejects(
    job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 9),
    (e) => e.code === 'collect_failed',
  );
  assert.ok(calls.logs.some((l) => l.event === 'tg_managed_post_stats_identity_mismatch'));
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.equal(fail[2].state, 'degraded');
});

test('collectManagedPostStatsNow: missing or malformed entity identity also fails closed', async () => {
  for (const entity of [null, { id: 'not-an-id' }]) {
    const { job, calls } = makeJob({ postStatsEntity: { central: entity } });
    await assert.rejects(
      job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 9),
      (e) => e.code === 'collect_failed',
    );
    assert.equal(calls.health.find((c) => c[0] === 'failure')[2].state, 'degraded');
  }
});

test('collectManagedPostStatsNow: decrypt failure rethrows a safe code and records NO attempt', async () => {
  const { job, calls } = makeJob({ tgCrypto: { configured: () => true, encrypt: (p) => `enc:${p}`, decryptDetailed: () => { throw new Error('bad key'); } } });
  await assert.rejects(
    job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, central(), 9),
    (e) => e.code === 'session_decrypt_failed',
  );
  assert.deepEqual(calls.post, []);     // never reached upstream
  assert.deepEqual(calls.health, []);   // no attempt recorded for a crypto/config failure
});

test('collectManagedPostStatsNow: missing tg id / bad msg id / non-owner → prereq throw, no upstream call', async () => {
  for (const [ch, msg] of [
    [central({ tg_channel_id: null }), 9],
    [central(), 0],
    [central(), -3],
  ]) {
    const { job, calls } = makeJob();
    await assert.rejects(
      job.collectManagedPostStatsNow({ uid: 2, session_enc: 's', session_version: '4' }, ch, msg),
      (e) => e.code === 'managed_prereq',
    );
    assert.deepEqual(calls.post, []);
  }
  // A session whose uid is NOT the channel owner may never use it.
  const { job, calls } = makeJob();
  await assert.rejects(
    job.collectManagedPostStatsNow({ uid: 3, session_enc: 's', session_version: '4' }, central(), 9),
    (e) => e.code === 'managed_prereq',
  );
  assert.deepEqual(calls.post, []);
});

test('collectManagedPostStatsNow: plaintext session goes ONLY in the body, never into logs', async () => {
  const SECRET = 'STRING-SESSION-SECRET';
  const { job, calls } = makeJob({
    responses: { central: timeoutErr() },
    tgCrypto: { configured: () => true, encrypt: (p) => `enc:${p}`, decryptDetailed: () => ({ plaintext: SECRET, usedPreviousKey: false }) },
  });
  await assert.rejects(job.collectManagedPostStatsNow({ uid: 2, session_enc: 'enc', session_version: '4' }, central(), 9));
  assert.equal(calls.sessions[0], SECRET, 'sent in the private body');
  assert.equal(JSON.stringify(calls.logs).includes(SECRET), false, 'never logged');
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
    // Candidate query fake for the warm-path generation-guard test: derive rows from listTgSessions/
    // listChannels with the same filters + (uid, id) order the real SQL uses.
    listTgQrCollectCandidates: async (_day, limit) => {
      const sessions = await db.listTgSessions();
      const out = [];
      for (const s of sessions) {
        if (s.connection_state === 'reauth_required') continue;
        const chans = await db.listChannels({ uid: s.uid });
        for (const c of chans) {
          if (c.source !== 'qr' || c.tg_channel_id == null || String(c.owner_uid) !== String(s.uid)) continue;
          out.push({
            uid: s.uid, session_enc: s.session_enc, session_version: s.session_version,
            id: c.id, username: c.username, tg_channel_id: c.tg_channel_id, owner_uid: c.owner_uid, source: c.source,
          });
        }
      }
      out.sort((a, b) => (Number(a.uid) - Number(b.uid)) || (a.id - b.id));
      return out.slice(0, Math.max(1, limit));
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

// ── repairCentralMedia (bounded central cover backfill, background lane, NEVER rethrows) ─────────
// Server-side identity only: the central channel + its owner + that owner's session. A bounded batch
// of recent photo/video posts missing an 'sm' cover is fetched by exact id through /qr/media; the
// resolved entity must match the central channel before any bytes are persisted; health follows the
// same auth→reauth / transient→degraded priority; per-item misses and persist failures are best-effort.
function makeMediaJob({
  missing = [{ post_id: '1306' }, { post_id: '1312' }], covers = [{ post_id: '1306', size: 'sm', jpeg_b64: '/9j/2Q==' }],
  entity, responses = {}, central: centralOver = {}, session, upsertResult, upsertThrows = false,
  tgCrypto, stored = null, ownerHasSession = true, runJobOnce,
} = {}) {
  const calls = { post: [], postLanes: [], sessions: [], bodies: [], persistedMedia: [], health: [], logs: [], savedHashes: [], missingQuery: null, jobKeys: [] };
  const centralCh = { id: 50, username: 'central', tg_channel_id: 999, source: 'central', owner_uid: 2, ...centralOver };
  const sess = session === undefined
    ? { uid: 2, session_enc: 'enc', session_version: '4', connection_state: 'healthy' }
    : session;
  const db = {
    enabled: true,
    graphsToDailyRows: () => [],
    saveRawSnapshot: async () => {},
    getOwnerChannelId: async () => 50,
    getChannelById: async (id) => (id === 50 ? centralCh : null),
    getTgSession: async (uid) => (ownerHasSession && sess && String(uid) === String(centralCh.owner_uid) ? sess : null),
    listCentralPostsMissingMedia: async (channelId, opts) => { calls.missingQuery = { channelId, opts }; return missing; },
    runJobOnce: runJobOnce || (async (kind, key, fn) => {
      calls.jobKeys.push({ kind, key });
      return { skipped: false, result: await fn() };
    }),
    upsertPostMedia: async (channelId, rows) => {
      calls.persistedMedia.push({ channelId, rows });
      if (upsertThrows) throw new Error('db down');
      return upsertResult != null ? upsertResult : rows.length;
    },
    recordTgSessionAttempt: async (uid) => { calls.health.push(['attempt', uid]); return true; },
    recordTgSessionSuccess: async (uid) => { calls.health.push(['success', uid]); return true; },
    recordTgSessionFailure: async (uid, _v, arg) => { calls.health.push(['failure', uid, arg]); return true; },
    rotateTgSessionCiphertext: async () => true,
    getTgChannelIdentity: async (channelId, ownerUid) => (stored && channelId === 50 && String(ownerUid) === '2' ? stored : null),
    saveTgChannelAccessHash: async (channelId, ownerUid, hash, gen) => { calls.savedHashes.push({ channelId, ownerUid, hash, gen }); return true; },
    listTgSessions: async () => [],
    listChannels: async () => [],
  };
  const mtprotoPost = async (path, { body, lane }) => {
    calls.post.push(path);
    calls.postLanes.push(lane);
    calls.sessions.push(body.session);
    calls.bodies.push(body);
    const err = responses['/qr/media'];
    if (err) throw err;
    const ent = entity !== undefined ? entity : { id: '999', access_hash: null };
    return { covers, entity: ent };
  };
  const job = createTgQrCollectionJob({
    db,
    log: (level, event, meta) => { calls.logs.push({ level, event, meta }); },
    tgCrypto: tgCrypto || activeCrypto(),
    mtprotoPost,
    MTPROTO_TOKEN: 'tok',
    MTPROTO_TIMEOUT_STATS_MS: 500,
    MTPROTO_TIMEOUT_HEAVY_MS: 1000,
    tgPostToRow: (p) => p,
  });
  return { job, db, calls };
}

test('repairCentralMedia: bounded missing batch → exact string ids to /qr/media (background), persists covers, healthy', async () => {
  const { job, calls } = makeMediaJob();
  const stats = await job.repairCentralMedia();

  assert.deepEqual(calls.post, ['/qr/media']);
  assert.deepEqual(calls.postLanes, ['background'], 'cover repair is background collection work');
  assert.equal(calls.missingQuery.opts.windowDays, 365, 'direct job construction keeps the documented archive window');
  assert.deepEqual(calls.bodies[0].msg_ids, ['1306', '1312'], 'exact decimal-string post ids, no Number coercion');
  assert.equal(calls.bodies[0].session, 'enc', 'decrypted plaintext session travels only in the body');
  assert.deepEqual(calls.persistedMedia, [{ channelId: 50, rows: [{ post_id: '1306', size: 'sm', jpeg_b64: '/9j/2Q==' }] }]);
  assert.deepEqual(calls.health[0], ['attempt', 2]);
  assert.deepEqual(calls.health[1], ['success', 2]);
  assert.deepEqual(stats, { attempted: true, requested: 2, filled: 1 });
});

test('repairCentralMedia: forwards the injected cap + window to the missing-cover query', async () => {
  const { job, calls } = makeMediaJob();
  await job.repairCentralMedia({ cap: 5, windowDays: 30 });
  assert.equal(calls.missingQuery.channelId, 50);
  assert.equal(calls.missingQuery.opts.limit, 5);
  assert.equal(calls.missingQuery.opts.windowDays, 30);
  assert.match(calls.missingQuery.opts.seed, /^\d+$/);
});

test('repairCentralMedia: nothing missing → no upstream call, no health touch', async () => {
  const { job, calls } = makeMediaJob({ missing: [] });
  const stats = await job.repairCentralMedia();
  assert.deepEqual(calls.post, []);
  assert.deepEqual(calls.health, []);
  assert.deepEqual(stats, { attempted: false, requested: 0, filled: 0 });
});

test('repairCentralMedia: a preserved-preexisting BIGINT post id survives byte-exact as a string', async () => {
  const BIG = '9007199254740997';   // > 2**53 → corrupted if ever coerced through a JS Number
  assert.notEqual(String(Number(BIG)), BIG);
  const { job, calls } = makeMediaJob({ missing: [{ post_id: BIG }], covers: [] });
  await job.repairCentralMedia();
  assert.deepEqual(calls.bodies[0].msg_ids, [BIG]);
});

test('repairCentralMedia: entity mismatch fails closed — no persist, degraded, never rethrows', async () => {
  const { job, calls } = makeMediaJob({ entity: { id: '888', access_hash: null } });   // != central tg id 999
  await assert.doesNotReject(job.repairCentralMedia());
  assert.deepEqual(calls.persistedMedia, [], 'wrong-channel bytes never reach tg_post_media');
  assert.ok(calls.logs.some((l) => l.event === 'tg_media_repair_identity_mismatch'));
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.equal(fail[2].state, 'degraded');
});

test('repairCentralMedia: auth failure → reauth_required (that generation), never rethrows', async () => {
  const { job, calls } = makeMediaJob({ responses: { '/qr/media': authErr() } });
  await assert.doesNotReject(job.repairCentralMedia());
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
  assert.ok(calls.logs.some((l) => l.event === 'tg_media_repair_failed' && l.meta.code === 'session_unauthorized'));
});

test('repairCentralMedia: transient failure → degraded, never rethrows', async () => {
  const { job, calls } = makeMediaJob({ responses: { '/qr/media': timeoutErr() } });
  await assert.doesNotReject(job.repairCentralMedia());
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'degraded', errorCode: 'mtproto_timeout' });
});

test('repairCentralMedia: a flood-limited endpoint is transient (degraded), not reauth', async () => {
  const { job, calls } = makeMediaJob({ responses: { '/qr/media': floodErr() } });
  await job.repairCentralMedia();
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'degraded', errorCode: 'flood_wait' });
});

test('repairCentralMedia: reauth_required session is skipped (no upstream, no health)', async () => {
  const { job, calls } = makeMediaJob({ session: { uid: 2, session_enc: 'enc', session_version: '4', connection_state: 'reauth_required' } });
  const stats = await job.repairCentralMedia();
  assert.deepEqual(calls.post, []);
  assert.deepEqual(calls.health, []);
  assert.equal(stats.attempted, false);
});

test('repairCentralMedia: a missing owner session is skipped', async () => {
  const { job, calls } = makeMediaJob({ ownerHasSession: false });
  const stats = await job.repairCentralMedia();
  assert.deepEqual(calls.post, []);
  assert.equal(stats.attempted, false);
});

test('repairCentralMedia: decrypt failure records NO attempt and never calls upstream', async () => {
  const { job, calls } = makeMediaJob({
    tgCrypto: { configured: () => true, encrypt: (p) => `enc:${p}`, decryptDetailed: () => { throw new Error('bad key'); } },
  });
  const stats = await job.repairCentralMedia();
  assert.deepEqual(calls.post, []);
  assert.deepEqual(calls.health, []);
  assert.equal(stats.attempted, false);
  assert.ok(calls.logs.some((l) => l.event === 'tg_media_repair_decrypt_failed'));
});

test('repairCentralMedia: persist failure is best-effort — logs safe code, stays healthy, never rethrows', async () => {
  const { job, calls } = makeMediaJob({ upsertThrows: true });
  let stats;
  await assert.doesNotReject(async () => { stats = await job.repairCentralMedia(); });
  assert.ok(calls.logs.some((l) => l.event === 'tg_post_media_persist_failed' && l.meta.error === 'write_failed'));
  assert.ok(calls.health.some((c) => c[0] === 'success'), 'a per-item persist failure does not degrade the session');
  assert.equal(JSON.stringify(calls.logs).includes('db down'), false, 'raw DB error text is never logged');
  assert.equal(stats.filled, 0);
});

test('repairCentralMedia: private central channel forwards the stored access_hash (warm) and self-heals a refresh', async () => {
  const HASH = '7345987012345678901';    // > 2**53 → must survive byte-exact
  const FRESH = '7345987012345678999';
  const { job, calls } = makeMediaJob({
    central: { username: null, tg_channel_id: '-1001234567890' },
    stored: { tg_channel_id: '-1001234567890', tg_access_hash: HASH, tg_access_hash_version: '4' },
    entity: { id: '1234567890', access_hash: FRESH },
  });
  await job.repairCentralMedia();
  assert.equal(calls.bodies[0].access_hash, HASH, 'stored hash forwarded byte-exact, no dialog scan');
  assert.deepEqual(calls.savedHashes, [{ channelId: 50, ownerUid: 2, hash: FRESH, gen: '4' }], 'refreshed hash cached generation-guarded');
});

test('repairCentralMedia: plaintext session goes ONLY in the body, never into logs', async () => {
  const SECRET = 'STRING-SESSION-SECRET';
  const { job, calls } = makeMediaJob({
    responses: { '/qr/media': timeoutErr() },
    tgCrypto: { configured: () => true, encrypt: (p) => `enc:${p}`, decryptDetailed: () => ({ plaintext: SECRET, usedPreviousKey: false }) },
  });
  await job.repairCentralMedia();
  assert.equal(calls.sessions[0], SECRET, 'sent in the private body');
  assert.equal(JSON.stringify(calls.logs).includes(SECRET), false, 'never logged');
});

test('repairCentralMedia: unexpected post ids from internal response are never persisted', async () => {
  const { job, calls } = makeMediaJob({
    covers: [
      { post_id: '1306', size: 'sm', jpeg_b64: '/9j/2Q==' },
      { post_id: '9999', size: 'sm', jpeg_b64: '/9j/2Q==' },
      { post_id: '1312', size: 'lg', jpeg_b64: '/9j/2Q==' },
    ],
  });
  await job.repairCentralMedia();
  assert.deepEqual(calls.persistedMedia[0].rows, [
    { post_id: '1306', size: 'sm', jpeg_b64: '/9j/2Q==' },
  ]);
});

test('repairCentralMedia: durable six-hour claim collapses an overlapping pass', async () => {
  const { job, calls } = makeMediaJob({ runJobOnce: async () => ({ skipped: true, job: { status: 'running' } }) });
  const stats = await job.repairCentralMedia();
  assert.deepEqual(stats, { attempted: false, requested: 0, filled: 0 });
  assert.deepEqual(calls.post, []);
  assert.deepEqual(calls.health, []);
});

test('repairCentralMedia: feature-detect — a db without listCentralPostsMissingMedia no-ops safely', async () => {
  const bare = makeMediaJob();
  delete bare.db.listCentralPostsMissingMedia;
  const stats = await bare.job.repairCentralMedia();
  assert.deepEqual(bare.calls.post, []);
  assert.deepEqual(stats, { attempted: false, requested: 0, filled: 0 });
});

// ── Retry semantics: which failures fail the durable six-hour bucket (retryable next pass) and which
// complete it (throttled) — the deployment-skew follow-up to PR #231. A runJobOnce that mirrors the
// real repo (fn throw → row 'failed'/retryable → rethrow; fn return → row 'succeeded'/throttled) makes
// the bucket outcome observable, and repairCentralMedia must never reject to the caller either way.
function statusTrackingRunJobOnce() {
  const ref = { status: null };
  const runJobOnce = async (_kind, _key, fn) => {
    try { const result = await fn(); ref.status = 'succeeded'; return { skipped: false, result }; }
    catch (e) { ref.status = 'failed'; throw e; }   // mirror jobsRepo: failJob then rethrow
  };
  return { runJobOnce, ref };
}

test('repairCentralMedia: deployment-skew transient failure fails the bucket, the next pass retries the SAME bucket', async () => {
  const realNow = Date.now;
  const bucket = 314159;
  Date.now = () => bucket * 6 * 60 * 60 * 1000 + 1000;
  try {
    // Model the durable jobs ledger: a 'succeeded' bucket is skipped, a 'failed' one is re-claimable.
    const jobs = new Map();
    jobs.set(`50:${bucket}`, 'succeeded'); // poisoned legacy PR #231 key already present in production
    const runJobOnce = async (_kind, key, fn) => {
      const st = jobs.get(key);
      if (st === 'succeeded' || st === 'running') return { skipped: true, job: { status: st } };
      jobs.set(key, 'running');
      try { const result = await fn(); jobs.set(key, 'succeeded'); return { skipped: false, result }; }
      catch (e) { jobs.set(key, 'failed'); throw e; }
    };
    // The first pass hits the OLD mtproto (just-restarted web, un-migrated service) → transient failure.
    const responses = { '/qr/media': timeoutErr() };
    const { job, calls } = makeMediaJob({ runJobOnce, responses });

    const first = await job.repairCentralMedia();
    assert.deepEqual(first, { attempted: false, requested: 0, filled: 0 }, 'never rejects; outer catch returns empty stats');
    assert.deepEqual(calls.persistedMedia, [], 'a transient failure persists nothing');
    assert.equal(jobs.size, 2, 'the generation-aware key bypasses the poisoned legacy bucket');
    assert.equal(jobs.get(`50:4:top-v1:${bucket}`), 'failed', 'the new six-hour bucket is left FAILED → retryable, not completed');

    // Next 15-min recovery tick, SAME six-hour bucket: the NEW mtproto now answers 200.
    delete responses['/qr/media'];
    const second = await job.repairCentralMedia();
    assert.equal(jobs.size, 2, 'the retry reclaims the SAME generation-aware key, it does not open a new one');
    assert.equal(jobs.get(`50:4:top-v1:${bucket}`), 'succeeded', 'the retry completes the SAME bucket');
    assert.deepEqual(calls.persistedMedia, [{ channelId: 50, rows: [{ post_id: '1306', size: 'sm', jpeg_b64: '/9j/2Q==' }] }],
      'the covers missed by the skewed pass are filled on the retry');
    assert.deepEqual(second, { attempted: true, requested: 2, filled: 1 });
  } finally {
    Date.now = realNow;
  }
});

test('repairCentralMedia: a zero-cover success completes the bucket (throttled), not retried every 15 min', async () => {
  const { runJobOnce, ref } = statusTrackingRunJobOnce();
  // Genuinely thumbless posts: the endpoint 200s but returns no covers for the requested ids.
  const { job, calls } = makeMediaJob({ runJobOnce, covers: [] });
  const stats = await job.repairCentralMedia();

  assert.equal(ref.status, 'succeeded', 'a 200 with zero covers still COMPLETES the durable bucket');
  assert.deepEqual(calls.persistedMedia, [], 'nothing to persist for thumbless posts');
  assert.deepEqual(calls.health[1], ['success', 2], 'a 200 with zero covers proves the session works');
  assert.deepEqual(stats, { attempted: true, requested: 2, filled: 0 });
});

test('repairCentralMedia: a DB query failure fails the bucket (retryable) and never degrades session health', async () => {
  const { runJobOnce, ref } = statusTrackingRunJobOnce();
  const { job, db, calls } = makeMediaJob({ runJobOnce });
  db.listCentralPostsMissingMedia = async () => { throw new Error('db read carrying SECRET-DETAIL'); };

  const stats = await job.repairCentralMedia();

  assert.deepEqual(stats, { attempted: false, requested: 0, filled: 0 }, 'never rejects to the caller');
  assert.equal(ref.status, 'failed', 'a DB read fault leaves the bucket retryable for the next pass');
  assert.deepEqual(calls.post, [], 'the session was never contacted');
  assert.deepEqual(calls.health, [], 'a DB-only failure must NOT touch Telegram session health');
  assert.ok(calls.logs.some((l) => l.event === 'tg_media_repair_query_failed'));
  assert.equal(JSON.stringify(calls.logs).includes('SECRET-DETAIL'), false, 'raw DB error text is never logged');
});

test('repairCentralMedia: a DB persist failure fails the bucket (retryable) and keeps the session healthy', async () => {
  const { runJobOnce, ref } = statusTrackingRunJobOnce();
  const { job, calls } = makeMediaJob({ runJobOnce, upsertThrows: true });

  const stats = await job.repairCentralMedia();

  assert.deepEqual(stats, { attempted: false, requested: 0, filled: 0 }, 'never rejects to the caller');
  assert.equal(ref.status, 'failed', 'a DB write fault leaves the bucket retryable for the next pass');
  assert.ok(calls.health.some((c) => c[0] === 'success'), 'the upstream 200 proved the session works');
  assert.ok(!calls.health.some((c) => c[0] === 'failure'), 'a DB-only failure must NOT degrade session health');
  assert.ok(calls.logs.some((l) => l.event === 'tg_post_media_persist_failed' && l.meta.error === 'write_failed'));
  assert.equal(JSON.stringify(calls.logs).includes('db down'), false, 'raw DB error text is never logged');
});

test('repairCentralMedia: an auth failure completes the bucket (no hot retry) and records reauth_required', async () => {
  const { runJobOnce, ref } = statusTrackingRunJobOnce();
  const { job, calls } = makeMediaJob({ runJobOnce, responses: { '/qr/media': authErr() } });

  await assert.doesNotReject(job.repairCentralMedia());
  assert.equal(ref.status, 'succeeded', 'an unusable session is not reclaimed every 15 min — the bucket completes');
  const fail = calls.health.find((c) => c[0] === 'failure');
  assert.deepEqual(fail[2], { state: 'reauth_required', errorCode: 'session_unauthorized' });
});
