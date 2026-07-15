'use strict';

// Unit-тесты emailService: детальная идемпотентная отправка отчётов (sendEmailDetailed) и сохранение
// legacy boolean/single-shot контракта sendEmail. fetch/sleep/now инъектируются → детерминизм без сети
// и без реальных задержек. Проверяем: стабильный Idempotency-Key и идентичное тело на ретраях,
// классификацию (2xx/429/5xx/409/прочие 4xx/network), парсинг Retry-After и отсутствие утечек
// секретов/PII/тел в результатах и ошибках.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEmailService } = require('../server/services/emailService');

// Фейковый node-fetch Response: .status, .headers.get(), .json() (может кинуть — «битое тело»).
function res({ status = 200, body = {}, headers = {}, badJson = false }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,   // legacy sendEmail gates on r.ok
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    json: async () => { if (badJson) throw new SyntaxError('Unexpected token < in JSON'); return body; },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function networkFail() {
  const e = new Error('request to https://api.resend.com/emails failed: SECRET_KEY leaked');
  e.type = 'request-timeout';
  return () => { throw e; };
}

const CONFIG = {
  isProduction: false,
  email: { apiKey: 'test_resend_key', from: 'Atlavue <no-reply@atlavue.app>' },
  http: { appUrl: 'https://atlavue.app', trustedHosts: '' },
};

// responders — по одному на вызов fetch (последний повторяется); captures — записанные (url, opts).
function makeSvc(responders, { config = CONFIG, now } = {}) {
  const calls = [];
  const sleeps = [];
  let i = 0;
  const svc = createEmailService({
    config,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      const r = responders[i] !== undefined ? responders[i] : responders[responders.length - 1];
      i += 1;
      return r(url, opts);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    now: now || (() => 1_700_000_000_000),
  });
  return { svc, calls, sleeps };
}

const KEY = 'report-email/42/2026-W29';

// ── 1. Стабильный Idempotency-Key и идентичное тело на всех попытках ───────────────────────────────
test('sendEmailDetailed: одинаковый Idempotency-Key и тело на всех immediate-ретраях', async () => {
  const { svc, calls, sleeps } = makeSvc([
    () => res({ status: 500, body: { name: 'internal_server_error' } }),
    () => res({ status: 500, body: { name: 'internal_server_error' } }),
    () => res({ status: 200, body: { id: 'resend-123' } }),
  ]);
  const out = await svc.sendEmailDetailed('user@x.io', 'Тема', '<b>тело</b>', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'sent');
  assert.equal(out.providerId, 'resend-123');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 500]);
  // одинаковый ключ и байт-в-байт одинаковое тело на всех трёх попытках
  for (const c of calls) {
    assert.equal(c.opts.headers['Idempotency-Key'], KEY);
    assert.equal(c.opts.body, calls[0].opts.body);
  }
  assert.ok(KEY.length <= 256);
});

test('sendEmailDetailed: длинный/пустой Idempotency-Key отклоняется без provider call', async () => {
  const { svc, calls } = makeSvc([() => res({ status: 200, body: { id: 'x' } })]);
  const longKey = 'report-email/1/' + 'z'.repeat(400);
  const long = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: longKey });
  const empty = await svc.sendEmailDetailed('u@x.io', 's', 'h');
  assert.deepEqual(long, { outcome: 'rejected', status: 0, name: 'invalid_idempotency_key' });
  assert.deepEqual(empty, { outcome: 'rejected', status: 0, name: 'invalid_idempotency_key' });
  assert.equal(calls.length, 0);
});

// ── 2. Legacy sendEmail — boolean/single-shot, без Idempotency-Key ────────────────────────────────
test('sendEmail (legacy): boolean, single-shot, без Idempotency-Key даже на 5xx', async () => {
  const { svc, calls } = makeSvc([
    () => res({ status: 500, body: { name: 'internal_server_error' } }),
  ]);
  const ok = await svc.sendEmail('u@x.io', 's', 'h');
  assert.equal(ok, false);                 // boolean, не структура
  assert.equal(calls.length, 1);           // single-shot: без ретрая на 5xx
  assert.equal(calls[0].opts.headers['Idempotency-Key'], undefined);
});

test('sendEmail (legacy): 2xx → true, single-shot', async () => {
  const { svc, calls } = makeSvc([() => res({ status: 200, body: { id: 'ok' } })]);
  const ok = await svc.sendEmail('u@x.io', 's', 'h');
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers['Idempotency-Key'], undefined);
});

// ── 3. Классификация ──────────────────────────────────────────────────────────────────────────────
test('network timeout → успех на ретрае с тем же ключом', async () => {
  const { svc, calls } = makeSvc([
    networkFail(),
    () => res({ status: 200, body: { id: 'after-timeout' } }),
  ]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'sent');
  assert.equal(out.providerId, 'after-timeout');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers['Idempotency-Key'], KEY);   // тот же ключ на ретрае
});

test('исчерпанный network → ambiguous, без утечки URL/секрета', async () => {
  const { svc, calls, sleeps } = makeSvc([networkFail()]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'ambiguous');
  assert.equal(out.reason, 'network');
  assert.equal(out.causeCode, 'request-timeout');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 500]);
  assert.equal(out.causeCode, 'request-timeout');
  assert.doesNotMatch(JSON.stringify(out), /SECRET_KEY|resend\.com|test_resend_key/);
});

test('исчерпанный 5xx → ambiguous', async () => {
  const { svc, calls } = makeSvc([() => res({ status: 503, body: { name: 'service_unavailable' } })]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'ambiguous');
  assert.equal(out.reason, 'http_5xx');
  assert.equal(out.status, 503);
  assert.equal(calls.length, 3);
});

test('429 без Retry-After → retryable (known-not-sent), ограниченный backoff', async () => {
  const { svc, calls, sleeps } = makeSvc([() => res({ status: 429, body: { name: 'rate_limit_exceeded' } })]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'retryable');
  assert.equal(out.status, 429);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 500]);
});

test('429 с Retry-After > бюджета → fail-fast (одна попытка, без sleep)', async () => {
  const { svc, calls, sleeps } = makeSvc([
    () => res({ status: 429, body: { name: 'rate_limit_exceeded' }, headers: { 'retry-after': '5' } }),
  ]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'retryable');
  assert.equal(out.retryAfter, 5);
  assert.equal(calls.length, 1);       // 5s > 1s бюджет → не ждём, не ретраим
  assert.deepEqual(sleeps, []);
});

test('409 concurrent_idempotent_requests → ambiguous (ретраится тем же ключом)', async () => {
  const { svc, calls } = makeSvc([
    () => res({ status: 409, body: { name: 'concurrent_idempotent_requests' } }),
    () => res({ status: 200, body: { id: 'won-race' } }),
  ]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'sent');
  assert.equal(out.providerId, 'won-race');
  assert.equal(calls.length, 2);
});

test('409 concurrent с длинным Retry-After → ambiguous fail-fast без раннего повтора', async () => {
  const { svc, calls, sleeps } = makeSvc([
    () => res({
      status: 409,
      body: { name: 'concurrent_idempotent_requests' },
      headers: { 'retry-after': '5' },
    }),
  ]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'ambiguous');
  assert.equal(out.reason, 'concurrent');
  assert.equal(out.retryAfter, 5);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('409 invalid_idempotent_request → rejected (не ретраится)', async () => {
  const { svc, calls } = makeSvc([
    () => res({ status: 409, body: { name: 'invalid_idempotent_request' } }),
  ]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'rejected');
  assert.equal(out.name, 'invalid_idempotent_request');
  assert.equal(calls.length, 1);
});

test('прочие 4xx (invalid payload/auth) → rejected, single-shot', async () => {
  const { svc, calls } = makeSvc([
    () => res({ status: 422, body: { name: 'validation_error', message: 'bad from' } }),
  ]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'rejected');
  assert.equal(out.status, 422);
  assert.equal(out.name, 'validation_error');
  assert.equal(calls.length, 1);
});

test('битое тело на 4xx → rejected, статус сохранён, без падения', async () => {
  const { svc, calls } = makeSvc([() => res({ status: 400, badJson: true })]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'rejected');
  assert.equal(out.status, 400);
  assert.equal(out.name, null);
  assert.equal(calls.length, 1);
});

test('небезопасные provider name и network causeCode не выходят из сервиса', async () => {
  const badName = makeSvc([
    () => res({ status: 422, body: { name: 'validation_error\nuser@x.io' } }),
  ]);
  assert.equal((await badName.svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY })).name, null);

  const badCause = makeSvc([() => {
    const error = new Error('secret');
    error.code = 'ECONNRESET user@x.io';
    throw error;
  }]);
  const out = await badCause.svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.causeCode, 'network_error');
});

test('битое тело на 2xx → всё равно sent (providerId=null)', async () => {
  const { svc } = makeSvc([() => res({ status: 200, badJson: true })]);
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'sent');
  assert.equal(out.providerId, null);
});

// ── 4. Никаких секретов/PII/тел в результате ──────────────────────────────────────────────────────
test('результат не содержит API-ключ, получателя, HTML или полное тело ответа', async () => {
  const { svc } = makeSvc([
    () => res({ status: 422, body: { name: 'validation_error', message: 'secret-detail user@x.io <b>тело</b>' } }),
  ]);
  const out = await svc.sendEmailDetailed('user@x.io', 'Тема', '<b>тело</b>', { idempotencyKey: KEY });
  const dump = JSON.stringify(out);
  assert.doesNotMatch(dump, /test_resend_key/);
  assert.doesNotMatch(dump, /user@x\.io/);
  assert.doesNotMatch(dump, /тело/);
  assert.doesNotMatch(dump, /secret-detail/);
});

// ── 5. Без провайдера (dev) — detailed уходит как sent, но помечен dev ────────────────────────────
test('sendEmailDetailed без RESEND_API_KEY → { outcome: sent, dev: true }, без fetch', async () => {
  const { svc, calls } = makeSvc([() => res({ status: 200 })], {
    config: { ...CONFIG, email: { apiKey: '', from: CONFIG.email.from } },
  });
  const out = await svc.sendEmailDetailed('u@x.io', 's', 'h', { idempotencyKey: KEY });
  assert.equal(out.outcome, 'sent');
  assert.equal(out.dev, true);
  assert.equal(calls.length, 0);
});
