'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIntervalRunner } = require('../server/infrastructure/intervalRunner');

/**
 * Жизненный цикл фонового бегунка (аудит #554): раньше он был скопирован побайтово в
 * `operationalRunner` и `collectionRecoveryRunner`, и правка в одном молча оставляла второй на
 * старом поведении. Теперь он один — и тем важнее пришпилить его контракт здесь, а не только
 * через два вызывающих.
 */

/** Трекер, который просто выполняет проход; `drain` заставляет его отклонять новую работу. */
function fakeTracker({ drain = false } = {}) {
  const jobs = [];
  return {
    jobs,
    async run(fn, opts) {
      jobs.push(opts && opts.job);
      if (drain) return { accepted: false };
      await fn();
      return { accepted: true };
    },
  };
}

/** Ручные таймеры: тик выполняется тогда, когда его позовёт тест. */
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeoutFn(fn, delay) {
      const handle = { fn, delay, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
      pending.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      if (!handle) return;
      handle.cleared = true;
      // Погашенный таймер выбывает из очереди — иначе «сколько запланировано» считает и мёртвые.
      const at = pending.indexOf(handle);
      if (at >= 0) pending.splice(at, 1);
    },
    async fire() {
      const next = pending.shift();
      assert.ok(next, 'ожидался запланированный тик');
      await next.fn();
      return next;
    },
  };
}

test('проход уходит в трекер под своей меткой, а результат — не «пропущено»', async () => {
  const jobTracker = fakeTracker();
  let passes = 0;
  const runner = createIntervalRunner({
    jobTracker,
    job: 'demo_pass',
    pass: async () => { passes += 1; },
    intervalMs: 1000,
    initialDelayMs: 10,
  });
  assert.deepEqual(await runner.runOnce(), { skipped: false });
  assert.equal(passes, 1);
  assert.deepEqual(jobTracker.jobs, ['demo_pass']);
});

test('single-flight: перекрывающийся вызов выходит сразу и работу не удваивает', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let passes = 0;
  const runner = createIntervalRunner({
    jobTracker: fakeTracker(),
    job: 'demo_pass',
    pass: async () => { passes += 1; await gate; },
    intervalMs: 1000,
    initialDelayMs: 10,
  });
  const first = runner.runOnce();
  assert.equal(runner.isRunning, true);
  assert.deepEqual(await runner.runOnce(), { skipped: true }, 'второй вызов обязан пропуститься');
  release();
  await first;
  assert.equal(passes, 1);
  assert.equal(runner.isRunning, false);
});

test('дренаж трекера: проход не выполняется и честно возвращает «пропущено»', async () => {
  let passes = 0;
  const runner = createIntervalRunner({
    jobTracker: fakeTracker({ drain: true }),
    job: 'demo_pass',
    pass: async () => { passes += 1; },
    intervalMs: 1000,
    initialDelayMs: 10,
  });
  assert.deepEqual(await runner.runOnce(), { skipped: true });
  assert.equal(passes, 0);
});

test('start планирует первый проход отложенно и перепланирует следующий интервалом', async () => {
  const timers = fakeTimers();
  const runner = createIntervalRunner({
    jobTracker: fakeTracker(),
    job: 'demo_pass',
    pass: async () => {},
    intervalMs: 1000,
    initialDelayMs: 10,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  runner.start();
  runner.start(); // идемпотентен: второй старт не плодит таймеров
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delay, 10, 'первый проход — через initialDelay');
  // Таймер не держит event loop: без unref процесс не завершился бы сам.
  assert.equal(timers.pending[0].unrefed, true);

  await timers.fire();
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delay, 1000, 'дальше — с интервалом');
});

test('stop гасит таймер, идемпотентен и не даёт перепланировать после тика', async () => {
  const timers = fakeTimers();
  let passes = 0;
  const runner = createIntervalRunner({
    jobTracker: fakeTracker(),
    job: 'demo_pass',
    pass: async () => { passes += 1; },
    intervalMs: 1000,
    initialDelayMs: 10,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  runner.start();
  const scheduled = timers.pending[0];
  runner.stop();
  runner.stop();
  assert.equal(scheduled.cleared, true);
  assert.equal(runner.isStopped, true);
  assert.deepEqual(await runner.runOnce(), { skipped: true }, 'после stop проходов больше нет');
  assert.equal(passes, 0);
  runner.start();
  assert.equal(timers.pending.length, 0, 'start после stop ничего не планирует');
});

test('enabled=false: ни планирования, ни ручного прохода', async () => {
  const timers = fakeTimers();
  let passes = 0;
  const runner = createIntervalRunner({
    jobTracker: fakeTracker(),
    job: 'demo_pass',
    pass: async () => { passes += 1; },
    intervalMs: 1000,
    initialDelayMs: 10,
    enabled: false,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  runner.start();
  assert.equal(timers.pending.length, 0);
  assert.deepEqual(await runner.runOnce(), { skipped: true });
  assert.equal(passes, 0);
});
