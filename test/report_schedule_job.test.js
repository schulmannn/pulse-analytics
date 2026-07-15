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
