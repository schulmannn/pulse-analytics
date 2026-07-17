'use strict';

// Focused unit tests для движка бэкфилла заказов МойСклада (jobs/msBackfillJob). Без сети и
// таймеров: msFetch — программируемый фейк по path (query разбирается URLSearchParams после
// обязательного URL-encode фильтра), db — фейк с in-memory ms_backfill_state и passthrough
// runJobOnce, sleepFn — записывающий no-op. Проверяем спеку слайса 2б: оценка+старейший →
// помесячные окна с прогрессом после каждой страницы, resume с cursor_from, пустой аккаунт →
// done сразу, фатальная ошибка сохраняет cursor, null-safe mapping agent/state, single-flight
// отказ (in-process и durable), доливку под durable day-gate без изменения status.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMsBackfillEngine } = require('../server/jobs/msBackfillJob');

const ACC = { channel_id: 7, ms_account_id: 'acc-1', org_name: 'ООО Ромашка', access_token_enc: 'enc1' };

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
// Первое число месяца, отстоящего на delta от текущего (delta=-1 — прошлый месяц).
const monthStartAt = (delta) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + delta, 1);
};

function makeDb({ accounts = [ACC], states = {}, skipKeys = [] } = {}) {
  const stateByChannel = new Map(
    Object.entries(states).map(([k, v]) => [Number(k), { ...v }]),
  );
  const patches = [];
  const upserts = [];
  const jobKeys = [];
  const skips = new Set(skipKeys);
  return {
    enabled: true,
    patches, upserts, jobKeys, stateByChannel,
    listMsAccounts: async () => accounts,
    getMsAccount: async (channelId) => accounts.find((a) => a.channel_id === channelId) || null,
    getMsBackfillState: async (channelId) => stateByChannel.get(channelId) || null,
    setMsBackfillState: async (channelId, patch) => {
      patches.push({ channelId, patch: { ...patch } });
      const prev = stateByChannel.get(channelId) || { channel_id: channelId, status: 'idle', fetched_count: 0 };
      // Свежая запись = свежий updated_at → возраст 0 (как EXTRACT(EPOCH …) сразу после записи).
      stateByChannel.set(channelId, { ...prev, ...patch, updated_age_seconds: 0 });
      return true;
    },
    upsertMsOrders: async (channelId, rows) => { upserts.push({ channelId, rows }); return rows.length; },
    countMsOrders: async () => 0,
    runJobOnce: async (kind, key, fn) => {
      jobKeys.push(`${kind}|${key}`);
      if (skips.has(key)) return { skipped: true, job: null };
      const result = await fn();
      return { skipped: false, result };
    },
  };
}

// handlers(q, path) получает разобранный query; отвечает на head/oldest/страницы окна.
function makeEngine({ db, handlers }) {
  const fetches = [];
  const sleeps = [];
  const engine = createMsBackfillEngine({
    db,
    msFetch: async (token, path) => {
      assert.ok(!path.includes(' '), `path обязан быть URL-encoded (пробел в: ${path})`);
      fetches.push({ token, path });
      return handlers(new URLSearchParams(path.split('?')[1] || ''), path);
    },
    msCrypto: {
      configured: () => true,
      decrypt: (enc) => (enc === 'broken' ? (() => { throw new Error('bad blob'); })() : `TOKEN:${enc}`),
    },
    log: () => {},
    sleepFn: async (ms) => { sleeps.push(ms); },
  });
  return { engine, fetches, sleeps };
}

const order = (id, moment, extra = {}) => ({ id, moment, sum: 12550, ...extra });

// Стандартный аккаунт: total=3, старейший заказ — в прошлом месяце, страницы отвечают из byMonth.
function scriptedApi({ total, oldestMoment, byWindow = () => [] }) {
  return (q) => {
    if (q.get('filter') == null) {
      // head (limit=1) или oldest (limit=1&order=moment,asc)
      if (q.get('order') === 'moment,asc') {
        return { meta: { size: total }, rows: oldestMoment ? [order('old-1', oldestMoment)] : [] };
      }
      return { meta: { size: total }, rows: [] };
    }
    const m = /^moment>=(\d{4}-\d{2}-\d{2}) 00:00:00;moment<=(\d{4}-\d{2}-\d{2}) 23:59:59$/.exec(q.get('filter'));
    assert.ok(m, `фильтр окна не в каноничной форме: ${q.get('filter')}`);
    return { rows: byWindow(m[1], m[2], Number(q.get('offset')) || 0) };
  };
}

test('start: оценка + старейший → помесячные окна с первого числа его месяца, прогресс после каждой страницы, финал done', async () => {
  const prevMonth = monthStartAt(-1);
  const oldestMoment = `${fmtDay(prevMonth)} 10:00:00.000`;
  const db = makeDb();
  const { engine, fetches } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 3,
      oldestMoment,
      byWindow: (from) => (from === fmtDay(prevMonth)
        ? [order('a', `${fmtDay(prevMonth)} 10:00:00.000`), order('b', `${fmtDay(prevMonth)} 11:00:00.000`)]
        : [order('c', `${fmtDay(monthStartAt(0))} 09:00:00.000`)]),
    }),
  });
  const out = await engine.start(7);
  assert.deepEqual(out, { status: 'done', fetched: 3 });

  // Claim: running с cursor_from = 1-е число месяца старейшего заказа, оценка и обнулённый счётчик.
  const claim = db.patches[0];
  assert.equal(claim.channelId, 7);
  assert.equal(claim.patch.status, 'running');
  assert.equal(claim.patch.cursor_from, fmtDay(prevMonth));
  assert.equal(claim.patch.total_estimate, 3);
  assert.equal(claim.patch.fetched_count, 0);
  assert.ok(claim.patch.started_at instanceof Date);

  // Окна: прошлый месяц целиком, затем текущий; границы — календарные, order=moment,asc, limit=1000.
  const pageFetches = fetches.filter((f) => f.path.includes('filter='));
  assert.equal(pageFetches.length, 2);
  assert.ok(pageFetches.every((f) => f.token === 'TOKEN:enc1'
    && f.path.includes('limit=1000') && f.path.includes(`order=${encodeURIComponent('moment,asc')}`)));
  const win1 = new URLSearchParams(pageFetches[0].path.split('?')[1]).get('filter');
  assert.equal(win1, `moment>=${fmtDay(prevMonth)} 00:00:00;moment<=${fmtDay(monthEnd(prevMonth))} 23:59:59`);

  // Прогресс после каждой страницы + продвижение курсора после месяца; финал — done без error.
  const counts = db.patches.filter((p) => 'fetched_count' in p.patch).map((p) => p.patch.fetched_count);
  assert.deepEqual(counts.slice(-2), [3, 3]);
  assert.deepEqual(db.patches.at(-1).patch, { status: 'done', fetched_count: 3, error: null });
  assert.deepEqual(db.upserts.map((u) => u.rows.length), [2, 1]);
  assert.equal(db.stateByChannel.get(7).status, 'done');
});

test('пагинация: полная страница limit=1000 → следующий offset, прогресс на каждой, пауза между страницами', async () => {
  const cur = monthStartAt(0);
  const day = `${fmtDay(cur)} 08:00:00.000`;
  const fullPage = Array.from({ length: 1000 }, (_, i) => order(`p0-${i}`, day));
  const db = makeDb();
  const { engine, fetches, sleeps } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 1002,
      oldestMoment: day,
      byWindow: (_from, _to, offset) => (offset === 0 ? fullPage : [order('p1-0', day), order('p1-1', day)]),
    }),
  });
  const out = await engine.start(7);
  assert.deepEqual(out, { status: 'done', fetched: 1002 });
  const offsets = fetches.filter((f) => f.path.includes('filter='))
    .map((f) => Number(new URLSearchParams(f.path.split('?')[1]).get('offset')));
  assert.deepEqual(offsets, [0, 1000]);
  assert.deepEqual(sleeps, [150], 'пауза ровно между страницами (после последней не спим)');
  const counts = db.patches.filter((p) => 'fetched_count' in p.patch).map((p) => p.patch.fetched_count);
  assert.ok(counts.includes(1000), 'прогресс записан уже после ПЕРВОЙ страницы, не только в конце');
});

test('пустой аккаунт: meta.size=0 → done сразу, без единого оконного запроса', async () => {
  const db = makeDb();
  const { engine, fetches } = makeEngine({
    db,
    handlers: scriptedApi({ total: 0, oldestMoment: null }),
  });
  const out = await engine.start(7);
  assert.deepEqual(out, { status: 'done', fetched: 0 });
  assert.equal(fetches.filter((f) => f.path.includes('filter=')).length, 0);
  assert.equal(db.upserts.length, 0);
  const final = db.stateByChannel.get(7);
  assert.equal(final.status, 'done');
  assert.equal(final.fetched_count, 0);
  assert.equal(final.cursor_from, null);
});

test('фатальная ошибка страницы: status=error, cursor_from и fetched_count сохранены (resume с места)', async () => {
  const prevMonth = monthStartAt(-1);
  const curMonth = monthStartAt(0);
  const db = makeDb();
  const { engine } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 5,
      oldestMoment: `${fmtDay(prevMonth)} 10:00:00.000`,
      byWindow: (from) => {
        if (from === fmtDay(prevMonth)) return [order('a', `${fmtDay(prevMonth)} 10:00:00.000`)];
        const e = new Error('МойСклад: HTTP 500');
        e.status = 500;
        throw e;
      },
    }),
  });
  await assert.rejects(engine.start(7), /HTTP 500/);
  const state = db.stateByChannel.get(7);
  assert.equal(state.status, 'error');
  assert.match(state.error, /HTTP 500/);
  assert.equal(state.cursor_from, fmtDay(curMonth), 'курсор остался на недобранном месяце');
  assert.equal(state.fetched_count, 1, 'прогресс добранного месяца не потерян');
});

test('resume(): stale-running продолжает с cursor_from, наращивая fetched_count; свежий running не трогается', async () => {
  const curMonth = monthStartAt(0);
  const stale = {
    channel_id: 7, status: 'running', cursor_from: fmtDay(curMonth),
    fetched_count: 41, updated_age_seconds: 3600,
  };
  const db = makeDb({ states: { 7: stale } });
  const { engine, fetches } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 42,
      oldestMoment: null,   // оценки при resume быть не должно — упадёт на assert ниже
      byWindow: () => [order('z', `${fmtDay(curMonth)} 12:00:00.000`)],
    }),
  });
  const stats = await engine.resume();
  assert.deepEqual(stats, { resumed: 1, errors: 0 });
  assert.equal(fetches.filter((f) => !f.path.includes('filter=')).length, 0, 'resume не пере-оценивает архив');
  const final = db.stateByChannel.get(7);
  assert.equal(final.status, 'done');
  assert.equal(final.fetched_count, 42, 'счётчик продолжен, не обнулён');

  // Свежая running-строка (живой прогон) — не трогается вовсе.
  const freshDb = makeDb({ states: { 7: { ...stale, updated_age_seconds: 30 } } });
  const fresh = makeEngine({ db: freshDb, handlers: () => { throw new Error('не должен ходить в МС'); } });
  assert.deepEqual(await fresh.engine.resume(), { resumed: 0, errors: 0 });
  assert.equal(freshDb.patches.length, 0);
});

test('mapping: null-safe agent/state, agent_id из последнего сегмента href, кривой moment отброшен', async () => {
  const cur = monthStartAt(0);
  const day = `${fmtDay(cur)} 10:00:00.000`;
  const db = makeDb();
  const { engine } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 3,
      oldestMoment: day,
      byWindow: () => [
        order('full', day, {
          sum: 100.4,
          state: { name: 'Новый' },
          agent: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/uuid-1?expand=x' }, name: 'ИП Пион' },
        }),
        order('bare', day, { state: { meta: {} }, agent: { meta: {} } }),
        order('junk', 'мусор вместо даты'),
      ],
    }),
  });
  await engine.start(7);
  assert.equal(db.upserts.length, 1);
  assert.deepEqual(db.upserts[0].rows, [
    { order_id: 'full', moment: day, sum_kopecks: 100, state: 'Новый', agent_id: 'uuid-1', agent_name: 'ИП Пион' },
    { order_id: 'bare', moment: day, sum_kopecks: 12550, state: null, agent_id: null, agent_name: null },
  ]);
});

test('single-flight: параллельный start того же канала отвергается сразу, «уже идёт»', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cur = monthStartAt(0);
  const db = makeDb();
  const { engine } = makeEngine({
    db,
    handlers: async (q) => {
      if (q.get('filter') == null && q.get('order') !== 'moment,asc') {
        await gate;   // head-запрос завис — прогон «идёт»
        return { meta: { size: 1 }, rows: [] };
      }
      return scriptedApi({
        total: 1,
        oldestMoment: `${fmtDay(cur)} 10:00:00.000`,
        byWindow: () => [order('a', `${fmtDay(cur)} 10:00:00.000`)],
      })(q);
    },
  });
  const first = engine.start(7);
  await assert.rejects(engine.start(7), (e) => e.code === 'MS_BACKFILL_RUNNING' && /уже идёт/.test(e.message));
  assert.equal(await engine.isBusy(7), true);
  release();
  assert.deepEqual(await first, { status: 'done', fetched: 1 });
  assert.equal(await engine.isBusy(7), false);
});

test('single-flight durable: свежая running-строка в БД (< 5 мин) → отказ без записи в state', async () => {
  const db = makeDb({
    states: { 7: { channel_id: 7, status: 'running', cursor_from: '2026-01-01', fetched_count: 5, updated_age_seconds: 60 } },
  });
  const { engine, fetches } = makeEngine({ db, handlers: () => { throw new Error('не должен ходить в МС'); } });
  assert.equal(await engine.isBusy(7), true);
  await assert.rejects(engine.start(7), (e) => e.code === 'MS_BACKFILL_RUNNING');
  assert.equal(fetches.length, 0);
  assert.equal(db.patches.length, 0, 'отказ не трогает durable-state');
});

test('доливка: done-каналу — окно последних 7 дней под durable day-gate, status не меняется', async () => {
  const now = new Date();
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const db = makeDb({
    states: { 7: { channel_id: 7, status: 'done', cursor_from: null, fetched_count: 100, updated_age_seconds: 86400 } },
  });
  const windows = [];
  const { engine } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 100,
      oldestMoment: null,
      byWindow: (from, to) => { windows.push([from, to]); return [order('fresh', `${fmtDay(now)} 09:00:00.000`)]; },
    }),
  });
  const stats = await engine.runTopupPass();
  assert.deepEqual(stats, { channels: 1, orders: 1, errors: 0, skipped: 0 });
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(db.jobKeys, [`ms_orders_topup|7:acc-1:${day}`]);
  assert.deepEqual(windows, [[fmtDay(weekAgo), fmtDay(now)]]);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.patches.length, 0, 'доливка не трогает ms_backfill_state (status/прогресс бэкфилла)');
});

test('доливка: day-gate skip и не-done каналы — без запросов к МС', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const skipDb = makeDb({
    states: { 7: { channel_id: 7, status: 'done', updated_age_seconds: 86400 } },
    skipKeys: [`7:acc-1:${day}`],
  });
  const skipped = makeEngine({ db: skipDb, handlers: () => { throw new Error('не должен ходить в МС'); } });
  assert.deepEqual(await skipped.engine.runTopupPass(), { channels: 0, orders: 0, errors: 0, skipped: 1 });

  const idleDb = makeDb({ states: { 7: { channel_id: 7, status: 'error', updated_age_seconds: 86400 } } });
  const idle = makeEngine({ db: idleDb, handlers: () => { throw new Error('не должен ходить в МС'); } });
  assert.deepEqual(await idle.engine.runTopupPass(), { channels: 0, orders: 0, errors: 0, skipped: 0 });
  assert.equal(idleDb.jobKeys.length, 0, 'error-канал не доливается (сначала здоровый бэкфилл)');
});

test('runMsOrdersPass: resume + topup за один вызов (порядок: сперва resume)', async () => {
  const curMonth = monthStartAt(0);
  const db = makeDb({
    accounts: [ACC, { ...ACC, channel_id: 9, ms_account_id: 'acc-2', access_token_enc: 'enc2' }],
    states: {
      7: { channel_id: 7, status: 'running', cursor_from: fmtDay(curMonth), fetched_count: 1, updated_age_seconds: 3600 },
      9: { channel_id: 9, status: 'done', fetched_count: 50, updated_age_seconds: 86400 },
    },
  });
  const { engine } = makeEngine({
    db,
    handlers: scriptedApi({
      total: 2,
      oldestMoment: null,
      byWindow: () => [order('x', `${fmtDay(curMonth)} 12:00:00.000`)],
    }),
  });
  const out = await engine.runMsOrdersPass();
  assert.deepEqual(out.resume, { resumed: 1, errors: 0 });
  // Свежерезюмированный канал 7 к моменту доливки уже done → тоже доливается (редундантно
  // сегодня, но идемпотентно и ограничено durable day-gate'ом) — сознательная простота движка.
  assert.deepEqual(out.topup, { channels: 2, orders: 2, errors: 0, skipped: 0 });
  assert.equal(db.stateByChannel.get(7).status, 'done', 'зависший бэкфилл дорезюмирован');
  assert.equal(db.stateByChannel.get(9).status, 'done', 'долитый канал остался done');
});

test('resume: недешифруемый токен — warn+skip, строка остаётся running (после починки ключа добёрется)', async () => {
  const db = makeDb({
    accounts: [{ ...ACC, access_token_enc: 'broken' }],
    states: { 7: { channel_id: 7, status: 'running', cursor_from: '2026-01-01', fetched_count: 1, updated_age_seconds: 3600 } },
  });
  const { engine, fetches } = makeEngine({ db, handlers: () => { throw new Error('не должен ходить в МС'); } });
  assert.deepEqual(await engine.resume(), { resumed: 0, errors: 1 });
  assert.equal(fetches.length, 0);
  assert.equal(db.stateByChannel.get(7).status, 'running', 'состояние не сломано — resumable после починки');
});

test('DB off / MS_TOKEN_KEY не задан: start отвергается, resume/topup инертны', async () => {
  const db = makeDb();
  const offDb = { ...db, enabled: false };
  const off = createMsBackfillEngine({
    db: offDb,
    msFetch: async () => { throw new Error('не должен ходить в МС'); },
    msCrypto: { configured: () => true, decrypt: () => 'X' },
    log: () => {},
    sleepFn: async () => {},
  });
  await assert.rejects(off.start(7), /База данных недоступна/);
  assert.deepEqual(await off.resume(), { resumed: 0, errors: 0 });

  const noKey = createMsBackfillEngine({
    db,
    msFetch: async () => { throw new Error('не должен ходить в МС'); },
    msCrypto: { configured: () => false, decrypt: () => 'X' },
    log: () => {},
    sleepFn: async () => {},
  });
  await assert.rejects(noKey.start(7), /MS_TOKEN_KEY/);
  assert.deepEqual(await noKey.runTopupPass(), { channels: 0, orders: 0, errors: 0, skipped: 0 });
});
