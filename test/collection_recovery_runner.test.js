'use strict';

// Focused unit tests for the in-process collection recovery runner. Deterministic timers are
// injected (a tiny scheduler), jobTracker is the real one, and the IG/TG passes are fakes. Covers:
// initial-delay + interval scheduling, in-process single-flight (no overlap), work submitted through
// jobTracker (shutdown tracks it), unref on timers, DB-disabled inertness, and stop()/drain behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollectionRecoveryRunner } = require('../server/infrastructure/collectionRecoveryRunner');
const { createJobTracker } = require('../server/infrastructure/jobTracker');

// Minimal controllable clock: setTimeoutFn records {delay, fn}; fireNext() runs the earliest pending
// timer. unref() is recorded so we can assert timers are unref'd (don't hold the event loop).
function makeClock() {
  let seq = 0;
  const timers = new Map();
  let unrefCount = 0;
  const setTimeoutFn = (fn, delay) => {
    const id = ++seq;
    const handle = { id, unref() { unrefCount++; return handle; } };
    timers.set(id, { fn, delay, handle });
    return handle;
  };
  const clearTimeoutFn = (handle) => { if (handle) timers.delete(handle.id); };
  async function fireNext() {
    const [id, entry] = [...timers.entries()][0];
    timers.delete(id);
    await entry.fn();
  }
  return {
    setTimeoutFn,
    clearTimeoutFn,
    fireNext,
    get pending() { return timers.size; },
    get lastDelay() { return [...timers.values()].map((t) => t.delay).at(-1); },
    get unrefCount() { return unrefCount; },
  };
}

function makeRunner(over = {}) {
  const clock = makeClock();
  const jobTracker = over.jobTracker || createJobTracker();
  const igCalls = [];
  const tgCalls = [];
  const runner = createCollectionRecoveryRunner({
    log: () => {},
    jobTracker,
    runIgCollectionPass: over.runIgCollectionPass || (async ({ cap }) => { igCalls.push(cap); return { started: 0 }; }),
    processTgQrCollection: over.processTgQrCollection || (async ({ cap }) => { tgCalls.push(cap); return { collected: 0 }; }),
    igCap: 25,
    tgCap: 200,
    initialDelayMs: 1000,
    intervalMs: 5000,
    enabled: over.enabled !== false,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { runner, clock, jobTracker, igCalls, tgCalls };
}

test('start(): планирует первый проход через initialDelay, unref-таймер', () => {
  const { runner, clock } = makeRunner();
  runner.start();
  assert.equal(clock.pending, 1);
  assert.equal(clock.lastDelay, 1000, 'первый проход отложен на initialDelay');
  assert.equal(clock.unrefCount, 1, 'таймер unref (не держит event loop)');
});

test('проход зовёт IG + TG с инъектированными cap и перепланирует на interval', async () => {
  const { runner, clock, igCalls, tgCalls } = makeRunner();
  runner.start();
  await clock.fireNext();
  assert.deepEqual(igCalls, [25]);
  assert.deepEqual(tgCalls, [200]);
  assert.equal(clock.pending, 1, 'после прохода запланирован следующий');
  assert.equal(clock.lastDelay, 5000, 'повтор через interval');
});

test('single-flight: перекрывающийся вызов прохода пропускается, пока предыдущий ещё бежит', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let igRuns = 0;
  const { runner } = makeRunner({
    runIgCollectionPass: async () => { igRuns++; await gate; return {}; },
  });
  const first = runner.runOnce();              // стартует проход 1, зависает на gate
  await Promise.resolve();
  assert.equal(runner.isRunning, true);
  const overlap = await runner.runOnce();      // гонка: второй вызов, пока первый бежит
  assert.deepEqual(overlap, { skipped: true }, 'перекрывающийся проход пропущен');
  assert.equal(igRuns, 1, 'работа не удвоена');
  release();
  assert.deepEqual(await first, { skipped: false });
  assert.equal(runner.isRunning, false);
});

test('IG и TG pipelines стартуют независимо, ни одна не ждёт завершения другой', async () => {
  let releaseIg;
  const igGate = new Promise((resolve) => { releaseIg = resolve; });
  let igStarted = false;
  let tgStarted = false;
  const { runner } = makeRunner({
    runIgCollectionPass: async () => { igStarted = true; await igGate; return {}; },
    processTgQrCollection: async () => { tgStarted = true; return {}; },
  });
  const pass = runner.runOnce();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(igStarted, true);
  assert.equal(tgStarted, true, 'TG получает прогресс, пока длинный IG-проход ещё выполняется');
  releaseIg();
  await pass;
});

test('работа сабмитится через jobTracker → shutdown её дожидается', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const jobTracker = createJobTracker();
  const { runner, clock } = makeRunner({
    jobTracker,
    runIgCollectionPass: async () => { await gate; return {}; },
  });
  runner.start();
  const tick = clock.fireNext();
  await Promise.resolve();
  assert.equal(jobTracker.activeCount, 1, 'проход зарегистрирован в jobTracker');
  release();
  await tick;
  assert.equal(jobTracker.activeCount, 0);
});

test('stop(): гасит таймер, новые проходы не планируются', async () => {
  const { runner, clock, igCalls } = makeRunner();
  runner.start();
  assert.equal(clock.pending, 1);
  runner.stop();
  assert.equal(clock.pending, 0, 'таймер очищен');
  assert.equal(runner.isStopped, true);
  // Повторный start после stop не оживляет бегунок.
  runner.start();
  assert.equal(clock.pending, 0);
  assert.deepEqual(igCalls, []);
});

test('во время дренажа jobTracker проход не выполняется (работа отклонена)', async () => {
  const jobTracker = createJobTracker();
  const { runner, clock, igCalls } = makeRunner({ jobTracker });
  runner.start();
  jobTracker.beginDrain();      // дренаж начался ДО того, как таймер выстрелил
  await clock.fireNext();
  assert.deepEqual(igCalls, [], 'jobTracker отклонил проход во время дренажа');
});

test('enabled=false (DB-less): start() инертен', () => {
  const { runner, clock } = makeRunner({ enabled: false });
  runner.start();
  assert.equal(clock.pending, 0, 'в DB-less режиме бегунок не планирует проходов');
});

test('enabled=false и stop(): ручной runOnce также не обходит lifecycle gate', async () => {
  const disabled = makeRunner({ enabled: false });
  assert.deepEqual(await disabled.runner.runOnce(), { skipped: true });
  assert.deepEqual(disabled.igCalls, []);
  assert.deepEqual(disabled.tgCalls, []);

  const stopped = makeRunner();
  stopped.runner.stop();
  assert.deepEqual(await stopped.runner.runOnce(), { skipped: true });
  assert.deepEqual(stopped.igCalls, []);
  assert.deepEqual(stopped.tgCalls, []);
});

test('stop() до первого выстрела предотвращает перепланирование внутри tick', async () => {
  const { runner, clock } = makeRunner();
  runner.start();
  // Останавливаем — таймер очищен; выстрелить уже нечему.
  runner.stop();
  assert.equal(clock.pending, 0);
});
