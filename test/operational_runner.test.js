'use strict';

// Focused unit tests for the in-process operational runner (scheduled reports + daily maintenance).
// Deterministic timers are injected, jobTracker is the real one, and the two lanes are fakes. Covers:
// initial-delay + interval scheduling, canonical publicUrl passed to processReportSchedules, both
// lanes attempted when one throws (boundedAllSettled isolation), in-process single-flight, work
// submitted through jobTracker (shutdown tracks it), unref on timers, DB-disabled inertness, and
// stop()/drain behavior. Mirrors test/collection_recovery_runner.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationalRunner } = require('../server/infrastructure/operationalRunner');
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

const PUBLIC_URL = 'https://atlavue.app';

function makeRunner(over = {}) {
  const clock = makeClock();
  const jobTracker = over.jobTracker || createJobTracker();
  const reportBases = [];
  const maintCalls = [];
  const runner = createOperationalRunner({
    log: () => {},
    jobTracker,
    processReportSchedules: over.processReportSchedules || (async (base) => { reportBases.push(base); return { due: 0 }; }),
    runDailyMaintenanceOnce: over.runDailyMaintenanceOnce || (async () => { maintCalls.push(true); return { skipped: false }; }),
    publicUrl: over.publicUrl || PUBLIC_URL,
    initialDelayMs: 1000,
    intervalMs: 5000,
    enabled: over.enabled !== false,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { runner, clock, jobTracker, reportBases, maintCalls };
}

test('start(): планирует первый проход через initialDelay, unref-таймер', () => {
  const { runner, clock } = makeRunner();
  runner.start();
  assert.equal(clock.pending, 1);
  assert.equal(clock.lastDelay, 1000, 'первый проход отложен на initialDelay');
  assert.equal(clock.unrefCount, 1, 'таймер unref (не держит event loop)');
});

test('проход зовёт обе полосы и перепланирует на interval; отчётам передаётся канонический publicUrl', async () => {
  const { runner, clock, reportBases, maintCalls } = makeRunner();
  runner.start();
  await clock.fireNext();
  assert.deepEqual(reportBases, [PUBLIC_URL], 'processReportSchedules получает config.http.publicUrl как base');
  assert.deepEqual(maintCalls, [true], 'runDailyMaintenanceOnce вызван');
  assert.equal(clock.pending, 1, 'после прохода запланирован следующий');
  assert.equal(clock.lastDelay, 5000, 'повтор через interval');
});

test('обе полосы пытаются выполниться, даже если одна бросает (boundedAllSettled изоляция)', async () => {
  const maintCalls = [];
  const { runner, clock } = makeRunner({
    processReportSchedules: async () => { throw new Error('reports boom'); },
    runDailyMaintenanceOnce: async () => { maintCalls.push(true); return { skipped: false }; },
  });
  runner.start();
  await assert.doesNotReject(clock.fireNext());
  assert.deepEqual(maintCalls, [true], 'maintenance выполнена, несмотря на падение отчётной полосы');
  assert.equal(clock.pending, 1, 'следующий проход всё равно запланирован');
});

test('падение maintenance-полосы не мешает отчётной полосе', async () => {
  const reportBases = [];
  const { runner, clock } = makeRunner({
    processReportSchedules: async (base) => { reportBases.push(base); return {}; },
    runDailyMaintenanceOnce: async () => { throw new Error('maint boom'); },
  });
  runner.start();
  await assert.doesNotReject(clock.fireNext());
  assert.deepEqual(reportBases, [PUBLIC_URL], 'отчётная полоса отработала, несмотря на падение maintenance');
});

test('single-flight: перекрывающийся вызов прохода пропускается, пока предыдущий ещё бежит', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let repRuns = 0;
  const { runner } = makeRunner({
    processReportSchedules: async () => { repRuns++; await gate; return {}; },
  });
  const first = runner.runOnce();
  await Promise.resolve();
  assert.equal(runner.isRunning, true);
  const overlap = await runner.runOnce();
  assert.deepEqual(overlap, { skipped: true }, 'перекрывающийся проход пропущен');
  assert.equal(repRuns, 1, 'работа не удвоена');
  release();
  assert.deepEqual(await first, { skipped: false });
  assert.equal(runner.isRunning, false);
});

test('работа сабмитится через jobTracker → shutdown её дожидается', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const jobTracker = createJobTracker();
  const { runner, clock } = makeRunner({
    jobTracker,
    processReportSchedules: async () => { await gate; return {}; },
  });
  runner.start();
  const tick = clock.fireNext();
  await Promise.resolve();
  assert.equal(jobTracker.activeCount, 1, 'проход зарегистрирован в jobTracker');
  release();
  await tick;
  assert.equal(jobTracker.activeCount, 0);
});

test('во время дренажа jobTracker проход не выполняется (работа отклонена)', async () => {
  const jobTracker = createJobTracker();
  const { runner, clock, reportBases } = makeRunner({ jobTracker });
  runner.start();
  jobTracker.beginDrain();
  await clock.fireNext();
  assert.deepEqual(reportBases, [], 'jobTracker отклонил проход во время дренажа');
});

test('stop(): гасит таймер, новые проходы не планируются', async () => {
  const { runner, clock, reportBases } = makeRunner();
  runner.start();
  assert.equal(clock.pending, 1);
  runner.stop();
  assert.equal(clock.pending, 0, 'таймер очищен');
  assert.equal(runner.isStopped, true);
  runner.start();
  assert.equal(clock.pending, 0, 'повторный start после stop не оживляет бегунок');
  assert.deepEqual(reportBases, []);
});

test('enabled=false (DB-less): start() инертен и ручной runOnce обходит lifecycle gate', async () => {
  const disabled = makeRunner({ enabled: false });
  disabled.runner.start();
  assert.equal(disabled.clock.pending, 0, 'в DB-less режиме бегунок не планирует проходов');
  assert.deepEqual(await disabled.runner.runOnce(), { skipped: true });
  assert.deepEqual(disabled.reportBases, []);
  assert.deepEqual(disabled.maintCalls, []);

  const stopped = makeRunner();
  stopped.runner.stop();
  assert.deepEqual(await stopped.runner.runOnce(), { skipped: true });
  assert.deepEqual(stopped.reportBases, []);
});
