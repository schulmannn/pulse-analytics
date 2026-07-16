'use strict';

// Unit-тесты reportScheduleJob: durable at-most-once резервация периода + классификация исхода
// провайдера. Фейковый db/sendEmailDetailed/now → детерминизм без сети и Postgres. Проверяем:
// резервация душит второй send в том же периоде; sent маркирует last_sent; провал markReportSent
// не вызывает resend; ambiguous держит резервацию без маркировки; 429 чистит резервацию и падает
// только если clear успешен; permanent-rejection держит резервацию и терминален; стабильный
// provider-ключ из внутренних id.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReportScheduleJob } = require('../server/jobs/reportScheduleJob');

const FIXED = () => new Date(Date.UTC(2026, 6, 1, 12));   // 2026-07-01 → monthly due (isFirst), period '2026-07'
const PERIOD = '2026-07';
const PROVIDER_KEY = 'report-email/42/2026-07';
const REPORT = { id: 42, uid: 7, name: 'Отчёт', email: 'u@x.io', schedule: 'monthly', config: {}, last_sent_at: null };

function makeDb(overrides = {}) {
  const state = { reservations: new Map(), marked: [], jobs: [] };
  const db = {
    enabled: true,
    listDueReports: async () => overrides.due || [REPORT],
    getUserById: async (uid) => (overrides.userExists === false ? null : { id: uid }),
    listChannels: async () => [],
    reserveReportDelivery: async (id, period) => {
      if (overrides.reserveReturns != null) return overrides.reserveReturns;
      if (state.reservations.get(id) === period) return false;    // exact period already reserved
      state.reservations.set(id, period);
      return true;
    },
    clearReportDelivery: async (id, period) => {
      if (overrides.clearThrows) throw new Error('clear db down');
      if (overrides.clearReturns != null) return overrides.clearReturns;
      if (state.reservations.get(id) === period) { state.reservations.delete(id); return true; }
      return false;
    },
    markReportSent: async (id) => {
      if (overrides.markThrows) throw new Error('db down after send');
      state.marked.push(id);
      return true;
    },
    runJobOnce: async (kind, key, fn) => {
      try { const result = await fn(); state.jobs.push({ key, result }); return { skipped: false, result }; }
      catch (e) { state.jobs.push({ key, error: e.message }); throw e; }
    },
  };
  return { db, state };
}

function makeJob(dbBundle, { sendResult, sendResults } = {}) {
  const sends = [];
  const logs = [];
  let i = 0;
  const job = createReportScheduleJob({
    db: dbBundle.db,
    log: (level, event, meta) => logs.push({ level, event, meta }),
    sendEmailDetailed: async (to, subject, html, opts) => {
      sends.push({ to, subject, html, opts });
      if (sendResults) { const r = sendResults[i] !== undefined ? sendResults[i] : sendResults[sendResults.length - 1]; i += 1; return r; }
      return sendResult || { outcome: 'sent', providerId: 'ok' };
    },
    emailShell: (t, b) => `<shell>${t}${b}</shell>`,
    emailBtn: (h, l) => `<a href="${h}">${l}</a>`,
    escHtml: (s) => String(s),
    emailConfigured: () => true,
    now: FIXED,
  });
  return { job, sends, logs };
}

// ── sent: маркирует last_sent, держит резервацию, стабильный provider-ключ ──────────────────────────
test('sent → markReportSent, резервация держится, provider-ключ из внутренних id', async () => {
  const bundle = makeDb();
  const { job, sends } = makeJob(bundle, { sendResult: { outcome: 'sent', providerId: 'resend-1' } });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].opts.idempotencyKey, PROVIDER_KEY);
  assert.ok(sends[0].opts.idempotencyKey.length <= 256);
  assert.deepEqual(bundle.state.marked, [42]);
  assert.equal(bundle.state.reservations.get(42), PERIOD);   // резервация НЕ снята
});

// ── резервация душит второй send в том же периоде ──────────────────────────────────────────────────
test('reserve=false (период уже зарезервирован) → второй send подавлен, без mark', async () => {
  const bundle = makeDb({ reserveReturns: false });
  const { job, sends, logs } = makeJob(bundle);
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(sends.length, 0);
  assert.deepEqual(bundle.state.marked, []);
  assert.ok(logs.some((l) => l.event === 'report_email_period_reserved'));
});

// ── провал markReportSent после подтверждённой отправки НЕ вызывает resend ──────────────────────────
test('markReportSent бросает после sent → терминальный успех, без resend', async () => {
  const bundle = makeDb({ markThrows: true });
  const { job, sends, logs } = makeJob(bundle, { sendResult: { outcome: 'sent', providerId: 'x' } });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(sends.length, 1);                             // отправлено ровно один раз
  const jobRow = bundle.state.jobs[0];
  assert.equal(jobRow.error, undefined);                     // job НЕ упал → следующий тик не переретраит
  assert.equal(jobRow.result.sent, true);
  assert.equal(bundle.state.reservations.get(42), PERIOD);   // резервация держится
  assert.ok(logs.some((l) => l.event === 'report_email_mark_failed'));
});

// ── ambiguous: держит резервацию, без mark, терминальный успех ───────────────────────────────────────
test('ambiguous → резервация держится, без mark, job не падает', async () => {
  const bundle = makeDb();
  const { job, logs } = makeJob(bundle, { sendResult: { outcome: 'ambiguous', reason: 'network' } });
  await job.processReportSchedules('https://atlavue.app');
  assert.deepEqual(bundle.state.marked, []);
  assert.equal(bundle.state.reservations.get(42), PERIOD);
  assert.equal(bundle.state.jobs[0].error, undefined);       // терминальный успех, не failed
  assert.equal(bundle.state.jobs[0].result.ambiguous, true);
  assert.ok(logs.some((l) => l.event === 'report_email_ambiguous'));
});

// ── 429 retryable: чистит резервацию и падает ТОЛЬКО если clear успешен ──────────────────────────────
test('retryable(429) + clear успешен → резервация снята, job падает (ретрай на следующем тике)', async () => {
  const bundle = makeDb();
  const { job, logs } = makeJob(bundle, { sendResult: { outcome: 'retryable', status: 429 } });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(bundle.state.reservations.has(42), false);    // резервация снята для чистого ретрая
  assert.match(bundle.state.jobs[0].error, /rate-limited/);  // job → failed
  assert.deepEqual(bundle.state.marked, []);
  assert.ok(logs.some((l) => l.event === 'report_email_failed'));
});

test('retryable(429) + clear провалился → fail closed (терминал, без throw, без resend)', async () => {
  const bundle = makeDb({ clearReturns: false });
  const { job, sends, logs } = makeJob(bundle, { sendResult: { outcome: 'retryable', status: 429 } });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(sends.length, 1);
  assert.equal(bundle.state.jobs[0].error, undefined);       // НЕ падает → не будет resend
  assert.equal(bundle.state.jobs[0].result.retryableLocked, true);
  assert.ok(logs.some((l) => l.event === 'report_email_reserve_clear_failed'));
});

test('retryable(429) + clear бросает → явный fail closed (терминал, без resend)', async () => {
  const bundle = makeDb({ clearThrows: true });
  const { job, sends, logs } = makeJob(bundle, { sendResult: { outcome: 'retryable', status: 429 } });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(sends.length, 1);
  assert.equal(bundle.state.jobs[0].error, undefined);
  assert.equal(bundle.state.jobs[0].result.retryableLocked, true);
  assert.ok(logs.some((l) => l.event === 'report_email_reserve_clear_failed'));
});

// ── permanent rejected: держит резервацию, терминал, без mark ─────────────────────────────────────────
test('rejected → резервация держится, терминал, без mark', async () => {
  const bundle = makeDb();
  const { job, logs } = makeJob(bundle, { sendResult: { outcome: 'rejected', status: 422, name: 'validation_error' } });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(bundle.state.reservations.get(42), PERIOD);
  assert.deepEqual(bundle.state.marked, []);
  assert.equal(bundle.state.jobs[0].error, undefined);
  assert.equal(bundle.state.jobs[0].result.rejected, true);
  assert.ok(logs.some((l) => l.event === 'report_email_rejected'));
});

// ── GDPR-гонка: стёртый юзер → без резервации и без отправки ───────────────────────────────────────
test('стёртый юзер (getUserById=null) → без reserve, без send', async () => {
  const bundle = makeDb({ userExists: false });
  const { job, sends } = makeJob(bundle);
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(sends.length, 0);
  assert.equal(bundle.state.reservations.size, 0);
});

// ── bounded per-report concurrency + pass-scoped 429 pause ──────────────────────────────────────────
// A multi-report due list dispatched under bounded concurrency (default/cap 2). Asserts: max in-flight
// never exceeds the configured concurrency; with no throttle every report is handled; a CONFIRMED
// (cleared) 429 pauses the pass so no NEW report starts — only the already-in-flight peer finishes.

const monthlyReports = (...ids) =>
  ids.map((id) => ({ id, uid: id, name: `R${id}`, email: `u${id}@x.io`, schedule: 'monthly', config: {}, last_sent_at: null }));

// Build a job whose fake db supports many reports and a per-report send impl; dispatchConcurrency is
// injected so the bounded loop is exercised directly.
function makeConcurrentJob({ due, sendImpl, dispatchConcurrency = 2 }) {
  const state = { reservations: new Map(), marked: [], sends: [] };
  const db = {
    enabled: true,
    listDueReports: async () => due,
    getUserById: async (uid) => ({ id: uid }),
    listChannels: async () => [],
    reserveReportDelivery: async (id, period) => {
      if (state.reservations.get(id) === period) return false;
      state.reservations.set(id, period);
      return true;
    },
    clearReportDelivery: async (id, period) => {
      if (state.reservations.get(id) === period) { state.reservations.delete(id); return true; }
      return false;
    },
    markReportSent: async (id) => { state.marked.push(id); return true; },
    runJobOnce: async (_kind, _key, fn) => {
      try { const result = await fn(); return { skipped: false, result }; }
      catch (e) { throw e; }
    },
  };
  const job = createReportScheduleJob({
    db,
    log: () => {},
    sendEmailDetailed: async (to, subject, html, opts) => {
      const id = Number(opts.idempotencyKey.split('/')[1]);
      state.sends.push(id);
      return sendImpl(id);
    },
    emailShell: (t, b) => `<shell>${t}${b}</shell>`,
    emailBtn: (h, l) => `<a href="${h}">${l}</a>`,
    escHtml: (s) => String(s),
    emailConfigured: () => true,
    now: FIXED,
    dispatchConcurrency,
  });
  return { job, state };
}

test('bounded concurrency: max in-flight ≤ 2, все отчёты разосланы без throttle', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { job, state } = makeConcurrentJob({
    due: monthlyReports(1, 2, 3, 4, 5, 6),
    sendImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { outcome: 'sent', providerId: 'ok' };
    },
  });
  const stats = await job.processReportSchedules('https://atlavue.app');
  assert.ok(maxInFlight <= 2, `не более 2 одновременных отправок (было ${maxInFlight})`);
  assert.ok(maxInFlight >= 2, 'параллелизм реально задействован (не сериализовано в 1)');
  assert.equal(state.sends.length, 6, 'все 6 отчётов отправлены');
  assert.deepEqual(state.marked.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(stats.sent, 6);
  assert.equal(stats.paused, false, 'без 429 пауза не ставится');
  assert.equal(stats.skippedPaused, 0);
});

test('confirmed 429 (clear успешен) ставит pass-scoped паузу: новые отчёты не стартуют, только in-flight peer завершается', async () => {
  // Отчёт 1 (индекс 0) получает 429; отчёты 2..6 гейтятся барьером, чтобы peer-раннер оставался
  // in-flight, пока отчёт 1 ставит паузу. concurrency=2 ⇒ стартуют ровно отчёты 1 и 2.
  let releaseBarrier;
  const barrier = new Promise((r) => { releaseBarrier = r; });
  const { job, state } = makeConcurrentJob({
    due: monthlyReports(1, 2, 3, 4, 5, 6),
    sendImpl: async (id) => {
      if (id === 1) return { outcome: 'retryable', status: 429 };   // known-not-sent → clear → пауза
      await barrier;   // peer (отчёт 2) остаётся in-flight, пока не отпустим
      return { outcome: 'sent', providerId: 'ok' };
    },
  });
  const pass = job.processReportSchedules('https://atlavue.app');
  // Даём отчёту 1 разрешиться и поставить паузу; раннер-A успевает пройтись по 3..6 как skipped.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  releaseBarrier();
  const stats = await pass;

  assert.ok(state.sends.includes(1), 'отчёт 1 дошёл до провайдера (получил 429)');
  assert.ok(state.sends.includes(2), 'in-flight peer (отчёт 2) завершил отправку');
  for (const id of [3, 4, 5, 6]) {
    assert.equal(state.sends.includes(id), false, `отчёт ${id} НЕ стартовал после паузы`);
  }
  assert.deepEqual(state.marked, [2], 'помечен отправленным только завершившийся peer');
  assert.equal(stats.paused, true, 'пауза зафиксирована в stats');
  assert.equal(stats.skippedPaused, 4, 'четыре очередных отчёта пропущены паузой');
  assert.equal(state.reservations.has(1), false, 'резервация отчёта 1 снята для чистого ретрая');
});

test('изолированный per-report сбой (не 429) НЕ ставит паузу — остальные отчёты продолжают', async () => {
  const { job, state } = makeConcurrentJob({
    due: monthlyReports(1, 2, 3, 4),
    sendImpl: async (id) => {
      if (id === 1) return { outcome: 'rejected', status: 422, name: 'validation_error' };   // permanent, не пауза
      return { outcome: 'sent', providerId: 'ok' };
    },
  });
  const stats = await job.processReportSchedules('https://atlavue.app');
  assert.deepEqual(state.sends.sort((a, b) => a - b), [1, 2, 3, 4], 'все отчёты обработаны');
  assert.deepEqual(state.marked.sort((a, b) => a - b), [2, 3, 4], 'отправлены все, кроме перманентно отклонённого');
  assert.equal(stats.paused, false, 'permanent-rejection не ставит паузу');
  assert.equal(stats.skippedPaused, 0);
});

test('429 с проваленным clear — fail closed, паузы НЕТ (не стопорим остальные)', async () => {
  // clearReportDelivery всегда проваливается → терминал без throw и без паузы (fail closed): отчёт 1
  // остаётся зарезервированным, остальные отчёты продолжают рассылаться.
  const state2 = { reservations: new Map(), marked: [], sends: [] };
  const db2 = {
    enabled: true,
    listDueReports: async () => monthlyReports(1, 2, 3),
    getUserById: async (uid) => ({ id: uid }),
    listChannels: async () => [],
    reserveReportDelivery: async (id, period) => { state2.reservations.set(id, period); return true; },
    clearReportDelivery: async () => false,   // clear всегда проваливается → fail closed
    markReportSent: async (id) => { state2.marked.push(id); return true; },
    runJobOnce: async (_k, _key, fn) => { const result = await fn(); return { skipped: false, result }; },
  };
  const job2 = createReportScheduleJob({
    db: db2, log: () => {},
    sendEmailDetailed: async (to, subject, html, opts) => {
      const id = Number(opts.idempotencyKey.split('/')[1]);
      state2.sends.push(id);
      return id === 1 ? { outcome: 'retryable', status: 429 } : { outcome: 'sent' };
    },
    emailShell: (t, b) => `${t}${b}`, emailBtn: (h, l) => `${h}${l}`, escHtml: (s) => String(s),
    emailConfigured: () => true, now: FIXED, dispatchConcurrency: 2,
  });
  const stats = await job2.processReportSchedules('https://atlavue.app');
  assert.deepEqual(state2.sends.sort((a, b) => a - b), [1, 2, 3], 'все отчёты обработаны — паузы нет');
  assert.equal(stats.paused, false, 'проваленный clear = fail closed, но НЕ пауза');
  // отчёт 1 остаётся зарезервированным (не отдали) и НЕ помечен отправленным.
  assert.equal(state2.reservations.has(1), true);
  assert.equal(state2.marked.includes(1), false);
});

// ── email не сконфигурирован → ранний выход, без запросов ──────────────────────────────────────────
test('emailConfigured=false → schedule пропущен, listDueReports не зовётся', async () => {
  const bundle = makeDb();
  let dueCalled = false;
  bundle.db.listDueReports = async () => { dueCalled = true; return [REPORT]; };
  const job = createReportScheduleJob({
    db: bundle.db, log: () => {}, sendEmailDetailed: async () => ({ outcome: 'sent' }),
    emailShell: () => '', emailBtn: () => '', escHtml: (s) => s, emailConfigured: () => false, now: FIXED,
  });
  await job.processReportSchedules('https://atlavue.app');
  assert.equal(dueCalled, false);
});
