'use strict';

// Unit-тесты resilience-обвязки createInstagramClient().igFetch (versioned data-edge GET choke-point).
// Инъектируем fetch/sleep/clock → детерминизм без сети и без реальных задержек. Проверяем: bounded
// retry только на transient, безопасную структурную метадату на ошибке, парсинг Retry-After
// (секунды и HTTP-date), общий singleflight на конкурентных вызовах и bypass refresh-пути.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInstagramClient } = require('../server/infrastructure/instagramClient');

// Фейковый node-fetch Response: .status, .headers.get(), .json() (может кинуть — «битое тело»).
function res({ status = 200, body = {}, headers = {}, badJson = false }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    json: async () => { if (badJson) throw new SyntaxError('Unexpected token < in JSON'); return body; },
  };
}

// Сетевой сбой fetchWithTimeout: сообщение специально содержит токенизированный URL, чтобы тест
// подтвердил, что мы его НЕ протаскиваем в err.message/логи.
function networkFail() {
  const e = new Error('network timeout at: https://graph.instagram.com/v22.0/1?access_token=SECRET');
  e.type = 'request-timeout';
  return () => { throw e; };
}

// responders — массив функций (url)=>Response|throw, по одной на вызов fetch (последняя повторяется).
function makeClient(responders, { now, db, igCrypto } = {}) {
  const calls = [];
  const sleeps = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = responders[i] !== undefined ? responders[i] : responders[responders.length - 1];
    i += 1;
    return r(url);
  };
  const client = createInstagramClient({
    db: db || { updateIgToken: async () => {} },
    log: () => {},
    igCrypto: igCrypto || { encrypt: (t) => `enc(${t})` },
    defaultToken: 'DEFAULT_TOKEN',
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    now: now || (() => 1_000_000_000),
  });
  return { client, calls, sleeps };
}

async function rejects(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error('expected rejection but promise resolved');
}

// ── 1. HTTP 429: метадата, Retry-After (секунды), fail-fast когда задержка > backoff-бюджета ──────
test('429 с Retry-After в секундах > бюджета → fail-fast, статус 429 + метадата', async () => {
  const { client, calls, sleeps } = makeClient([
    () => res({
      status: 429,
      body: { error: { message: 'rate limited', code: 4 } },
      headers: { 'retry-after': '2', 'x-app-usage': '{"call_count":100}' },
    }),
  ]);
  const err = await rejects(client.igFetch('/1/insights', { metric: 'reach' }));
  assert.equal(err.status, 429);
  assert.equal(err.transient, true);
  assert.equal(err.retryAfter, 2);            // Retry-After: 2 сек распарсен
  assert.equal(err.upstreamStatus, 429);
  assert.deepEqual(err.appUsage, { call_count: 100 });
  assert.equal(err.graph.code, 4);
  // 2s Retry-After превышает 1s backoff-бюджет → провайдера не ждём, падаем сразу.
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('429 без Retry-After ретраится по экспоненте в пределах бюджета (3 попытки, sleeps 250/500)', async () => {
  const { client, calls, sleeps } = makeClient([
    () => res({ status: 429, body: { error: { message: 'slow down', code: 17 } } }),
  ]);
  const err = await rejects(client.igFetch('/1/insights', { metric: 'reach' }));
  assert.equal(err.status, 429);
  assert.equal(calls.length, 3);              // 1 + 2 ретрая
  assert.deepEqual(sleeps, [250, 500]);       // ограниченный экспоненциальный backoff
});

test('Retry-After как HTTP-date парсится в секунды и уважает бюджет', async () => {
  const nowMs = 1_700_000_000_000;
  const httpDate = new Date(nowMs + 3000).toUTCString();   // +3 сек
  const { client, calls } = makeClient([
    () => res({ status: 429, body: { error: { message: 'rl', code: 4 } }, headers: { 'retry-after': httpDate } }),
  ], { now: () => nowMs });
  const err = await rejects(client.igFetch('/1'));
  assert.equal(err.retryAfter, 3);            // HTTP-date → 3 сек
  assert.equal(calls.length, 1);              // 3s > бюджет → fail-fast
});

test('переполненный Retry-After игнорируется и не превращается в невалидный Infinity header', async () => {
  const { client } = makeClient([
    () => res({
      status: 429,
      body: { error: { message: 'rl', code: 4 } },
      headers: { 'retry-after': '9'.repeat(400) },
    }),
  ]);
  const err = await rejects(client.igFetch('/1'));
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, undefined);
});

// ── 2. Transient 5xx: успех на ретрае, точный счётчик попыток ─────────────────────────────────────
test('transient 5xx восстанавливается на ретрае (2 попытки, 1 sleep)', async () => {
  const { client, calls, sleeps } = makeClient([
    () => res({ status: 503, body: { error: { message: 'unavailable', code: 2 } } }),
    () => res({ status: 200, body: { data: [{ ok: true }] } }),
  ]);
  const out = await client.igFetch('/1/media', { fields: 'id' });
  assert.deepEqual(out, { data: [{ ok: true }] });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [250]);
});

// ── 3. Таймаут/сетевой сбой: исчерпание → 503, точное число попыток, без утечки URL/токена ────────
test('timeout/connection exhaustion → 503, 3 попытки, токен не в message', async () => {
  const { client, calls, sleeps } = makeClient([networkFail()]);
  const err = await rejects(client.igFetch('/1/insights', { metric: 'reach' }));
  assert.equal(err.status, 503);
  assert.equal(err.transient, true);
  assert.equal(err.causeCode, 'request-timeout');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [250, 500]);
  assert.doesNotMatch(err.message, /access_token|SECRET|graph\.instagram/);
});

// ── 4. Auth/permission Graph-ошибка НЕ ретраится, сохраняется как upstream 502 ────────────────────
test('OAuthException не ретраится → 502, transient=false', async () => {
  const { client, calls, sleeps } = makeClient([
    () => res({ status: 400, body: { error: { message: 'Invalid OAuth access token', code: 190, type: 'OAuthException', error_subcode: 463, is_transient: true } } }),
  ]);
  const err = await rejects(client.igFetch('/1'));
  assert.equal(err.status, 502);
  assert.equal(err.transient, false);
  assert.equal(err.graph.code, 190);
  assert.equal(err.graph.subcode, 463);
  assert.equal(err.graph.type, 'OAuthException');
  assert.equal(err.igCode, 190);
  assert.equal(err.igSubcode, 463);
  assert.equal(err.igTransient, true);
  assert.match(err.message, /Invalid OAuth access token/);
  assert.equal(calls.length, 1);              // не ретраится
  assert.deepEqual(sleeps, []);
});

// ── 5. Распознанный rate-limit код на HTTP 400 классифицируется как 429 (и ретраится) ─────────────
test('Graph rate-limit код на HTTP 400 → 429, ретраится', async () => {
  const { client, calls } = makeClient([
    () => res({ status: 400, body: { error: { message: 'application request limit reached', code: 4 } } }),
  ]);
  const err = await rejects(client.igFetch('/1/insights', { metric: 'reach' }));
  assert.equal(err.status, 429);              // 400 по HTTP, но код 4 → rate limit
  assert.equal(err.upstreamStatus, 400);
  assert.equal(err.transient, true);
  assert.equal(calls.length, 3);
});

// ── 6. Битое/не-JSON тело на 5xx не маскирует upstream-статус ─────────────────────────────────────
test('malformed 5xx body → 503, upstreamStatus=500, статус в message', async () => {
  const { client, calls } = makeClient([
    () => res({ status: 500, badJson: true }),
  ]);
  const err = await rejects(client.igFetch('/1'));
  assert.equal(err.status, 503);
  assert.equal(err.upstreamStatus, 500);
  assert.equal(err.transient, true);
  assert.match(err.message, /HTTP 500/);
  assert.equal(calls.length, 3);              // 5xx transient → ретраится несмотря на битое тело
  assert.equal(err.graph, undefined);         // тело не распарсилось → нет graph-метадаты
});

test('malformed body на не-транзиентном 400 → 502, не ретраится', async () => {
  const { client, calls } = makeClient([
    () => res({ status: 400, badJson: true }),
  ]);
  const err = await rejects(client.igFetch('/1'));
  assert.equal(err.status, 502);
  assert.equal(err.transient, false);
  assert.match(err.message, /HTTP 400/);
  assert.equal(calls.length, 1);
});

// ── 7. Конкурентные идентичные вызовы делят один retry-sequence (singleflight) ────────────────────
test('конкурентные идентичные вызовы делят одну цепочку ретраев', async () => {
  const { client, calls } = makeClient([
    () => res({ status: 500, body: { error: { message: 'boom', code: 2 } } }),
    () => res({ status: 200, body: { data: 'ok' } }),
  ]);
  const [a, b] = await Promise.all([
    client.igFetch('/1/media', { fields: 'id' }),
    client.igFetch('/1/media', { fields: 'id' }),
  ]);
  assert.deepEqual(a, { data: 'ok' });
  assert.deepEqual(b, { data: 'ok' });
  assert.equal(calls.length, 2);              // 1 сбой + 1 успех на ДВОИХ, не 4
});

test('igFetch не мутирует переданный params', async () => {
  const { client } = makeClient([() => res({ status: 200, body: { ok: 1 } })]);
  const params = { metric: 'reach' };
  await client.igFetch('/1', params);
  assert.deepEqual(params, { metric: 'reach' });   // access_token не подмешан в оригинал
});

// ── 8. refreshIgIfNeeded обходит retry-машинерию igFetch (single-shot) ────────────────────────────
test('refreshIgIfNeeded — single-shot, транзиентный сбой не ретраится и глотается', async () => {
  const nowMs = 1_000_000_000;
  const expiresAt = new Date(nowMs + 5 * 24 * 60 * 60 * 1000).toISOString();   // в окне рефреша
  const { client, calls, sleeps } = makeClient([
    () => res({ status: 500, body: {} }),   // «транзиентный» ответ рефреша
  ], { now: () => nowMs });
  const token = await client.refreshIgIfNeeded('chan-1', 'OLD_TOKEN', expiresAt);
  assert.equal(token, 'OLD_TOKEN');           // сбой проглочен → исходный токен
  assert.equal(calls.length, 1);              // ОДИН вызов — без retry-loop igFetch
  assert.deepEqual(sleeps, []);
});

test('refreshIgIfNeeded успешно обновляет и персистит новый токен', async () => {
  const nowMs = 1_000_000_000;
  const expiresAt = new Date(nowMs + 5 * 24 * 60 * 60 * 1000).toISOString();
  const persisted = [];
  const { client, calls } = makeClient([
    () => res({ status: 200, body: { access_token: 'NEW_TOKEN', expires_in: 5184000 } }),
  ], {
    now: () => nowMs,
    db: { updateIgToken: async (...a) => { persisted.push(a); } },
    igCrypto: { encrypt: (t) => `enc(${t})` },
  });
  const token = await client.refreshIgIfNeeded('chan-1', 'OLD_TOKEN', expiresAt);
  assert.equal(token, 'NEW_TOKEN');
  assert.equal(calls.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0][0], 'chan-1');
  assert.equal(persisted[0][1], 'enc(NEW_TOKEN)');
});

// ── 9. Общий app-level usage-gate: наблюдение заголовков + preflight-тормоз (paceOnUsage) ──────────
// Записывающий/переключаемый фейк gate: observe копит наблюдения, shouldStopPass управляется флагом.
function recordingGate({ open = false } = {}) {
  const observed = [];
  return {
    observed,
    open,
    observe: (obs) => observed.push(obs),
    shouldStopPass() { return this.open; },
    remainingSeconds: () => 42,
  };
}

// makeClient с gate + paceOnUsage и общим inflight Map (для теста разделяемого singleflight).
function makeGateClient(responders, { gate, paceOnUsage = false, inflight, now } = {}) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = responders[i] !== undefined ? responders[i] : responders[responders.length - 1];
    i += 1;
    return r(url);
  };
  const client = createInstagramClient({
    db: { updateIgToken: async () => {} },
    log: () => {},
    igCrypto: { encrypt: (t) => `enc(${t})` },
    defaultToken: 'DEFAULT_TOKEN',
    fetchImpl,
    sleep: async () => {},
    now: now || (() => 1_000_000_000),
    usageGate: gate,
    paceOnUsage,
    inflight,
  });
  return { client, calls };
}

test('2xx наблюдает usage-заголовки через gate.observe', async () => {
  const gate = recordingGate();
  const { client } = makeGateClient([
    () => res({ status: 200, body: { data: [1] }, headers: {
      'x-app-usage': '{"call_count":90,"total_time":33}',
      'x-business-use-case-usage': '{"biz":[{"call_count":12}]}',
    } }),
  ], { gate });
  await client.igFetch('/1/insights', { metric: 'reach' });
  assert.equal(gate.observed.length, 1);
  assert.deepEqual(gate.observed[0].appUsage, { call_count: 90, total_time: 33 });
  assert.deepEqual(gate.observed[0].businessUseCaseUsage, { biz: [{ call_count: 12 }] });
  assert.equal(gate.observed[0].status, 200);
  assert.equal(gate.observed[0].graphCode, null);
});

test('ошибочный ответ тоже наблюдается: app usage, Graph код и Retry-After', async () => {
  const gate = recordingGate();
  const { client } = makeGateClient([
    () => res({ status: 429, body: { error: { message: 'rl', code: 4 } }, headers: {
      'x-app-usage': '{"call_count":100}', 'retry-after': '2',
    } }),
  ], { gate });
  try { await client.igFetch('/1'); } catch { /* ожидаемо */ }
  assert.equal(gate.observed.length, 1);
  assert.deepEqual(gate.observed[0].appUsage, { call_count: 100 });
  assert.equal(gate.observed[0].graphCode, 4);
  assert.equal(gate.observed[0].retryAfterSeconds, 2);
  assert.equal(gate.observed[0].status, 429);
});

test('фоновый app-level throttle открывает gate и не прожигает внутренние ретраи', async () => {
  const gate = recordingGate();
  gate.observe = (obs) => {
    gate.observed.push(obs);
    if (obs.graphCode === 4) gate.open = true;
  };
  const { client, calls } = makeGateClient([
    () => res({ status: 429, body: { error: { message: 'app limited', code: 4 } } }),
    () => res({ status: 200, body: { data: ['unexpected retry'] } }),
  ], { gate, paceOnUsage: true });
  const err = await rejects(client.igFetch('/1/insights', { metric: 'reach' }));
  assert.equal(err.status, 429);
  assert.equal(calls.length, 1, 'после app-level stop фоновый полёт не делает второй Graph-вызов');
});

test('фоновый preflight (paceOnUsage) при открытом gate НЕ делает ни одного fetch', async () => {
  const gate = recordingGate({ open: true });
  const { client, calls } = makeGateClient([
    () => res({ status: 200, body: { data: [1] } }),
  ], { gate, paceOnUsage: true });
  const err = await rejects(client.igFetch('/1/insights', { metric: 'reach' }));
  assert.equal(calls.length, 0, 'preflight реджект — Graph не вызван, квота не сожжена');
  assert.equal(err.status, 429);
  assert.equal(err.transient, true);
  assert.equal(err.igGateStopped, true);
  assert.equal(err.igCode, 'ig_usage_gate');
  assert.equal(err.retryAfter, 42);
});

test('живой клиент (paceOnUsage=false) при открытом gate всё равно ходит в сеть', async () => {
  const gate = recordingGate({ open: true });
  const { client, calls } = makeGateClient([
    () => res({ status: 200, body: { data: 'live' } }),
  ], { gate, paceOnUsage: false });
  const out = await client.igFetch('/1/insights', { metric: 'reach' });
  assert.deepEqual(out, { data: 'live' });
  assert.equal(calls.length, 1, 'live-клиент никогда не preflight-блокируется');
});

test('существующий singleflight делится даже при открытом gate (без нового quota-вызова)', async () => {
  const gate = recordingGate({ open: true });
  const inflight = new Map();
  // Первый вызов создаёт полёт, пока gate ЗАКРЫТ; затем gate открывается — второй идентичный
  // вызов обязан получить тот же полёт, а не preflight-реджект.
  let release;
  const barrier = new Promise((r) => { release = r; });
  const { client, calls } = makeGateClient([
    async () => { await barrier; return res({ status: 200, body: { data: 'shared' } }); },
  ], { gate: recordingGate({ open: false }), paceOnUsage: true, inflight });
  const first = client.igFetch('/1/media', { fields: 'id' });
  // Второй клиент делит тот же inflight Map и gate уже открыт — но полёт уже есть в карте.
  const gate2 = recordingGate({ open: true });
  const second = makeGateClient([() => res({ status: 500, body: {} })], { gate: gate2, paceOnUsage: true, inflight });
  const p2 = second.client.igFetch('/1/media', { fields: 'id' });
  release();
  const [a, b] = await Promise.all([first, p2]);
  assert.deepEqual(a, { data: 'shared' });
  assert.deepEqual(b, { data: 'shared' });
  assert.equal(calls.length, 1, 'общий полёт — один upstream-вызов на двоих');
  assert.equal(second.calls.length, 0, 'второй клиент НЕ делал своего fetch (взял общий полёт)');
});

test('синтетическая throttle-ошибка gate не несёт токена/пути/сырых заголовков', async () => {
  const gate = recordingGate({ open: true });
  const { client } = makeGateClient([() => res({ status: 200, body: {} })], { gate, paceOnUsage: true });
  const err = await rejects(client.igFetch('/12345/insights', { metric: 'reach' }, 'SUPER_SECRET_TOKEN'));
  const serialized = JSON.stringify({ message: err.message, ...err });
  assert.doesNotMatch(err.message, /SUPER_SECRET_TOKEN|12345|access_token|graph\.instagram/);
  assert.doesNotMatch(serialized, /SUPER_SECRET_TOKEN|access_token/);
  assert.equal(err.appUsage, undefined, 'без сырых usage-объектов в ошибке preflight');
  assert.equal(err.path, undefined);
});
