'use strict';

// Unit-тесты исходящего клиента Метрики (lib/ymClient): гейт параллелизма, singleflight,
// политика ретраев 429 vs 420 и отсутствие утечки токена. fetchImpl инъектируется — сети нет.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createYmClient } = require('../server/lib/ymClient');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const jsonRes = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
});

test('гейт: физических запросов одновременно не больше 3, даже когда вызовов больше', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const releases = [];
  const fetchImpl = () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve) => {
      releases.push(() => {
        active -= 1;
        resolve(jsonRes(200, { ok: true }));
      });
    });
  };
  const { ymFetch } = createYmClient({ fetchImpl });
  // РАЗНЫЕ path'ы — singleflight не схлопывает, каждый идёт в гейт своим физическим запросом.
  const pending = Array.from({ length: 8 }, (_, i) => ymFetch('tok', `/stat/v1/data?p=${i}`));
  await tick();
  assert.ok(maxActive <= 3, `в полёте одновременно ${maxActive} > 3`);
  assert.equal(active, 3, 'ровно 3 слота заняты, остальные ждут гейт');
  // Дренируем: каждый release отдаёт слот ждущему, тот вызывает fetchImpl снова.
  while (releases.length) {
    releases.shift()();
    await tick();
  }
  await Promise.all(pending);
  assert.equal(calls, 8, 'все восемь дошли до физического запроса');
  assert.ok(maxActive <= 3, `итоговый максимум параллелизма ${maxActive} > 3`);
});

test('singleflight: два одинаковых одновременных вызова = один физический fetch, общий результат', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonRes(200, { data: [], totals: [calls] });
  };
  const { ymFetch } = createYmClient({ fetchImpl });
  const [a, b] = await Promise.all([
    ymFetch('tok', '/stat/v1/data?ids=1'),
    ymFetch('tok', '/stat/v1/data?ids=1'),
  ]);
  assert.equal(calls, 1, 'одинаковые (токен+path) делят один физический запрос');
  assert.equal(a, b, 'оба вызова получили один и тот же результат');
  // После settle запись очищена — следующий такой же вызов идёт заново.
  await ymFetch('tok', '/stat/v1/data?ids=1');
  assert.equal(calls, 2, 'на settle singleflight-запись очистилась');
});

test('singleflight не путает разные токены на одном path', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonRes(200, { ok: true }); };
  const { ymFetch } = createYmClient({ fetchImpl });
  await Promise.all([ymFetch('token-A', '/stat/v1/data?ids=1'), ymFetch('token-B', '/stat/v1/data?ids=1')]);
  assert.equal(calls, 2, 'разные identity токена — разные ключи, оба физически идут');
});

test('429: ровно один повтор, затем успех', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? jsonRes(429, { errors: [{ message: 'quota' }] }) : jsonRes(200, { ok: true });
  };
  const { ymFetch } = createYmClient({ fetchImpl });
  const out = await ymFetch('tok', '/stat/v1/data?ids=1');
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2, '429 → одна повторная попытка');
});

test('429: Retry-After уважается (секунды), но внутреннее ожидание кэпается', async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? jsonRes(429, {}, { 'retry-after': '20' }) : jsonRes(200, { ok: true });
  };
  const { ymFetch } = createYmClient({
    fetchImpl,
    sleepImpl: async (ms) => { waits.push(ms); },
    log: (_l, _e, meta) => { if (meta && meta.waitMs != null) waits.push(meta.waitMs); },
  });
  await ymFetch('tok', '/x');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5000, 5000], 'лог и sleep получили cap 5с, а не исходные 20с');
});

test('420: НЕ ретраится немедленно, пробрасывается с quota-меткой; токена в ошибке нет', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonRes(420, { errors: [{ message: 'Quota exceeded' }] }, { 'retry-after': '120' });
  };
  const { ymFetch } = createYmClient({ fetchImpl });
  await assert.rejects(
    () => ymFetch('super-secret-token', '/stat/v1/data?ids=1'),
    (e) => {
      assert.equal(e.status, 420, '420 сохраняется как статус');
      assert.equal(e.quota, true, 'помечен как quota');
      assert.equal(e.retryAfterMs, 120000, 'длинный Retry-After 420 не обрезан cap-ом retry 429');
      assert.ok(!String(e.message).includes('super-secret-token'), 'токена в message нет');
      assert.ok(!JSON.stringify({ m: e.message, s: e.status }).includes('super-secret-token'), 'токена нет и в сериализации');
      return true;
    },
  );
  assert.equal(calls, 1, '420 не ретраится — ровно один физический запрос');
});

test('сетевой сбой → status 503 с безопасным causeCode, токен не протекает', async () => {
  const fetchImpl = async () => { const e = new Error('ECONNRESET on secret-token'); e.code = 'ECONNRESET'; throw e; };
  const { ymFetch } = createYmClient({ fetchImpl });
  await assert.rejects(
    () => ymFetch('secret-token', '/x'),
    (e) => {
      assert.equal(e.status, 503);
      assert.equal(e.causeCode, 'ECONNRESET');
      assert.ok(!String(e.message).includes('secret-token'), 'сырое сетевое сообщение с токеном не пробрасывается');
      return true;
    },
  );
});
