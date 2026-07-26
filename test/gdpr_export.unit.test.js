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

test('pageQuery: ym_daily использует тот же bounded day-keyset', () => {
  const sql = pageQuery(ARCHIVE_SPECS.ymDaily, true, [false]);
  assert.strictEqual(
    sql,
    'SELECT *, day::text AS __c0 FROM ym_daily'
    + ' WHERE channel_id = $1 AND (((day IS NULL OR day > $2::date)))'
    + ' ORDER BY day ASC LIMIT $3',
  );
});

test('pageQuery: ms_daily живёт независимо от ms_accounts и использует day-keyset', () => {
  assert.strictEqual(
    pageQuery(ARCHIVE_SPECS.msDaily, true, [false]),
    'SELECT *, day::text AS __c0 FROM ms_daily'
    + ' WHERE channel_id = $1 AND (((day IS NULL OR day > $2::date)))'
    + ' ORDER BY day ASC LIMIT $3',
  );
});

test('pageQuery: raw_snapshots пагинируется уникальным day/source/kind keyset', () => {
  const sql = pageQuery(ARCHIVE_SPECS.rawSnapshots, true, [false, false, false]);
  assert.match(sql, /^SELECT \*, day::text AS __c0, source::text AS __c1, kind::text AS __c2 FROM raw_snapshots/);
  assert.match(sql, /ORDER BY day ASC, source ASC, kind ASC LIMIT \$5$/);
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
      let table = froms.length ? froms[froms.length - 1][1] : undefined;
      // Campaign ownership/access probes contain a correlated FROM workspace_members; retain the
      // actual paginated root table for page queues and assertions.
      if (/\bFROM\s+campaign_posts\s+cp\b/i.test(text)) table = 'campaign_posts';
      else if (/\bFROM\s+campaigns\s+c\b/i.test(text)) table = 'campaigns';
      // EXISTS касается двух IG-таблиц, но это singleton presence-probe, не страница media archive.
      if (/\bAS\s+has_instagram_archive\b/i.test(text)) table = 'instagram_archive_presence';
      capture.push({ text, params, table });
      if (spec.hooks && spec.hooks[table]) await spec.hooks[table]();
      if (table === 'instagram_archive_presence') {
        return { rows: [{ has_instagram_archive: Boolean(spec.hasInstagramArchive) }] };
      }
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

test('стирание: FK-safe pre-null, audit wipe и полный external-source sweep', async () => {
  const queries = [];
  const client = {
    async query(text, params) {
      queries.push({ text, params });
      if (/DELETE FROM users/.test(text)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
  const svc = createGdprService({
    pool: {},
    enabled: true,
    transaction: async (fn) => fn(client),
  });
  assert.strictEqual(await svc.deleteUserAccount(5), true);

  const campaignCleanupIdx = queries.findIndex((q) => /DELETE FROM campaign_posts cp/.test(q.text));
  const channelPreNullIdx = queries.findIndex((q) => /UPDATE channels SET workspace_id = NULL/.test(q.text));
  assert.ok(campaignCleanupIdx >= 0 && campaignCleanupIdx < channelPreNullIdx,
    'composite-FK campaign rows are removed before changing the foreign channel workspace_id');
  const campaignCleanup = queries[campaignCleanupIdx];
  assert.match(campaignCleanup.text, /cp\.channel_id = c\.id/);
  assert.match(campaignCleanup.text, /c\.owner_uid IS DISTINCT FROM \$1/);
  assert.deepStrictEqual(campaignCleanup.params, [5]);

  const scrub = queries.find((q) => /UPDATE audit_events/.test(q.text));
  assert.match(scrub.text, /metadata = '\{\}'::jsonb/);
  assert.match(scrub.text, /ip_hash = NULL/);
  assert.match(scrub.text, /request_id = NULL/);
  assert.deepStrictEqual(scrub.params, [5]);

  const sweep = queries.find((q) => /DELETE FROM external_sources/.test(q.text));
  for (const table of [
    'channels', 'ig_accounts', 'ms_accounts', 'ym_accounts', 'channel_daily', 'channel_monthly',
    'posts', 'velocity_daily', 'mentions', 'ig_daily', 'ig_media_daily',
  ]) {
    assert.match(sweep.text, new RegExp(`NOT EXISTS \\(SELECT 1 FROM ${table}\\s+t WHERE t\\.source_id = s\\.id\\)`),
      `${table} prevents deletion of a still-referenced canonical source`);
  }
});

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
      mention_notify_subscriptions: [[{
        channel_id: 19, enabled: true, send_days: [], send_hour: 10,
        last_run_at: null, last_notified_at: null, last_error: null,
        created_at: 'T', updated_at: 'T',
      }]],
      // Две полные страницы (по 2) + короткая → цикл должен запросить 2 раза с курсором и остановиться.
      channel_daily: [
        [{ day: '2024-01-01', views: 1, __c0: '2024-01-01' }, { day: '2024-01-02', views: 2, __c0: '2024-01-02' }],
        [{ day: '2024-01-03', views: 3, __c0: '2024-01-03' }],
      ],
      ym_daily: [[{
        channel_id: 9, day: '2024-01-01', visits: '7', users: '6', pageviews: '8',
        __c0: '2024-01-01',
      }]],
      ms_orders: [[{
        order_id: 'order-1', moment: '2024-01-02T10:00:00Z', sum_kopecks: '15000',
        agent_id: 'agent-1', agent_name: 'Customer', __c0: 'order-1',
      }]],
      ms_returns: [[{
        return_id: 'return-1', moment: '2024-01-03T10:00:00Z', sum_kopecks: '5000',
        agent_id: 'agent-1', agent_name: 'Customer', __c0: 'return-1',
      }]],
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
  assert.deepStrictEqual(doc.channels[0].archive.ms_orders.map((r) => r.order_id), ['order-1']);
  assert.deepStrictEqual(doc.channels[0].archive.ms_returns.map((r) => r.return_id), ['return-1']);
  assert.ok(!('__c0' in doc.channels[0].archive.ms_returns[0]), 'MoySklad cursor alias is not exported');
  assert.deepStrictEqual(doc.channels[0].archive.ym_daily.map((r) => r.visits), ['7']);
  assert.ok(!('__c0' in doc.channels[0].archive.ym_daily[0]), 'YM cursor alias is not exported');
  assert.deepStrictEqual(doc.mention_notify_subscriptions.map((s) => s.channel_id), [19]);
  assert.deepStrictEqual(doc.channels[0].instagram, null);

  // Курсор второй страницы = последний __c0 первой ('2024-01-02').
  const dailyCalls = pool.capture.filter((c) => c.table === 'channel_daily');
  assert.strictEqual(dailyCalls.length, 2, 'ровно две страницы (вторая короткая — стоп)');
  assert.deepStrictEqual(dailyCalls[0].params, [9, 2]);
  assert.deepStrictEqual(dailyCalls[1].params, [9, '2024-01-02', 2]);

  const subscriptionCalls = pool.capture.filter((c) => c.table === 'mention_notify_subscriptions');
  assert.strictEqual(subscriptionCalls.length, 2, 'top-level paged read + legacy owned-channel singleton');
  assert.deepStrictEqual(subscriptionCalls[0].params, [5, 2]);
  assert.doesNotMatch(subscriptionCalls[0].text, /\bJOIN\b|\bFROM\s+channels\b/i,
    'subscription export does not join or reveal channel data');
});

test('стрим: AI/raw архивы bounded, а Instagram history переживает disconnect', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{ id: 9, username: 'own', title: 'Own', source: 'collector', tg_channel_id: null, created_at: 'T' }],
    hasInstagramArchive: true,
    pages: {
      ai_chats: [
        [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }],
        [{ id: 3, title: 'Three' }],
      ],
      ai_chat_messages: [
        [
          { id: 10, chat_id: 1, role: 'user', content: 'question' },
          { id: 11, chat_id: 1, role: 'assistant', content: 'answer' },
        ],
        [{ id: 12, chat_id: 3, role: 'user', content: 'next' }],
      ],
      ai_usage_daily: [
        [
          { day: '2024-01-01', messages: 1, input_tokens: '2', output_tokens: '3', __cursor: '2024-01-01' },
          { day: '2024-01-02', messages: 2, input_tokens: '4', output_tokens: '5', __cursor: '2024-01-02' },
        ],
        [{ day: '2024-01-03', messages: 1, input_tokens: '6', output_tokens: '7', __cursor: '2024-01-03' }],
      ],
      raw_snapshots: [[{
        channel_id: 9, source: 'ig', kind: 'stories', day: '2024-01-01',
        payload: { data: [{ id: 'story-own' }] }, created_at: 'T',
        __c0: '2024-01-01', __c1: 'ig', __c2: 'stories',
      }]],
      ig_daily: [[{ channel_id: 9, day: '2024-01-01', reach: 8, __c0: '2024-01-01' }]],
      ig_media_daily: [[{
        channel_id: 9, media_id: 'media-own', day: '2024-01-01', reach: 7,
        __c0: '2024-01-01', __c1: 'media-own',
      }]],
    },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  const res = collectorRes();
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'ok');

  const doc = JSON.parse(res.body());
  assert.deepStrictEqual(doc.ai_chats.map((c) => c.id), [1, 2, 3]);
  assert.deepStrictEqual(doc.ai_chat_messages.map((m) => m.id), [10, 11, 12]);
  assert.deepStrictEqual(doc.ai_usage_daily.map((d) => d.day), ['2024-01-01', '2024-01-02', '2024-01-03']);
  assert.ok(doc.ai_usage_daily.every((d) => !('__cursor' in d)), 'служебный day cursor не экспортируется');
  assert.strictEqual(doc.channels[0].archive.raw_snapshots[0].payload.data[0].id, 'story-own');

  const instagram = doc.channels[0].instagram;
  assert.ok(instagram, 'history makes Instagram section present without ig_accounts');
  assert.strictEqual(instagram.ig_user_id, null, 'disconnected integration identity is explicitly nullable');
  assert.strictEqual(instagram.username, null);
  assert.strictEqual(instagram.daily[0].reach, 8);
  assert.strictEqual(instagram.media_daily[0].media_id, 'media-own');

  const chatCalls = pool.capture.filter((c) => c.table === 'ai_chats');
  assert.deepStrictEqual(chatCalls[0].params, [5, 2]);
  assert.deepStrictEqual(chatCalls[1].params, [5, 2, 2]);
  const messageCalls = pool.capture.filter((c) => c.table === 'ai_chat_messages');
  assert.ok(messageCalls.every((c) => /JOIN ai_chats c ON c\.id = m\.chat_id/.test(c.text)));
  assert.ok(messageCalls.every((c) => /WHERE c\.user_id=\$1/.test(c.text)));
  assert.deepStrictEqual(messageCalls[1].params, [5, 11, 2]);
  const rawCalls = pool.capture.filter((c) => c.table === 'raw_snapshots');
  assert.deepStrictEqual(rawCalls[0].params, [9, 2], 'raw archive is scoped to the owned channel');
});

test('стрим: approved portability matrix использует safe projections и tenant guards', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [{
      id: 9, workspace_id: 40, username: 'own', title: 'Own', status: 'paused',
      source: 'collector', tg_channel_id: 99, created_at: 'T',
    }],
    pages: {
      workspaces: [[{ id: 40, name: 'Mine', kind: 'personal', created_at: 'T' }]],
      workspace_members: [
        [
          { workspace_id: 40, role: 'owner', workspace_kind: 'personal' },
          { workspace_id: 50, role: 'member', workspace_kind: 'team' },
        ],
        [{ workspace_id: 60, role: 'viewer', workspace_kind: 'team' }],
      ],
      campaigns: [
        [{ id: 70, workspace_id: 40, name: 'Own A' }, { id: 71, workspace_id: 50, name: 'Own B' }],
        [{ id: 72, workspace_id: 60, name: 'Own C' }],
      ],
      campaign_posts: [
        [
          {
            campaign_id: 70, network: 'tg', channel_id: 9, post_ref: '100', added_at: 'T',
            __c0: '70', __c1: 'tg', __c2: '9', __c3: '100',
          },
          {
            campaign_id: 71, network: 'ig', channel_id: 10, post_ref: 'm1', added_at: 'T',
            __c0: '71', __c1: 'ig', __c2: '10', __c3: 'm1',
          },
        ],
        [{
          campaign_id: 72, network: 'tg', channel_id: 11, post_ref: '200', added_at: 'T',
          __c0: '72', __c1: 'tg', __c2: '11', __c3: '200',
        }],
      ],
      audit_events: [
        [{ id: 1, channel_id: 9, action: 'one', created_at: 'T' }, { id: 2, channel_id: 9, action: 'two', created_at: 'T' }],
        [{ id: 3, channel_id: null, action: 'three', created_at: 'T' }],
      ],
      ms_daily: [
        [
          { channel_id: 9, day: '2024-01-01', revenue_kopecks: '10', __c0: '2024-01-01' },
          { channel_id: 9, day: '2024-01-02', revenue_kopecks: '20', __c0: '2024-01-02' },
        ],
        [{ channel_id: 9, day: '2024-01-03', revenue_kopecks: '30', __c0: '2024-01-03' }],
      ],
      api_keys: [
        [
          { id: 1, key_prefix: 'pa_a', label: 'Collector A' },
          { id: 2, key_prefix: 'pa_b', label: 'Collector B' },
        ],
        [{ id: 3, key_prefix: 'pa_c', label: 'Collector C' }],
      ],
    },
    singles: {
      tg_sessions: [{
        tg_user_id: 123, username: 'me', connected_at: 'T', updated_at: 'T',
        connection_state: 'degraded', last_attempt_at: 'T', last_success_at: null,
        last_error_code: 'upstream', last_error_at: 'T',
      }],
      channel_snapshots: [{ data: { subscribers: 42 }, updated_at: 'T' }],
      ms_accounts: [{ ms_account_id: 'ms-own', org_name: 'Own org', connected_at: 'T', updated_at: 'T' }],
    },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  const res = collectorRes();
  assert.strictEqual(await svc.streamUserExport(5, res, { onReady() {} }), 'ok');
  const doc = JSON.parse(res.body());

  assert.deepStrictEqual(doc.workspaces, [{ id: 40, name: 'Mine', kind: 'personal', created_at: 'T' }]);
  assert.deepStrictEqual(doc.workspace_memberships.map((m) => m.workspace_id), [40, 50, 60]);
  assert.deepStrictEqual(doc.campaigns.map((c) => c.id), [70, 71, 72]);
  assert.deepStrictEqual(doc.campaign_posts.map((p) => p.post_ref), ['100', 'm1', '200']);
  assert.ok(doc.campaign_posts.every((p) =>
    !('caption' in p) && !('published_at' in p) && !('media_type' in p) && !('added_by' in p)));
  assert.deepStrictEqual(doc.audit_events.map((e) => e.id), [1, 2, 3]);
  assert.strictEqual(doc.telegram_session.connection_state, 'degraded');
  assert.strictEqual(doc.channels[0].workspace_id, 40);
  assert.strictEqual(doc.channels[0].status, 'paused');
  assert.deepStrictEqual(doc.channels[0].archive.ms_daily.map((d) => d.day),
    ['2024-01-01', '2024-01-02', '2024-01-03']);
  assert.deepStrictEqual(doc.channels[0].snapshot.data, { subscribers: 42 });
  assert.strictEqual(doc.channels[0].moysklad.ms_account_id, 'ms-own');
  assert.deepStrictEqual(doc.channels[0].api_keys.map((k) => k.id), [1, 2, 3]);

  const membershipCalls = pool.capture.filter((c) => c.table === 'workspace_members');
  assert.ok(membershipCalls.every((c) => /WHERE m\.uid=\$1/.test(c.text)), 'only own membership rows');
  assert.deepStrictEqual(membershipCalls[1].params, [5, 50, 2]);
  const campaignCalls = pool.capture.filter((c) => c.table === 'campaigns');
  assert.ok(campaignCalls.every((c) => /WHERE c\.created_by=\$1/.test(c.text)));
  assert.ok(campaignCalls.every((c) => /w\.owner_uid=\$1 OR EXISTS/.test(c.text)));
  assert.deepStrictEqual(campaignCalls[1].params, [5, 71, 2]);
  const postCalls = pool.capture.filter((c) => c.table === 'campaign_posts');
  assert.ok(postCalls.every((c) => /WHERE cp\.added_by=\$1/.test(c.text)));
  assert.ok(postCalls.every((c) => !/cp\.(caption|published_at|media_type|added_by)\b/.test(
    c.text.slice(0, c.text.indexOf('FROM campaign_posts')))));
  assert.deepStrictEqual(postCalls[1].params, [5, '71', 'ig', '10', 'm1', 2]);
  const auditCalls = pool.capture.filter((c) => c.table === 'audit_events');
  assert.ok(auditCalls.every((c) => !/\b(ip_hash|request_id|metadata)\b/.test(c.text)));
  assert.deepStrictEqual(auditCalls[1].params, [5, 2, 2]);
  const snapshotCall = pool.capture.find((c) => c.table === 'channel_snapshots');
  assert.match(snapshotCall.text, /data - 'channel_photo' AS data/);
  const apiKeyCalls = pool.capture.filter((c) => c.table === 'api_keys');
  assert.ok(apiKeyCalls.every((c) => !/\bkey_hash\b/.test(c.text)));
  assert.deepStrictEqual(apiKeyCalls[1].params, [9, 2, 2]);
});

test('стрим: личные подписки пагинируются по channel_id независимо от owner-only channels', async () => {
  const pool = fakePool({
    account: { id: 5, email: 'e', role: 'user', status: 'active', avatar_url: null, created_at: 'T' },
    channels: [],
    pages: {
      mention_notify_subscriptions: [
        [
          { channel_id: 7, enabled: true, send_days: [], send_hour: 9 },
          { channel_id: 11, enabled: false, send_days: [1, 3], send_hour: 12 },
        ],
        [{ channel_id: 19, enabled: true, send_days: [5], send_hour: 18 }],
      ],
    },
  });
  const svc = createGdprService({ pool, enabled: true, transaction: null, exportPageSize: 2 });
  const res = collectorRes();
  const outcome = await svc.streamUserExport(5, res, { onReady() {} });
  assert.strictEqual(outcome, 'ok');

  const doc = JSON.parse(res.body());
  assert.deepStrictEqual(doc.channels, [], 'subscription does not pull a non-owned channel into export');
  assert.deepStrictEqual(doc.mention_notify_subscriptions.map((s) => s.channel_id), [7, 11, 19]);

  const calls = pool.capture.filter((c) => c.table === 'mention_notify_subscriptions');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0].params, [5, 2]);
  assert.match(calls[0].text, /WHERE uid=\$1 ORDER BY channel_id ASC LIMIT \$2$/);
  assert.deepStrictEqual(calls[1].params, [5, 11, 2]);
  assert.match(calls[1].text, /AND channel_id > \$2 ORDER BY channel_id ASC LIMIT \$3$/);
  assert.ok(calls.every((c) => !/\bJOIN\b|\bFROM\s+channels\b/i.test(c.text)),
    'no shared-channel metadata query is introduced');
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
