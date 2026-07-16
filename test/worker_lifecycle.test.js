'use strict';

// Focused lifecycle tests for the standalone recovery worker (server/worker.js). No real Postgres,
// no HTTP: a fake composition records lifecycle events and injectable timers/exit keep the test runner
// safe. Covers: worker-mode gate (refuses inline/external), DB-disabled/unreachable refusal (fails
// clearly instead of idling), boot→ping→start ordering, ref'd keepalive, shutdown ordering
// (stop scheduling → clear keepalive → drain → cache stop → close pools), distinct-pool dedupe, and
// the fatal-fault drain-once/exit(1) path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorker } = require('../server/worker');
const { createJobTracker } = require('../server/infrastructure/jobTracker');

const WORKER_ENV = { NODE_ENV: 'test', COLLECTION_RECOVERY_MODE: 'worker' };

// Fake composition: each pool records ping/close; the runner, cache and jobTracker record their
// lifecycle calls so ordering can be asserted. `pools` lets a test inject shared/distinct pools.
function makeWorkerComposition({ enabled = true, pools } = {}) {
  const events = [];
  const mkPool = (label) => ({
    enabled,
    async ping() { events.push(`ping:${label}`); return { ok: true }; },
    async close() { events.push(`close:${label}`); },
  });
  const list = pools || [mkPool('a')];
  const tracker = createJobTracker();
  const composition = {
    databases: list,
    db: list[0],
    backgroundDb: list[1] || list[0],
    drainState: { draining: false },
    async boot() { events.push('boot'); },
    collectionRunner: {
      start() { events.push('runner.start'); },
      stop() { events.push('runner.stop'); },
    },
    jobTracker: {
      run: tracker.run,
      get activeCount() { return tracker.activeCount; },
      beginDrain() { events.push('drain.begin'); tracker.beginDrain(); },
      waitForIdle(opts) { events.push('drain.wait'); return tracker.waitForIdle(opts); },
    },
    memoryCache: {
      start() { events.push('cache.start'); },
      stop() { events.push('cache.stop'); },
    },
  };
  return { composition, events, tracker };
}

// Records timer creation and clears; keepalive must NOT be unref'd (it holds the event loop).
function makeIntervals(events) {
  const created = [];
  const setIntervalFn = (fn, ms) => {
    const handle = { fn, ms, unrefed: false, unref() { handle.unrefed = true; return handle; } };
    created.push(handle);
    return handle;
  };
  const clearIntervalFn = (handle) => { events.push('keepalive.clear'); handle && (handle.cleared = true); };
  return { created, setIntervalFn, clearIntervalFn };
}

test('worker refuses any non-worker mode before building composition', async () => {
  for (const env of [{ NODE_ENV: 'test' }, { ...WORKER_ENV, COLLECTION_RECOVERY_MODE: 'inline' }, { ...WORKER_ENV, COLLECTION_RECOVERY_MODE: 'external' }]) {
    let built = false;
    await assert.rejects(
      runWorker({ env, compositionFactory: () => { built = true; return {}; }, installSignalHandlers: false }),
      /worker/i,
    );
    assert.equal(built, false, `composition не строится для режима ${env.COLLECTION_RECOVERY_MODE || 'inline(default)'}`);
  }
});

test('worker refuses to run when the DB is disabled (no silent idle)', async () => {
  const { composition, events } = makeWorkerComposition({ enabled: false });
  await assert.rejects(
    runWorker({ env: WORKER_ENV, compositionFactory: () => composition, installSignalHandlers: false }),
    /включённую БД/i,
  );
  assert.equal(events.includes('boot'), false, 'boot не запускается при выключенной БД');
  assert.ok(events.includes('close:a'), 'пул очищается при отказе');
});

test('worker fails clearly when the DB is unreachable at boot', async () => {
  const { composition, events } = makeWorkerComposition();
  composition.databases[0].ping = async () => { throw new Error('connection refused'); };
  await assert.rejects(
    runWorker({ env: WORKER_ENV, compositionFactory: () => composition, installSignalHandlers: false }),
    /недостижима/i,
  );
  assert.ok(events.includes('boot'), 'boot попытан');
  assert.ok(events.includes('close:a'), 'пул закрыт при недостижимой БД');
});

test('worker boots, starts the runner behind a ref keepalive, no HTTP', async () => {
  const { composition, events } = makeWorkerComposition();
  const { created, setIntervalFn, clearIntervalFn } = makeIntervals(events);
  const runtime = await runWorker({
    env: WORKER_ENV,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
    setIntervalFn,
    clearIntervalFn,
  });

  assert.equal(runtime.server, undefined, 'worker не поднимает HTTP-listener');
  assert.deepEqual(
    events.filter((e) => ['boot', 'ping:a', 'runner.start', 'cache.start'].includes(e)),
    ['boot', 'ping:a', 'runner.start'],
    'boot → ping → start; кэш-свип НЕ запускается (нет HTTP)',
  );
  assert.equal(created.length, 1, 'ровно один keepalive-таймер');
  assert.equal(created[0].unrefed, false, 'keepalive НЕ unref — держит event loop живым');

  await runtime.stop();
});

test('worker shutdown order: stop scheduling → clear keepalive → drain → cache → close pools (idempotent)', async () => {
  const { composition, events } = makeWorkerComposition();
  const { setIntervalFn, clearIntervalFn } = makeIntervals(events);
  const runtime = await runWorker({
    env: WORKER_ENV,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
    setIntervalFn,
    clearIntervalFn,
  });

  // An in-flight tracked pass must be awaited by the drain before pools close.
  let finishTail;
  runtime.composition.jobTracker.run(() => new Promise((resolve) => { finishTail = resolve; }));
  await Promise.resolve();

  const stopping = runtime.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('close:a'), false, 'пул не закрыт, пока проход не дренирован');
  finishTail();
  await stopping;

  const order = events.filter((e) =>
    ['runner.stop', 'keepalive.clear', 'drain.begin', 'drain.wait', 'cache.stop', 'close:a'].includes(e),
  );
  assert.deepEqual(order, ['runner.stop', 'keepalive.clear', 'drain.begin', 'drain.wait', 'cache.stop', 'close:a']);
  assert.equal(composition.drainState.draining, true);

  await runtime.stop(); // идемпотентность
  assert.equal(events.filter((e) => e === 'close:a').length, 1, 'пул закрыт ровно один раз');
});

test('worker closes each distinct pool once and dedupes a shared pool reference', async () => {
  // Distinct main+background pools → two closes.
  const distinct = makeWorkerComposition({
    pools: [
      { enabled: true, async ping() {}, async close() { distinct.events.push('close:main'); } },
      { enabled: true, async ping() {}, async close() { distinct.events.push('close:bg'); } },
    ],
  });
  const distinctTimers = makeIntervals(distinct.events);
  const r1 = await runWorker({
    env: WORKER_ENV, compositionFactory: () => distinct.composition, installSignalHandlers: false,
    shutdownTimeoutMs: 1_000, setIntervalFn: distinctTimers.setIntervalFn, clearIntervalFn: distinctTimers.clearIntervalFn,
  });
  await r1.stop();
  assert.equal(distinct.events.filter((e) => e === 'close:main').length, 1);
  assert.equal(distinct.events.filter((e) => e === 'close:bg').length, 1);

  // Same pool object under both slots (backgroundDb === db) → closed exactly once.
  let sharedPings = 0;
  const shared = {
    enabled: true,
    async ping() { sharedPings += 1; },
    async close() { sharedComp.events.push('close:shared'); },
  };
  const sharedComp = makeWorkerComposition({ pools: [shared, shared] });
  const sharedTimers = makeIntervals(sharedComp.events);
  const r2 = await runWorker({
    env: WORKER_ENV, compositionFactory: () => sharedComp.composition, installSignalHandlers: false,
    shutdownTimeoutMs: 1_000, setIntervalFn: sharedTimers.setIntervalFn, clearIntervalFn: sharedTimers.clearIntervalFn,
  });
  await r2.stop();
  assert.equal(sharedPings, 1, 'общий пул проверен ровно один раз');
  assert.equal(sharedComp.events.filter((e) => e === 'close:shared').length, 1, 'общий пул закрыт ровно один раз');
});

test('worker fatal fault drains once and exits 1 (single-flight)', async () => {
  const { composition, events } = makeWorkerComposition();
  const { setIntervalFn, clearIntervalFn } = makeIntervals(events);
  const exits = [];
  const runtime = await runWorker({
    env: WORKER_ENV,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
    setIntervalFn,
    clearIntervalFn,
    exit: (code) => exits.push(code),
  });

  const first = runtime.handleFatal('uncaughtException', new Error('boom'));
  const second = runtime.handleFatal('unhandledRejection', new Error('again'));
  assert.strictEqual(second, first, 'параллельные фатальные ошибки делят один дренаж');
  await first;

  assert.equal(process.exitCode, 1);
  assert.deepEqual(exits, [1], 'exit(1) ровно один раз');
  assert.ok(events.includes('close:a'), 'graceful stop() дошёл до закрытия пула');
  assert.equal(composition.drainState.draining, true);

  await runtime.handleFatal('uncaughtException', new Error('third'));
  assert.deepEqual(exits, [1], 'повторная фатальная ошибка — no-op (single-flight)');

  process.exitCode = 0; // не протекать провальным кодом в раннер
});

test('worker fatal forced-exit timer stays referenced and fires when drain hangs', async () => {
  const { composition, events } = makeWorkerComposition();
  const { setIntervalFn, clearIntervalFn } = makeIntervals(events);
  let finishClose;
  composition.databases[0].close = () => new Promise((resolve) => { finishClose = resolve; });
  const exits = [];
  const runtime = await runWorker({
    env: WORKER_ENV,
    compositionFactory: () => composition,
    installSignalHandlers: false,
    shutdownTimeoutMs: 1_000,
    fatalExitTimeoutMs: 30,
    setIntervalFn,
    clearIntervalFn,
    exit: (code) => exits.push(code),
  });

  const fatal = runtime.handleFatal('uncaughtException', new Error('stuck'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(exits, [1], 'ref-таймер гарантирует bounded exit даже после clear keepalive');

  finishClose();
  await fatal;
  assert.deepEqual(exits, [1], 'поздний drain не вызывает второй exit');
  process.exitCode = 0;
});
