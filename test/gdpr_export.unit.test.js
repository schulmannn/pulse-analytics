// Юнит-тесты стриминг-экспорта (F5) — БЕЗ базы: чистые keyset-хелперы, backpressure-writer и
// сборка документа через фейковый pool/client. Проверяют то, что не требует Postgres:
//   • keyset-предикат корректен для одиночного ключа, составного ключа и NULLABLE ведущего ключа;
//   • pageQuery ставит LIMIT/курсор на верные позиции параметров;
//   • writer уважает backpressure (ждёт 'drain') и обрывается ExportAborted при 'close';
//   • стрим не селектит ни одной credential-колонки, отдаёт валидный JSON прежней формы,
//     ниткует курсор между страницами (без дублей/пропусков на уровне цикла), а обрыв/сбой
//     освобождают клиент и прекращают запросы; аудит-исход возвращается только на 'ok'.
const test = require('node:test');
const assert = require('node:assert');
const {
  createGdprService,
  _internals: { ARCHIVE_SPECS, buildKeysetPredicate, pageQuery, createWriter, ExportAborted },
} = require('../server/services/gdprService');

// ── keyset-предикат ───────────────────────────────────────────────────────────────────────────

test('keyset: одиночный не-null ключ → строгое «после» с учётом NULLS LAST', () => {
  const pred = buildKeysetPredicate(ARCHIVE_SPECS.daily.keys, [false], 2);
  assert.strictEqual(pred, '((day IS NULL OR day > $2::date))');
});

test('keyset: составной ключ, курсор не-null → tie-break вторым ключом', () => {
  const pred = buildKeysetPredicate(ARCHIVE_SPECS.posts.keys, [false, false], 2);
  // date_published > c  OR  (date_published = c AND post_id > c2)
  assert.strictEqual(
    pred,
    '((date_published IS NULL OR date_published > $2::timestamptz))'
    + ' OR (date_published = $2::timestamptz AND (post_id IS NULL OR post_id > $3::bigint))',
  );
});

test('keyset: NULLABLE ведущий ключ null в курсоре → идём в NULL-хвост по tie-break', () => {
  // Курсор на строке с date_published IS NULL: «после null» первого дизъюнкта = false (выпадает),
  // остаётся только хвост, где date_published IS NULL и post_id > cursor. null-ведущий ключ параметра
  // НЕ занимает → post_id биндится на $2 (плотная нумерация), а не $3 — иначе $2 остался бы без типа.
  const pred = buildKeysetPredicate(ARCHIVE_SPECS.posts.keys, [true, false], 2);
  assert.strictEqual(
    pred,
    '(date_published IS NULL AND (post_id IS NULL OR post_id > $2::bigint))',
  );
});

test('pageQuery: posts с NULL ведущим курсором → плейсхолдер для null не эмитится, LIMIT $3', () => {
  // Точный контракт SQL для строки-курсора date_published IS NULL: единственный курсор-параметр —
  // post_id ($2), LIMIT сразу за ним ($3). $2 не «висит» без ссылки → PG выведет тип корректно.
  const sql = pageQuery(ARCHIVE_SPECS.posts, true, [true, false]);
  assert.strictEqual(
    sql,
    'SELECT *, date_published::text AS __c0, post_id::text AS __c1 FROM posts'
    + ' WHERE channel_id = $1 AND ((date_published IS NULL AND (post_id IS NULL OR post_id > $2::bigint)))'
    + ' ORDER BY date_published ASC, post_id ASC LIMIT $3',
  );
});

test('pageQuery: первая страница — без предиката, LIMIT $2', () => {
  const sql = pageQuery(ARCHIVE_SPECS.daily, false, null);
  assert.match(sql, /SELECT \*, day::text AS __c0 FROM channel_daily WHERE channel_id = \$1 ORDER BY day ASC LIMIT \$2$/);
});

test('pageQuery: следующая страница posts — курсор $2..$3, LIMIT $4', () => {
  const sql = pageQuery(ARCHIVE_SPECS.posts, true, [false, false]);
  assert.match(sql, /LIMIT \$4$/);
  assert.match(sql, /ORDER BY date_published ASC, post_id ASC/);
  assert.match(sql, /post_id::text AS __c1/);
});

// ── backpressure-writer ─────────────────────────────────────────────────────────────────────

function fakeSocket(writeReturns) {
  const listeners = {};
  let i = 0;
  return {
    writableEnded: false,
    destroyed: false,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    off(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); return this; },
    emit(ev, ...a) { (listeners[ev] || []).slice().forEach((f) => f(...a)); },
    write() { const r = Array.isArray(writeReturns) ? (writeReturns[i++] ?? true) : true; return r; },
  };
}

test('writer: полный буфер → write ждёт «drain»', async () => {
  const sock = fakeSocket([false]); // первый write говорит «притормози»
  const w = createWriter(sock);
  let resolved = false;
  const p = w.write('x').then(() => { resolved = true; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(resolved, false, 'не резолвится до drain');
  sock.emit('drain');
  await p;
  assert.strictEqual(resolved, true, 'резолвится после drain');
  w.cleanup();
});

test('writer: обрыв соединения → ожидающий write падает ExportAborted, дальнейший write тоже', async () => {
  const sock = fakeSocket([false]);
  const w = createWriter(sock);
  const p = w.write('x');
  sock.emit('close');
  await assert.rejects(p, (e) => e instanceof ExportAborted);
  assert.strictEqual(w.closed, true);
  await assert.rejects(w.write('y'), (e) => e instanceof ExportAborted);
  w.cleanup();
});

test('writer: end() → close до finish-callback → отклоняется ExportAborted, не виснет', async () => {
  const sock = fakeSocket();
  // res.end вызван, но сокет рвётся 'close' ДО его callback'а — end() обязан отклониться, а не
  // остаться pending навсегда.
  sock.end = () => { sock.emit('close'); /* callback никогда не зовётся */ };
  const w = createWriter(sock);
  await assert.rejects(w.end(), (e) => e instanceof ExportAborted);
  w.cleanup();
});

test('writer: end() дожидается finish-callback и резолвится один раз', async () => {
  const sock = fakeSocket();
  let calls = 0;
  // Нормальное завершение: end зовёт callback (finish), затем эмитит 'close' — двойного исхода быть
  // не должно (guard). Без ошибки — значит промис зарезолвился ровно раз.
  sock.end = (cb) => { if (cb) cb(); sock.emit('close'); };
  const w = createWriter(sock);
  await w.end().then(() => { calls += 1; });
  assert.strictEqual(calls, 1);
  w.cleanup();
});

// ── сборка документа через фейковый pool/client ────────────────────────────────────────────────

/** Фейковый res-коллектор: пишет chunk'и в массив, backpressure не эмулирует (write→true). */
function collectorRes() {
  const listeners = {};
  return {
    chunks: [], writableEnded: false, destroyed: false, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    off(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn); return this; },
    emit(ev, ...a) { (listeners[ev] || []).slice().forEach((f) => f(...a)); },
    write(s) { this.chunks.push(s); return true; },
    end(cb) { this.writableEnded = true; if (cb) cb(); this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
    body() { return this.chunks.join(''); },
  };
}

/**
 * Фейковый пул: одна «строка» на каждую head-таблицу + очередь страниц на архивные таблицы.
 * capture — все (text, params); release — счётчик; hooks — врезки для abort/error по имени таблицы.
 */
function fakePool(spec) {
  const capture = [];
  let released = 0;
  const pages = { ...(spec.pages || {}) };
  const client = {
    async query(text, params) {
      // Workspaces SELECT содержит correlated subquery FROM workspace_members; основная таблица —
      // последний FROM в тексте. На простых запросах это тот же единственный match.
      const froms = [...text.matchAll(/\bFROM\s+(\w+)/g)];
      const table = froms.length ? froms[froms.length - 1][1] : undefined;
      capture.push({ text, params, table });
      if (spec.hooks && spec.hooks[table]) await spec.hooks[table]();
      if (Array.isArray(pages[table])) {
        const page = pages[table].shift();
        return { rows: page || [] };
      }
      if (table === 'users') return { rows: spec.account ? [spec.account] : [] };
      if (table === 'channels') return { rows: spec.channels || [] };
      return { rows: (spec.singles && spec.singles[table]) || [] };
    },
    release() { released += 1; },
  };
  return {
    connect: async () => client,
    capture,
    get released() { return released; },
  };
}

test('стрим: юзера нет → not_found, ни байта, onReady не звался, клиент освобождён', async () => {
  const pool = fakePool({ account: null });
  const svc = createGdprService({ pool, enabled: true, transaction: null });
  const res = collectorRes();
  let ready = false;
  const outcome = await svc.streamUserExport(7, res, { onReady() { ready = true; } });
  assert.strictEqual(outcome, 'not_found');
  assert.strictEqual(res.chunks.length, 0);
  assert.strictEqual(ready, false);
  assert.strictEqual(pool.released, 1);
});

test('стрим: собирает валидный JSON прежней формы и нитует курсор между страницами', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
    pages: {
      // Две полные страницы (по 2) + короткая → цикл должен запросить 2 раза с курсором и остановиться.
      channel_daily: [
        [{ day: '2024-01-01', views: 1, __c0: '2024-01-01' }, { day: '2024-01-02', views: 2, __c0: '2024-01-02' }],
        [{ day: '2024-01-03', views: 3, __c0: '2024-01-03' }],
      ],
    },
    singles: {},
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  const res = collectorRes();
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'ok');
  assert.strictEqual(res.writableEnded, true);

  const doc = JSON.parse(res.body());
  assert.strictEqual(doc.format, 'atlavue-export');
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.account.id, 5);
  assert.strictEqual(doc.channels.length, 1);
  const daily = doc.channels[0].archive.daily;
  assert.strictEqual(daily.length, 3, 'все три строки, без дублей/пропусков на стыке страниц');
  assert.deepStrictEqual(daily.map((r) => r.day), ['2024-01-01', '2024-01-02', '2024-01-03']);
  assert.ok(!('__c0' in daily[0]), 'служебный курсор-алиас вырезан из вывода');
  assert.deepStrictEqual(doc.channels[0].instagram, null);

  // Курсор второй страницы = последний __c0 первой ('2024-01-02').
  const dailyCalls = pool.capture.filter((c) => c.table === 'channel_daily');
  assert.strictEqual(dailyCalls.length, 2, 'ровно две страницы (вторая короткая — стоп)');
  assert.deepStrictEqual(dailyCalls[0].params, [9, 2]);
  assert.deepStrictEqual(dailyCalls[1].params, [9, '2024-01-02', 2]);
});

test('стрим: NULL date_published в курсоре posts → плейсхолдер пропущен, параметры без null', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
    pages: {
      // Полная первая страница (2), последняя строка — date_published NULL → курсор [null,'11'];
      // вторая страница пустая → стоп. Второй запрос обязан НЕ передавать null и биндить post_id на $2.
      posts: [
        [{ post_id: 10, date_published: 't', views: 1, __c0: 't', __c1: '10' },
          { post_id: 11, date_published: null, views: 1, __c0: null, __c1: '11' }],
        [],
      ],
    },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  const outcome = await svc.streamUserExport(5, collectorRes(), { onReady() {} });
  assert.strictEqual(outcome, 'ok');
  const postCalls = pool.capture.filter((c) => c.table === 'posts');
  assert.strictEqual(postCalls.length, 2, 'первая полная → запрос второй страницы');
  assert.deepStrictEqual(postCalls[1].params, [9, '11', 2], 'null курсор-значение не передаётся');
  assert.match(postCalls[1].text, /post_id > \$2::bigint/);
  assert.match(postCalls[1].text, /LIMIT \$3$/);
});

test('стрим: workspaces, reports и channels тянутся id-keyset-страницами (не unbounded чтением)', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
    pages: {
      workspaces: [
        [{ id: 10, name: 'personal', members: [] }, { id: 11, name: 'team-a', members: [] }],
        [{ id: 12, name: 'team-b', members: [] }],
      ],
      reports: [
        [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
        [{ id: 3, name: 'c' }],
      ],
    },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  const res = collectorRes();
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'ok');

  const doc = JSON.parse(res.body());
  assert.deepStrictEqual(doc.workspaces.map((w) => w.id), [10, 11, 12], 'все workspaces через keyset');
  assert.deepStrictEqual(doc.reports.map((r) => r.id), [1, 2, 3], 'все reports, без дублей/пропусков на стыке');

  const workspaceCalls = pool.capture.filter((c) => c.table === 'workspaces');
  assert.strictEqual(workspaceCalls.length, 2, 'две workspace keyset-страницы');
  assert.deepStrictEqual(workspaceCalls[0].params, [5, 2]);
  assert.deepStrictEqual(workspaceCalls[1].params, [5, 11, 2]);

  const reportCalls = pool.capture.filter((c) => c.table === 'reports');
  assert.strictEqual(reportCalls.length, 2, 'две keyset-страницы (первая полная, вторая короткая)');
  assert.match(reportCalls[0].text, /FROM reports WHERE uid=\$1 ORDER BY id ASC LIMIT \$2$/);
  assert.deepStrictEqual(reportCalls[0].params, [5, 2]);
  assert.match(reportCalls[1].text, /AND id > \$2 ORDER BY id ASC LIMIT \$3$/);
  assert.deepStrictEqual(reportCalls[1].params, [5, 2, 2], 'курсор = id последней строки страницы 1');

  // Список каналов — тоже keyset (LIMIT), не полное чтение.
  const chanCall = pool.capture.find((c) => c.table === 'channels');
  assert.match(chanCall.text, /FROM channels WHERE owner_uid=\$1 ORDER BY id ASC LIMIT \$2/);
  assert.deepStrictEqual(chanCall.params, [5, 2]);
});

test('стрим: гигантский pageSize зажимается до потолка 1000 (bounded-memory defense-in-depth)', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null });
  await svc.streamUserExport(5, collectorRes(), { onReady() {}, pageSize: 10_000_000 });
  const dailyCall = pool.capture.find((c) => c.table === 'channel_daily');
  // Последний параметр = LIMIT: зажат до потолка, а не 10 млн (иначе одна страница = весь архив).
  assert.strictEqual(dailyCall.params[dailyCall.params.length - 1], 1000);
});

test('стрим: обрыв на финальном res.end (close до finish-callback) → aborted, клиент освобождён', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [], // без каналов — быстро доходим до финального end()
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null });
  const res = collectorRes();
  // Сокет рвётся 'close' до finish-callback (гонка на завершении) — экспорт обязан вернуть aborted,
  // а не зависнуть в w.end(); клиент всё равно освобождается в finally.
  res.end = function end() { this.writableEnded = true; this.emit('close'); };
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'aborted');
  assert.strictEqual(pool.released, 1);
});

test('стрим: ни один SELECT не тянет credential-колонку', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null });
  await svc.streamUserExport(5, collectorRes(), { onReady() {} });
  const forbidden = /pass_hash|token_version|session_enc|access_token_enc|key_hash/i;
  for (const { text } of pool.capture) {
    assert.ok(!forbidden.test(text), `credential-колонка в SQL: ${text}`);
  }
});

test('стрим: обрыв клиента посреди архива → aborted, клиент освобождён, дальнейших запросов нет', async () => {
  let res;
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
    pages: { channel_daily: [[{ day: '2024-01-01', __c0: '2024-01-01' }]] },
    hooks: {
      // Клиент отваливается, когда дошли до posts — следующая запись в res должна упасть ExportAborted.
      posts() { res.emit('close'); },
    },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  res = collectorRes();
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'aborted');
  assert.strictEqual(pool.released, 1, 'клиент освобождён на обрыве');
  assert.ok(!pool.capture.some((c) => c.table === 'velocity_daily'), 'после обрыва в БД больше не ходим');
});

test('стрим: сбой запроса после начала ответа → stream_error, res уничтожен, клиент освобождён', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'u', title: 't', source: 'collector', tg_channel_id: null, created_at: 'T' }],
    hooks: { posts() { throw new Error('boom'); } },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null });
  const res = collectorRes();
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'stream_error');
  assert.strictEqual(res.destroyed, true);
  assert.strictEqual(pool.released, 1);
});

test('стрим: сбой ДО первого байта → throw (роут уводит в next(err)), клиент освобождён', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    hooks: { user_prefs() { throw new Error('early'); } },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null });
  const res = collectorRes();
  let ready = false;
  await assert.rejects(svc.streamUserExport(5, res, { onReady() { ready = true; } }), /early/);
  assert.strictEqual(ready, false, 'заголовки не ставились — 404/500 ещё возможны');
  assert.strictEqual(res.chunks.length, 0);
  assert.strictEqual(pool.released, 1);
});
