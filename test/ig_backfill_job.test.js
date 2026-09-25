'use strict';

// Unit-тесты догрузки истории Instagram (jobs/igBackfillJob). Без сети и без Postgres: Graph —
// программируемый фейк collectIgDailyForDay (или настоящий из instagramCollectionJob поверх фейкового
// igFetch, где важны сами запросы), БД — in-memory фейк с той же семантикой, что у репозиториев:
// COALESCE-upsert ig_daily, частичный upsert состояния, runJobOnce (claim/lease/succeeded/failed).
// Часы инъектируются и якорятся на Date.now() прогона (канон test/helpers/dates).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIgBackfillJob, CALLS_PER_DAY } = require('../server/jobs/igBackfillJob');
const { createInstagramCollectionJob } = require('../server/jobs/instagramCollectionJob');
const { fmtDay, shiftDay } = require('../server/domain/period');

const T0 = Date.now();
const DAY_MS = 86400000;
const TODAY = fmtDay(T0, 'UTC');
const Y = shiftDay(TODAY, -1);          // вчера — день крона
const d = (n) => shiftDay(TODAY, -n);   // n дней назад
const ACC = { channel_id: 7, ig_user_id: 'IG7', access_token_enc: 'enc', token_expires_at: null };

// ── In-memory БД ─────────────────────────────────────────────────────────────────────────────────
function fakeDb({ accounts = [ACC], daily = {}, state = {}, sourceOf = { IG7: 1 } } = {}) {
  const st = new Map(Object.entries(state).map(([k, v]) => [Number(k), { ...v }]));
  const rows = new Map();   // `${ch}:${day}` → row (с source_id)
  for (const [ch, list] of Object.entries(daily)) {
    for (const r of list) rows.set(`${ch}:${r.day}`, { source_id: sourceOf.IG7, ...r });
  }
  const jobs = new Map();   // `${kind}|${key}` → { status }
  const log = { writes: [], claims: [], statePatches: [] };
  const hasData = (r) => r && (r.reach != null || r.views != null || r.total_interactions != null);
  const accOf = (ch) => accounts.find((a) => a.channel_id === ch);
  const db = {
    enabled: true,
    st, rows, jobs, log,
    async getIgAccount(ch) { return accOf(ch) || null; },
    async getIgBackfillState(ch) { return st.has(ch) ? { ...st.get(ch) } : null; },
    async setIgBackfillState(ch, patch, expect = null) {
      // Как репозиторий: патч без ig_user_id — только UPDATE существующей строки (NOT NULL);
      // expect — условие той же идентичности и эпохи (started_at до секунды).
      if (!st.has(ch) && !('ig_user_id' in patch)) return false;
      if (expect?.ig_user_id != null && !('ig_user_id' in patch)) {
        const cur = st.get(ch);
        const sec = (v) => (v == null ? null : Math.floor(new Date(v).getTime() / 1000));
        if (cur.ig_user_id !== expect.ig_user_id) return false;
        if (expect.started_at != null && sec(cur.started_at) !== sec(expect.started_at)) return false;
      }
      log.statePatches.push({ ch, patch: { ...patch } });
      st.set(ch, { status: 'idle', empty_streak: 0, day_attempts: 0, days_fetched: 0, days_with_data: 0, calls_count: 0, ...(st.get(ch) || {}), ...patch });
      return true;
    },
    async listIgBackfillCandidates(limit, opts = {}) {
      // restart: done без данных той же идентичности, аккаунт обновлён после finished_at (reconnect).
      const restart = (a, s) => s.status === 'done' && s.ig_user_id === a.ig_user_id
        && (!s.horizon_day || !(Number(s.days_with_data) > 0))
        && a.updated_at != null && a.updated_at > new Date(s.finished_at ?? 0).getTime();
      return accounts.filter((a) => {
        const s = st.get(a.channel_id);
        const eligible = !s || s.ig_user_id !== a.ig_user_id || s.status === 'idle' || s.status === 'running'
          || (s.status === 'error' && s.retry === true) || restart(a, s);
        if (!eligible) return false;
        // Выбравший дневной бюджет (та же идентичность, тот же UTC-день) — не кандидат.
        if (s && opts.day && s.ig_user_id === a.ig_user_id && s.calls_day === opts.day && s.calls_count > opts.maxCalls) return false;
        return true;
      }).map((a) => {
        const s = st.get(a.channel_id);
        return { ...a, restart_done: !!(s && s.status === 'done' && s.ig_user_id === a.ig_user_id) };
      }).slice(0, limit);
    },
    async listIgHealCandidates(limit, day) {
      // Как SQL: уже вылеченные за `day` исключены; не пробованные сегодня — первыми.
      const healJob = (a) => (day ? jobs.get(`ig_daily_heal|${a.channel_id}:${a.ig_user_id}:${day}`) : null);
      return accounts.filter((a) => {
        const s = st.get(a.channel_id);
        return s && s.ig_user_id === a.ig_user_id && s.status === 'done' && healJob(a)?.status !== 'succeeded';
      }).sort((a, b) => (healJob(a) ? 1 : 0) - (healJob(b) ? 1 : 0))
        .map((a) => ({ ...a, horizon_day: st.get(a.channel_id).horizon_day || null })).slice(0, limit);
    },
    async listIgDayStatus(ch, from, to) {
      const src = sourceOf[accOf(ch)?.ig_user_id];
      const out = [];
      for (const [k, r] of rows) {
        const [c, day] = k.split(':');
        if (Number(c) !== ch || day < from || day > to) continue;
        const foreign = r.source_id != null && src != null && r.source_id !== src;
        out.push({ day, is_foreign: foreign, occupied: hasData(r) || foreign, incomplete: r.reach == null && r.views == null && !foreign });
      }
      return out.sort((a, b) => (a.day < b.day ? -1 : 1));
    },
    async upsertIgDaily(ch, list, _executor, opts = {}) {
      log.writes.push({ ch, rows: list.map((r) => ({ ...r })), opts });
      const src = sourceOf[accOf(ch)?.ig_user_id];
      let n = 0;
      for (const r of list) {
        const k = `${ch}:${r.day}`;
        const prev = rows.get(k);
        if (prev && opts.guardSource && prev.source_id != null && prev.source_id !== src) continue;
        const next = { ...(prev || {}), source_id: src };
        for (const [f, v] of Object.entries(r)) if (v != null) next[f] = v;   // COALESCE
        rows.set(k, next);
        n++;
      }
      return n;
    },
    async getJob(kind, key) { const j = jobs.get(`${kind}|${key}`); return j ? { ...j } : null; },
    async runJobOnce(kind, key, fn) {
      const id = `${kind}|${key}`;
      log.claims.push(id);
      const j = jobs.get(id);
      if (j && (j.status === 'succeeded' || j.status === 'running')) return { skipped: true, job: { ...j } };
      jobs.set(id, { status: 'running' });
      try {
        const result = await fn();
        jobs.set(id, { status: 'succeeded', result });
        return { skipped: false, result };
      } catch (e) {
        jobs.set(id, { status: 'failed', error: e.message });
        throw e;
      }
    },
  };
  return db;
}

// ── Фейковый Graph-уровень дня ───────────────────────────────────────────────────────────────────
// plan(day, opts, n) → 'data' | 'empty' | 'transient' | 'reauth' | { throw } | row-объект.
function fakeCollect(plan = () => 'data') {
  const calls = [];
  const counter = new Map();
  const fn = async (_acc, token, day, opts) => {
    const n = (counter.get(day) || 0) + 1;
    counter.set(day, n);
    calls.push({ day, opts: { ...opts }, token });
    const p = plan(day, opts, n);
    if (p?.throw) throw p.throw;
    if (p && typeof p === 'object') return { row: { day, ...p }, outcome: 'data', calls: CALLS_PER_DAY };
    const row = p === 'data' ? { day, reach: 10, views: 20, total_interactions: 3, followers_total: 999 } : { day };
    return { row, outcome: p, calls: CALLS_PER_DAY };
  };
  return { fn, calls };
}

function throttle() { const e = new Error('rate limited'); e.status = 429; return e; }

function makeJob({ db = fakeDb(), collect = fakeCollect(), limits = {}, gate, clock, decrypt, events } = {}) {
  const logs = events || [];
  const job = createIgBackfillJob({
    db,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    igCrypto: { configured: () => true, decrypt: decrypt || (() => 'TOKEN') },
    refreshIgIfNeeded: async (_c, t) => t,
    collectIgDailyForDay: collect.fn,
    usageGate: gate || { shouldStopPass: () => false, lastBucUsagePct: () => 0 },
    limits: { daysPerPass: 3, ...limits },
    now: clock || (() => T0),
  });
  return { job, db, collect, logs };
}

// ── Проход догрузки ──────────────────────────────────────────────────────────────────────────────

test('обход: от вчера−1 назад, новые дни первыми, daysPerPass за проход, чекпойнт после каждого дня', async () => {
  const { job, db, collect } = makeJob();
  const stats = await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(3), d(4)], 'вчера — день крона, его не трогаем');
  const s = db.st.get(7);
  assert.equal(s.status, 'running');
  assert.equal(s.cursor_day, d(5), 'курсор на следующем, более старом дне');
  assert.equal(s.floor_day, shiftDay(Y, -730), 'глубина опроса — IG_BACKFILL_MAX_DAYS');
  assert.equal(s.days_fetched, 3);
  assert.equal(s.days_with_data, 3);
  assert.equal(s.horizon_day, d(4));
  const cursors = db.log.statePatches.filter((p) => 'cursor_day' in p.patch).map((p) => p.patch.cursor_day);
  assert.deepEqual(cursors, [d(2), d(3), d(4), d(5)], 'сброс + чекпойнт после каждого сходившего дня');
  assert.equal(stats.fetched, 3);
  assert.equal(stats.calls, 3 * CALLS_PER_DAY);
  assert.deepEqual(db.log.claims, [`ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`], 'чанк под ключом ch:ig_user:эпоха:cursor_day');
});

test('день с данными в архиве пропускается без единого вызова Graph', async () => {
  const db = fakeDb({ daily: { 7: [{ day: d(2), reach: 5 }, { day: d(3), views: 1 }] } });
  const { job, collect } = makeJob({ db });
  await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(4), d(5), d(6)], 'занятые дни — бесплатно, бюджет дней не тратят');
  assert.equal(db.st.get(7).horizon_day, d(6));
  assert.ok(!db.log.writes.some((w) => w.rows.some((r) => r.day === d(2) || r.day === d(3))), 'архив не перезаписан');
});

test('follower_count просим только для последних 30 дней; уровень базы бэкфилл не шлёт никогда', async () => {
  const graph = [];
  const collection = createInstagramCollectionJob({
    db: {}, log: () => {}, igCrypto: {}, refreshIgIfNeeded: async (_c, t) => t,
    igFetch: async (path, params) => {
      graph.push({ path, params });
      if (path === '/IG7/insights' && String(params.metric).startsWith('reach') && !params.metric_type) {
        return { data: [{ name: 'reach', values: [{ value: 7 }] }, { name: 'follower_count', values: [{ value: 2 }] }] };
      }
      return { data: [] };
    },
  });
  const db = fakeDb({ state: { 7: { ig_user_id: 'IG7', status: 'running', cursor_day: d(28), floor_day: d(800) } } });
  const { job } = makeJob({ db, collect: { fn: collection.collectIgDailyForDay, calls: [] } });
  await job.runIgBackfillPass();
  const series = graph.filter((g) => !g.params.metric_type).map((g) => ({ day: fmtDay(g.params.since * 1000, 'UTC'), metric: g.params.metric }));
  assert.deepEqual(series, [
    { day: d(28), metric: 'reach,follower_count' },
    { day: d(29), metric: 'reach,follower_count' },
    { day: d(30), metric: 'reach' },
  ]);
  assert.ok(!graph.some((g) => g.path === '/IG7'), 'профильный followers_count не запрашивается');
  for (const w of db.log.writes) {
    assert.ok(w.rows.every((r) => !('followers_total' in r)), 'followers_total в строке бэкфилла нет — якорь крона цел');
    assert.deepEqual(w.opts, { guardSource: true, igUserId: 'IG7' }, 'страж идентичности на каждой записи');
  }
});

test('страж идентичности: день чужого аккаунта не тратит вызовов и не перезаписывается', async () => {
  const db = fakeDb({ daily: { 7: [{ day: d(2), source_id: 99 }] }, sourceOf: { IG7: 1 } });
  const { job, collect } = makeJob({ db });
  await job.runIgBackfillPass();
  assert.ok(!collect.calls.some((c) => c.day === d(2)), 'чужой день считается занятым');
  assert.equal(db.rows.get(`7:${d(2)}`).source_id, 99);
  assert.equal(db.rows.get(`7:${d(2)}`).reach, undefined, 'чужая строка не получила наших значений');
});

test('пропуск остаётся null: пустой день не пишется, 7 пустых подряд = горизонт, дальше не ходим', async () => {
  const collect = fakeCollect((day) => (day >= d(3) ? 'data' : 'empty'));
  const { job, db } = makeJob({ collect, limits: { daysPerPass: 50 } });
  const stats = await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(3), d(4), d(5), d(6), d(7), d(8), d(9), d(10)]);
  const written = db.log.writes.flatMap((w) => w.rows.map((r) => r.day));
  assert.deepEqual(written, [d(2), d(3)], 'пустые дни в архив не попали — никаких выдуманных нулей');
  assert.equal(db.rows.has(`7:${d(4)}`), false);
  const s = db.st.get(7);
  assert.equal(s.status, 'done');
  assert.equal(s.horizon_day, d(3), 'горизонт — самый старый день, за который Graph отдал данные');
  assert.ok(s.finished_at instanceof Date);
  assert.equal(stats.done, 1);
  collect.calls.length = 0;
  await job.runIgBackfillPass();
  assert.ok(collect.calls.every((c) => c.day === d(2) || c.day === d(3)),
    'done-аккаунт больше не обходится: дальше только дневной ремонт (доливка вчера−1/−2, дыры в окне)');
});

test('глубже floor_day не опрашиваем (IG_BACKFILL_MAX_DAYS — граница опроса)', async () => {
  const collect = fakeCollect();
  const { job, db } = makeJob({ collect, limits: { maxDays: 4, daysPerPass: 50 } });
  await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(3), d(4), d(5)]);
  assert.equal(db.st.get(7).status, 'done');
});

test('идемпотентность: повторный прогон по заполненному архиву — ноль вызовов и ноль записей', async () => {
  let t = T0;
  const collect = fakeCollect();
  const { job, db } = makeJob({ collect, clock: () => t, limits: { maxDays: 6, daysPerPass: 50 } });
  await job.runIgBackfillPass();
  t += 60_000;   // новый проход — новая эпоха (started_at сброса)
  const firstCalls = collect.calls.length;
  const snapshot = JSON.stringify([...db.rows]);
  // Тот же архив, новое состояние (например, после сброса идентичности на ту же историю).
  db.st.delete(7);
  const writesBefore = db.log.writes.length;
  await job.runIgBackfillPass();
  assert.equal(collect.calls.length, firstCalls, 'дни уже в архиве — Graph не зовётся');
  assert.equal(db.log.writes.length, writesBefore, 'ни одной новой записи');
  assert.equal(JSON.stringify([...db.rows]), snapshot, 'архив байт-в-байт тот же');
  assert.equal(db.st.get(7).status, 'done');
});

test('throttle: чекпойнт до проброса, весь проход останавливается, чанк повторяем с того же дня', async () => {
  const collect = fakeCollect((day, _o, n) => (day === d(3) && n === 1 ? { throw: throttle() } : 'data'));
  const db = fakeDb({ accounts: [ACC, { ...ACC, channel_id: 8, ig_user_id: 'IG8' }] });
  const { job } = makeJob({ db, collect });
  const stats = await job.runIgBackfillPass();
  assert.equal(stats.stopped, 'throttle');
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(3)], 'второй аккаунт в этом проходе не тронут');
  assert.equal(db.st.has(8), false);
  const s = db.st.get(7);
  assert.equal(s.cursor_day, d(3), 'курсор стоит на неудавшемся дне');
  assert.equal(s.calls_count, 2 * CALLS_PER_DAY, 'квота упавшего дня учтена оценкой');
  assert.equal(db.jobs.get(`ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`).status, 'failed', 'чанк failed → повторяемый');
  collect.calls.length = 0;
  await job.runIgBackfillPass();
  assert.equal(collect.calls[0].day, d(3), 'следующий проход продолжает с того же дня');
});

test('открытый app-gate или BUC ≥ порога — проход не делает ни одного вызова', async () => {
  const a = makeJob({ gate: { shouldStopPass: () => true, lastBucUsagePct: () => 0 } });
  assert.equal((await a.job.runIgBackfillPass()).stopped, 'gate');
  assert.equal(a.collect.calls.length, 0);
  const b = makeJob({ gate: { shouldStopPass: () => false, lastBucUsagePct: () => 75 } });
  assert.equal((await b.job.runIgBackfillPass()).stopped, 'buc');
  assert.equal(b.collect.calls.length, 0);
  assert.equal(b.db.log.claims.length, 0, 'ни одного claim');
});

test('BUC растёт посреди чанка — останавливаемся после текущего дня, прогресс сохранён', async () => {
  let buc = 10;
  const collect = fakeCollect(() => { buc = 90; return 'data'; });
  const { job, db } = makeJob({ collect, gate: { shouldStopPass: () => false, lastBucUsagePct: () => buc } });
  const stats = await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 1);
  assert.equal(stats.stopped, 'buc');
  assert.equal(db.st.get(7).cursor_day, d(3));
  assert.equal(db.jobs.get(`ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`).status, 'succeeded');
});

test('время прохода исчерпано — стоп после текущего дня', async () => {
  let t = T0;
  const collect = fakeCollect(() => { t += 200_000; return 'data'; });
  const { job } = makeJob({ collect, clock: () => t, limits: { passBudgetMs: 240_000, daysPerPass: 10 } });
  const stats = await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 2);
  assert.equal(stats.stopped, 'pass_budget');
});

test('умерший токен (reauth): error ig_reauth, дальше не ходим', async () => {
  const collect = fakeCollect((day, _o, n) => (day === d(3) && n === 1 ? 'reauth' : 'data'));
  const { job, db, logs } = makeJob({ collect });
  await job.runIgBackfillPass();
  const s = db.st.get(7);
  assert.equal(s.status, 'error');
  assert.equal(s.error, 'ig_reauth');
  assert.equal(s.cursor_day, d(3), 'курсор не сдвинут — после переподключения продолжим с этого дня');
  assert.ok(logs.some((l) => l.event === 'ig_backfill_reauth'));
  collect.calls.length = 0;
  await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 0, 'error-аккаунт не кандидат, пока нет reconnect/суток');
  db.st.get(7).retry = true;   // репозиторий вернул его в кандидаты (reconnect или >24 ч)
  await job.runIgBackfillPass();
  assert.equal(collect.calls[0].day, d(3), 'после переподключения догрузка продолжается с места');
  assert.equal(db.st.get(7).error, null);
});

test('reauth на первом дне чанка: чанк остаётся повторяемым — после переподключения тот же день', async () => {
  const collect = fakeCollect((day, _o, n) => (day === d(2) && n === 1 ? 'reauth' : 'data'));
  const { job, db } = makeJob({ collect });
  await job.runIgBackfillPass();
  assert.equal(db.st.get(7).error, 'ig_reauth');
  assert.equal(db.jobs.get(`ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`).status, 'failed', 'ключ того же курсора не «выполнен»');
  db.st.get(7).retry = true;   // переподключение
  await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(2), d(3), d(4)], 'догрузка продолжилась с того же дня');
  assert.equal(db.st.get(7).status, 'running');
});

test('временный сбой: два раза — стоп и повтор того же дня, третий — день пропущен, идём дальше', async () => {
  const collect = fakeCollect((day) => (day === d(2) ? 'transient' : 'data'));
  const { job, db, logs } = makeJob({ collect });
  await job.runIgBackfillPass();
  assert.equal(db.st.get(7).day_attempts, 1);
  assert.equal(db.st.get(7).cursor_day, d(2));
  await job.runIgBackfillPass();
  assert.equal(db.st.get(7).day_attempts, 2);
  await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(2), d(2), d(3), d(4)]);
  assert.ok(logs.some((l) => l.event === 'ig_backfill_day_skipped' && l.fields.day === d(2)));
  assert.equal(db.rows.has(`7:${d(2)}`), false, 'дыра осталась дырой — её подберёт ремонт');
  assert.deepEqual(db.log.claims.slice(0, 3), [
    `ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`, `ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a1`, `ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a2`,
  ], 'каждая попытка — свой ключ чанка');
});

test('дневной бюджет вызовов: стоп на аккаунте, повтор без вызовов, продолжение на следующие UTC-сутки', async () => {
  let t = T0;
  const collect = fakeCollect();
  const { job, db } = makeJob({ collect, clock: () => t, limits: { dailyCalls: 2 * CALLS_PER_DAY + 5, daysPerPass: 10 } });
  await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 2);
  const key = `ig_backfill_chunk|7:IG7:${T0}:${d(4)}:a0`;
  await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 2, 'бюджет исчерпан — ни одного вызова');
  assert.equal(db.jobs.has(key), false, 'выбравший бюджет аккаунт — не кандидат прохода: ни claim, ни слота');
  await job.kickIgBackfill(7);
  assert.equal(collect.calls.length, 2, 'kick тоже упирается в бюджет');
  assert.equal(db.jobs.get(key).status, 'failed', 'чанк без продвижения остаётся повторяемым');
  t += DAY_MS;
  await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 4, 'новые UTC-сутки — новый бюджет');
});

test('смена IG-идентичности канала сбрасывает проход', async () => {
  const db = fakeDb({ state: { 7: { ig_user_id: 'OLD', status: 'done', cursor_day: d(300), floor_day: d(900), horizon_day: d(250), days_fetched: 40 } } });
  const { job, collect } = makeJob({ db });
  await job.runIgBackfillPass();
  const s = db.st.get(7);
  assert.equal(s.ig_user_id, 'IG7');
  assert.equal(collect.calls[0].day, d(2), 'новая идентичность — с вчера−1');
  assert.equal(s.days_fetched, 3, 'счётчики с нуля');
  assert.equal(s.horizon_day, d(4));
});

test('дешифровка до claim: битый ключ — error token_decrypt, ни claim, ни вызовов', async () => {
  const { job, db, collect } = makeJob({ decrypt: () => { throw new Error('bad key'); } });
  await job.runIgBackfillPass();
  assert.equal(db.log.claims.length, 0);
  assert.equal(collect.calls.length, 0);
  assert.equal(db.st.get(7).status, 'error');
  assert.equal(db.st.get(7).error, 'token_decrypt');
});

test('kick и проход делят ключ чанка: одновременный проход не дублирует работу', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  let first = true;
  const collect = { calls: [], fn: async (_acc, _token, day) => {
    collect.calls.push({ day });
    if (first) { first = false; await hold; }
    return { row: { day, reach: 1 }, outcome: 'data', calls: CALLS_PER_DAY };
  } };
  const { job, db } = makeJob({ collect });
  const kick = job.kickIgBackfill(7);
  for (let i = 0; i < 20 && collect.calls.length === 0; i++) await new Promise((r) => setImmediate(r));
  const pass = await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 1, 'проход упёрся в lease kick-а и не пошёл в Graph');
  assert.equal(pass.fetched, 0);
  release();
  const k = await kick;
  assert.equal(k.kicked, 'walk');
  assert.equal(collect.calls.length, 3);
  assert.deepEqual([...new Set(db.log.claims)], [`ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`]);
});

test('выключатель и отсутствие ключа шифрования — проход инертен', async () => {
  const off = makeJob({ limits: { enabled: false } });
  assert.equal((await off.job.runIgBackfillPass()).disabled, true);
  assert.equal(off.collect.calls.length, 0);
  const noKey = createIgBackfillJob({
    db: fakeDb(), igCrypto: { configured: () => false }, collectIgDailyForDay: async () => { throw new Error('no'); },
  });
  assert.equal((await noKey.runIgBackfillPass()).disabled, true);
  assert.deepEqual(await off.job.kickIgBackfill(7), { skipped: true });
});

// ── Дневной ремонт и доливка лага ────────────────────────────────────────────────────────────────

function doneState(extra = {}) {
  return { 7: { ig_user_id: 'IG7', status: 'done', cursor_day: d(100), floor_day: d(731), horizon_day: d(60), ...extra } };
}

test('ремонт: доливка вчера−1/−2 перезаписывает, дыры и неполные дни окна добираются, свежие первыми', async () => {
  const archive = [];
  for (let n = 2; n <= 60; n++) archive.push({ day: d(n), reach: 1, views: 1 });
  const holes = new Set([d(5), d(9)]);
  const daily = { 7: archive.filter((r) => !holes.has(r.day)).map((r) => (r.day === d(12) ? { day: r.day, total_interactions: 4 } : r)) };
  const db = fakeDb({ daily, state: doneState() });
  const collect = fakeCollect(() => ({ reach: 50, views: 60 }));
  const { job } = makeJob({ db, collect });
  const stats = await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(3), d(5), d(9), d(12)],
    'доливка лага, затем дыры и неполный день (нет ни reach, ни views)');
  assert.equal(db.rows.get(`7:${d(2)}`).reach, 50, 'доливка лага перезаписывает финализированным значением');
  assert.equal(db.rows.get(`7:${d(5)}`).reach, 50);
  assert.equal(stats.healed, 1);
  collect.calls.length = 0;
  await job.runIgBackfillPass();
  assert.equal(collect.calls.length, 0, 'ремонт — раз в UTC-сутки');
});

test('ремонт: честно пустой день запоминается memo и не перезапрашивается на следующие сутки', async () => {
  let t = T0;
  const daily = { 7: [] };
  for (let n = 2; n <= 40; n++) if (n !== 20) daily[7].push({ day: d(n), reach: 1 });
  const db = fakeDb({ daily, state: doneState({ horizon_day: d(40) }) });
  const collect = fakeCollect((day) => (day === d(20) ? 'empty' : { reach: 2 }));
  const { job } = makeJob({ db, collect, clock: () => t });
  await job.runIgBackfillPass();
  assert.ok(collect.calls.some((c) => c.day === d(20)));
  assert.equal(db.rows.has(`7:${d(20)}`), false, 'пустой день так и остался дырой, не нулём');
  collect.calls.length = 0;
  t += DAY_MS;
  await job.runIgBackfillPass();
  assert.ok(!collect.calls.some((c) => c.day === d(20)), 'memo ig_day_repair: пустой день не жжёт квоту каждые сутки');
});

test('ремонт не выходит за горизонт и окно 85 дней', async () => {
  const db = fakeDb({ daily: { 7: [] }, state: doneState({ horizon_day: d(5) }) });
  const collect = fakeCollect(() => 'empty');
  const { job } = makeJob({ db, collect });
  await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(3), d(4), d(5)], 'старше горизонта Graph не спрашиваем');
});

// ── Ревью: преждевременный done, чужие дни, гонка идентичностей, окно ремонта, бюджет ─────────────

// Настоящий collectIgDailyForDay поверх программируемого igFetch — где важна классификация дня.
function realCollect(igFetch) {
  const collection = createInstagramCollectionJob({
    db: {}, log: () => {}, igCrypto: {}, refreshIgIfNeeded: async (_c, t) => t, igFetch,
  });
  const calls = [];
  return {
    calls,
    fn: async (acc, token, day, opts) => {
      calls.push({ day, ch: acc.channel_id });
      return collection.collectIgDailyForDay(acc, token, day, opts);
    },
  };
}
const graphErr = (status, code) => Object.assign(new Error(`graph #${code}`), { status, igCode: code, graph: { code } });
const zeroGraph = async (_path, params) => {
  if (params.metric_type == null) {
    return { data: String(params.metric).split(',').map((name) => ({ name, values: [{ value: 0 }] })) };
  }
  if (params.metric === 'follows_and_unfollows') {
    return { data: [{ total_value: { breakdowns: [{ results: [
      { dimension_values: ['FOLLOWER'], value: 0 }, { dimension_values: ['NON_FOLLOWER'], value: 0 }] }] } }] };
  }
  return { data: [{ total_value: { value: 0 } }] };
};

test('честные нули Graph — данные: пишутся, как у крона, и не складываются в ложный горизонт', async () => {
  const collect = realCollect(zeroGraph);
  const { job, db } = makeJob({ collect, limits: { daysPerPass: 10 } });
  await job.runIgBackfillPass();
  const s = db.st.get(7);
  assert.notEqual(s.status, 'done', '10 тихих дней подряд — не край истории');
  assert.equal(s.empty_streak, 0);
  assert.equal(s.days_with_data, 10);
  assert.equal(s.horizon_day, d(11));
  const row = db.rows.get(`7:${d(5)}`);
  assert.equal(row.reach, 0, 'ноль Graph сохранён нулём, а не дырой');
  assert.equal(row.follows, 0);
});

test('отказ в правах (#10) — не пустой день: error ig_permission, курсор стоит, done не наступает', async () => {
  let denied = true;
  const collect = realCollect(async (path, params) => {
    if (denied) throw graphErr(502, 10);
    return zeroGraph(path, params);
  });
  const { job, db, logs } = makeJob({ collect, limits: { daysPerPass: 50 } });
  for (let i = 0; i < 10; i++) {
    await job.runIgBackfillPass();
    db.st.get(7).retry = true;   // сутки прошли / переподключили
  }
  const s = db.st.get(7);
  assert.equal(s.status, 'error');
  assert.equal(s.error, 'ig_permission');
  assert.equal(s.cursor_day, d(2), 'курсор не уехал за «пустыми» днями');
  assert.equal(s.empty_streak, 0, 'отказ не считается пустым днём');
  assert.equal(db.jobs.get(`ig_backfill_chunk|7:IG7:${T0}:${d(2)}:a0`).status, 'failed', 'чанк повторяем');
  assert.ok(logs.some((l) => l.event === 'ig_backfill_permission_denied'));
  denied = false;   // права вернули
  await job.runIgBackfillPass();
  assert.equal(db.st.get(7).status, 'running');
  assert.equal(db.rows.get(`7:${d(2)}`).reach, 0, 'догрузка пошла с того же дня');
});

test('ремонт: отказ в правах не записывает день как «честно пустой» — memo дня остаётся повторяемым', async () => {
  const collect = realCollect(async () => { throw graphErr(502, 200); });
  const db = fakeDb({ daily: { 7: [] }, state: doneState({ horizon_day: d(10) }) });
  const { job } = makeJob({ db, collect });
  await job.runIgBackfillPass();
  assert.equal(db.st.get(7).error, 'ig_permission');
  assert.ok(![...db.jobs.entries()].some(([k, v]) => k.startsWith('ig_day_repair|') && v.status === 'succeeded'),
    'ни один отказанный день не помечен выполненным');
});

test('done без единого дня с данными: переподключение (kick или updated_at > finished_at) начинает проход заново', async () => {
  const stale = { ig_user_id: 'IG7', status: 'done', cursor_day: d(16), floor_day: d(731), horizon_day: null,
    empty_streak: 7, days_fetched: 7, days_with_data: 0, started_at: new Date(T0 - 2 * DAY_MS), finished_at: new Date(T0 - DAY_MS) };
  // (а) OAuth-kick того же аккаунта.
  const a = makeJob({ db: fakeDb({ state: { 7: { ...stale } } }) });
  const k = await a.job.kickIgBackfill(7);
  assert.equal(k.kicked, 'walk', 'не только ремонт окна 85 дней');
  assert.deepEqual(a.collect.calls.map((c) => c.day), [d(2), d(3), d(4)], 'обход с вчера−1 заново');
  assert.equal(a.db.st.get(7).status, 'running');
  // (б) проход бегунка: аккаунт обновлён после finished_at (переподключение/продление токена).
  const accounts = [{ ...ACC, updated_at: T0 }];
  const b = makeJob({ db: fakeDb({ accounts, state: { 7: { ...stale } } }) });
  await b.job.runIgBackfillPass();
  assert.equal(b.collect.calls[0].day, d(2));
  assert.equal(b.db.st.get(7).days_with_data, 3);
  // (в) done С горизонтом — kick лишь лечит, проход не перезапускается.
  const c = makeJob({ db: fakeDb({ state: doneState({ days_with_data: 40 }) }) });
  assert.equal((await c.job.kickIgBackfill(7)).kicked, 'heal');
});

test('дни прежнего аккаунта: пропуск без вызовов, но горизонт — только по своим дням', async () => {
  const daily = { 7: [] };
  for (let n = 2; n <= 60; n++) daily[7].push({ day: d(n), reach: 5, source_id: 2 });   // прежний аккаунт
  const db = fakeDb({ daily, sourceOf: { IG7: 1 } });
  const collect = fakeCollect((day) => (day >= d(30) ? 'data' : 'empty'));
  const { job } = makeJob({ db, collect, limits: { daysPerPass: 50 } });
  for (let i = 0; i < 4 && db.st.get(7)?.status !== 'done'; i++) await job.runIgBackfillPass();
  const s = db.st.get(7);
  assert.equal(s.status, 'done');
  const walked = collect.calls.map((c) => c.day).filter((day) => day !== d(2) && day !== d(3));
  assert.ok(walked.every((day) => day < d(60)), 'дни прежнего аккаунта не запрашивались');
  assert.equal(s.horizon_day, null, 'горизонт не выведен из чужих строк (было: первый день прежнего аккаунта)');
  assert.equal(s.days_with_data, 0);
});

test('гонка переподключения: чанк прежнего аккаунта не перезаписывает состояние нового', async () => {
  const accounts = [{ ...ACC, ig_user_id: 'IGA' }];
  const db = fakeDb({ accounts, sourceOf: { IGA: 1, IGB: 2 } });
  let release;
  const hold = new Promise((r) => { release = r; });
  let heldOnce = false;
  const calls = [];
  const collect = { calls, fn: async (acc, _token, day) => {
    calls.push({ ig: acc.ig_user_id, day });
    if (acc.ig_user_id === 'IGA') {
      if (!heldOnce) { heldOnce = true; await hold; }
      return { row: { day }, outcome: 'empty', calls: CALLS_PER_DAY };
    }
    return { row: { day, reach: 7 }, outcome: 'data', calls: CALLS_PER_DAY };
  } };
  const { job } = makeJob({ db, collect, limits: { daysPerPass: 10 } });
  const kickA = job.kickIgBackfill(7);
  for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise((r) => setImmediate(r));
  accounts[0] = { ...ACC, ig_user_id: 'IGB' };   // пользователь переподключил другой аккаунт
  await job.kickIgBackfill(7);
  const afterB = { ...db.st.get(7) };
  assert.equal(afterB.ig_user_id, 'IGB');
  release();
  const a = await kickA;
  assert.equal(a.stopped, 'identity_changed', 'чанк прежнего аккаунта оборвался на первом чекпойнте');
  const s = db.st.get(7);
  assert.equal(s.ig_user_id, 'IGB');
  assert.equal(s.status, 'running', 'новый аккаунт не помечен done чужими пустыми днями');
  assert.equal(s.cursor_day, afterB.cursor_day);
  assert.equal(s.horizon_day, afterB.horizon_day);
  assert.equal(s.days_with_data, 10);
});

test('ремонт доходит до всех done-аккаунтов: вылеченные сегодня не занимают окно кандидатов', async () => {
  const accounts = [];
  const state = {};
  for (let ch = 1; ch <= 30; ch++) {
    accounts.push({ ...ACC, channel_id: ch, ig_user_id: `IG${ch}` });
    state[ch] = { ig_user_id: `IG${ch}`, status: 'done', cursor_day: d(100), floor_day: d(731), horizon_day: d(3), days_with_data: 5 };
  }
  const sourceOf = Object.fromEntries(accounts.map((a) => [a.ig_user_id, a.channel_id]));
  const db = fakeDb({ accounts, state, sourceOf });
  const healed = new Set();
  const collect = { calls: [], fn: async (acc, _t, day) => {
    healed.add(acc.channel_id);
    return { row: { day, reach: 1 }, outcome: 'data', calls: CALLS_PER_DAY };
  } };
  const { job } = makeJob({ db, collect });
  await job.runIgBackfillPass();
  await job.runIgBackfillPass();
  assert.equal(healed.size, 30, 'за два прохода вылечены все 30, а не одни и те же первые 25');
});

test('throttle одного аккаунта (80002) в ремонте — пропуск аккаунта, остальные лечатся', async () => {
  const accounts = [1, 2, 3].map((ch) => ({ ...ACC, channel_id: ch, ig_user_id: `IG${ch}` }));
  const state = Object.fromEntries(accounts.map((a) => [a.channel_id,
    { ig_user_id: a.ig_user_id, status: 'done', cursor_day: d(100), floor_day: d(731), horizon_day: d(3), days_with_data: 5 }]));
  const db = fakeDb({ accounts, state, sourceOf: { IG1: 1, IG2: 2, IG3: 3 } });
  const healed = new Set();
  const collect = { calls: [], fn: async (acc, _t, day) => {
    if (acc.channel_id === 1) throw Object.assign(new Error('BUC'), { status: 429, igCode: 80002 });
    healed.add(acc.channel_id);
    return { row: { day, reach: 1 }, outcome: 'data', calls: CALLS_PER_DAY };
  } };
  const { job } = makeJob({ db, collect });
  const stats = await job.runIgBackfillPass();
  assert.deepEqual([...healed].sort(), [2, 3]);
  assert.equal(stats.stopped, null, 'проход не остановлен лимитом одного аккаунта');
  assert.equal(db.jobs.get(`ig_daily_heal|1:IG1:${TODAY}`).status, 'failed', 'ремонт аккаунта 1 остаётся повторяемым');
});

test('выбравшие дневной бюджет аккаунты не занимают слоты прохода', async () => {
  const accounts = [7, 8, 9, 10].map((ch) => ({ ...ACC, channel_id: ch, ig_user_id: `IG${ch}` }));
  const state = {};
  for (const ch of [7, 8, 9]) {
    state[ch] = { ig_user_id: `IG${ch}`, status: 'running', cursor_day: d(2), floor_day: d(731), calls_day: TODAY, calls_count: 1495 };
  }
  const db = fakeDb({ accounts, state, sourceOf: { IG7: 7, IG8: 8, IG9: 9, IG10: 10 } });
  const seen = [];
  const collect = { calls: [], fn: async (acc, _t, day) => {
    seen.push(acc.channel_id);
    return { row: { day, reach: 1 }, outcome: 'data', calls: CALLS_PER_DAY };
  } };
  const { job } = makeJob({ db, collect, limits: { accountsPerPass: 3, dailyCalls: 1500 } });
  await job.runIgBackfillPass();
  assert.ok(seen.includes(10), 'аккаунт 10 продвигается, хотя 7–9 до полуночи стоят на бюджете');
  assert.ok(!seen.some((ch) => ch !== 10));
});

test('ремонт, остановленный раньше конца (время прохода), не помечает день вылеченным — доделывается', async () => {
  let t = T0;
  const archive = [];
  for (let n = 2; n <= 60; n++) archive.push({ day: d(n), reach: 1, views: 1 });
  const db = fakeDb({ daily: { 7: archive }, state: doneState() });
  const collect = fakeCollect((day, _o, n) => {
    if (day === d(2) && n === 1) t += 250_000;   // первая доливка съела время прохода
    return { reach: 9, views: 9 };
  });
  const { job } = makeJob({ db, collect, clock: () => t });
  const first = await job.runIgBackfillPass();
  assert.equal(first.stopped, 'pass_budget');
  assert.equal(db.jobs.get(`ig_daily_heal|7:IG7:${TODAY}`).status, 'failed', 'день ремонта не «succeeded» после частичной доливки');
  await job.runIgBackfillPass();
  assert.deepEqual(collect.calls.map((c) => c.day), [d(2), d(2), d(3)], 'следующий проход доделал доливку вчера−2');
  assert.equal(db.jobs.get(`ig_daily_heal|7:IG7:${TODAY}`).status, 'succeeded');
});
