'use strict';

// Focused unit tests для дневного сбора МойСклада (jobs/msCollectionJob). Без сети: msFetch —
// программируемый фейк по path; db — фейк с записью upsert'ов и passthrough runJobOnce.
// Проверяем: склейку sales+orders серий в day-строки (копейки без конверсии), контракт
// «день пишется только когда пришли ОБА отчёта» (никаких частичных строк), decrypt-fail =
// warn+skip БЕЗ claim'а day-gate, изоляцию сбоя одного аккаунта, day-gate skip и форму окна.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMsCollectionJob } = require('../server/jobs/msCollectionJob');

const ACC1 = { channel_id: 7, ms_account_id: 'acc-1', org_name: 'ООО Ромашка', access_token_enc: 'enc1' };
const ACC2 = { channel_id: 9, ms_account_id: 'acc-2', org_name: 'ООО Пион', access_token_enc: 'enc2' };

function makeDb({ accounts = [], skipKeys = [] } = {}) {
  const upserts = [];
  const jobKeys = [];
  const skips = new Set(skipKeys);
  return {
    enabled: true,
    upserts,
    jobKeys,
    listMsAccounts: async () => accounts,
    upsertMsDaily: async (channelId, rows) => { upserts.push({ channelId, rows }); return rows.length; },
    // Passthrough-гейт: фиксирует ключи; помеченные — «сегодня уже собрано».
    runJobOnce: async (kind, key, fn) => {
      jobKeys.push(`${kind}|${key}`);
      if (skips.has(key)) return { skipped: true, job: null };
      const result = await fn();
      return { skipped: false, result };
    },
  };
}

function makeJob({ db, handlers }) {
  const fetches = [];
  const msFetch = async (token, path) => {
    fetches.push({ token, path });
    return handlers(token, path);
  };
  const job = createMsCollectionJob({
    db,
    msFetch,
    msCrypto: { configured: () => true, decrypt: (enc) => (enc === 'broken' ? (() => { throw new Error('bad blob'); })() : `TOKEN:${enc}`) },
    log: () => {},
  });
  return { job, fetches };
}

// Обе серии окна: продажи в двух днях, заказы в одном (второй день заказов «пустой» у МС).
function benign(_token, path) {
  if (path.startsWith('/report/sales/plotseries')) {
    return { series: [
      { date: '2026-07-15 00:00:00', sum: 12550, quantity: 2 },
      { date: '2026-07-16 00:00:00', sum: 100, quantity: 1 },
    ] };
  }
  if (path.startsWith('/report/orders/plotseries')) {
    return { series: [{ date: '2026-07-15 00:00:00', sum: 9900, quantity: 3 }] };
  }
  throw new Error(`unexpected path: ${path}`);
}

test('окно сбора: сегодня−7 00:00:00 … сегодня 23:59:00 (7-дневное перекрытие)', () => {
  const { job } = makeJob({ db: makeDb(), handlers: benign });
  const w = job.collectionWindow(new Date(2026, 6, 17, 15, 30));   // 17 июля 2026, местное
  assert.equal(w.momentFrom, '2026-07-10 00:00:00');
  assert.equal(w.momentTo, '2026-07-17 23:59:00');
});

test('seriesToRows: sales+orders склеиваются по дню, копейки как есть, отсутствие второй серии в дне = честный 0', () => {
  const { job } = makeJob({ db: makeDb(), handlers: benign });
  const rows = job.seriesToRows(
    { series: [{ date: '2026-07-15 00:00:00', sum: 12550 }, { date: '2026-07-16 00:00:00', sum: 100.4 }] },
    { series: [{ date: '2026-07-15 00:00:00', sum: 9900, quantity: 3 }, { date: 'мусор', sum: 1 }] },
  );
  assert.deepEqual(rows, [
    { day: '2026-07-15', revenue_kopecks: 12550, orders_count: 3, orders_sum_kopecks: 9900 },
    // 100.4 копейки → Math.round-страховка; заказов в дне нет → 0 (не null: окно пере-снято целиком)
    { day: '2026-07-16', revenue_kopecks: 100, orders_count: 0, orders_sum_kopecks: 0 },
  ]);
});

test('happy path: оба отчёта → upsert строк, сводка {channels, days, errors, skipped}', async () => {
  const db = makeDb({ accounts: [ACC1] });
  const { job, fetches } = makeJob({ db, handlers: benign });
  const stats = await job.runMsCollectionPass();
  assert.deepEqual(stats, { channels: 1, days: 2, errors: 0, skipped: 0 });
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0].channelId, 7);
  assert.equal(db.upserts[0].rows.length, 2);
  // День-гейт: ключ содержит и канал, и идентичность склада (reconnect не наследует succeeded).
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(db.jobKeys, [`ms_collect|7:acc-1:${day}`]);
  // Оба отчёта одного окна, interval=day, токен из decrypt.
  assert.equal(fetches.length, 2);
  assert.ok(fetches.every((f) => f.token === 'TOKEN:enc1' && f.path.includes('interval=day')));
});

test('недешифруемый токен: warn+skip БЕЗ claim\'а дня — починка ключа не ждёт завтра', async () => {
  const db = makeDb({ accounts: [{ ...ACC1, access_token_enc: 'broken' }, ACC2] });
  const { job, fetches } = makeJob({ db, handlers: benign });
  const stats = await job.runMsCollectionPass();
  assert.deepEqual(stats, { channels: 1, days: 2, errors: 1, skipped: 0 });
  assert.equal(db.jobKeys.length, 1, 'день битого аккаунта НЕ заклеймлен (retryable после починки ключа)');
  assert.ok(db.jobKeys[0].startsWith('ms_collect|9:acc-2:'));
  assert.ok(fetches.every((f) => f.token === 'TOKEN:enc2'), 'к МС сходил только здоровый аккаунт');
});

test('сбой одного отчёта: НИКАКОЙ частичной записи, ошибка изолирована от остальных аккаунтов', async () => {
  const db = makeDb({ accounts: [ACC1, ACC2] });
  const { job } = makeJob({
    db,
    handlers: (token, path) => {
      if (token === 'TOKEN:enc1' && path.startsWith('/report/orders/')) {
        const e = new Error('МойСклад: HTTP 500'); e.status = 500; throw e;
      }
      return benign(token, path);
    },
  });
  const stats = await job.runMsCollectionPass();
  assert.deepEqual(stats, { channels: 1, days: 2, errors: 1, skipped: 0 });
  assert.deepEqual(db.upserts.map((u) => u.channelId), [9], 'у сбойного аккаунта не записано НИЧЕГО (без обнуления второй серии)');
});

test('day-gate skip: сегодня уже собрано → ни fetch\'а, ни upsert\'а, skipped++', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const db = makeDb({ accounts: [ACC1], skipKeys: [`7:acc-1:${day}`] });
  const { job, fetches } = makeJob({ db, handlers: benign });
  const stats = await job.runMsCollectionPass();
  assert.deepEqual(stats, { channels: 0, days: 0, errors: 0, skipped: 1 });
  assert.equal(fetches.length, 0);
  assert.equal(db.upserts.length, 0);
});

test('DB off / MS_TOKEN_KEY не задан: проход инертен', async () => {
  const dbOff = { ...makeDb({ accounts: [ACC1] }), enabled: false };
  const { job: jobOff, fetches: fetchesOff } = makeJob({ db: dbOff, handlers: benign });
  assert.deepEqual(await jobOff.runMsCollectionPass(), { channels: 0, days: 0, errors: 0, skipped: 0 });
  assert.equal(fetchesOff.length, 0);

  const db = makeDb({ accounts: [ACC1] });
  const fetches = [];
  const job = createMsCollectionJob({
    db,
    msFetch: async (...a) => { fetches.push(a); return {}; },
    msCrypto: { configured: () => false, decrypt: () => 'X' },
    log: () => {},
  });
  assert.deepEqual(await job.runMsCollectionPass(), { channels: 0, days: 0, errors: 0, skipped: 0 });
  assert.equal(fetches.length, 0);
});
