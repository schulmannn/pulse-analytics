'use strict';

// Юнит-тесты aiChatService + aiTools + mock-провайдера (infrastructure/aiProvider): полный
// агентный цикл БЕЗ сети и БЕЗ Postgres — фейковый db-фасад в памяти. Проверяем: сценарий
// mock-провайдера (tool-вызов → tool_result → финальный текст), персист сообщений и tool_trace,
// квоту, потолок tool-раундов и ownership-гейт инструментов.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiProvider } = require('../server/infrastructure/aiProvider');
const { createAiChatService } = require('../server/services/aiChatService');
const { createAiTools } = require('../server/services/aiTools');
const { makeChatTitle } = require('../server/repos/aiChatsRepo');

function fakeDb(over = {}) {
  const state = { messages: [], usage: { messages: 0, input_tokens: 0, output_tokens: 0 }, bumps: [] };
  return {
    state,
    enabled: true,
    getAiChat: async (uid, id) => (id === 1 ? { id: 1, title: '' } : null),
    listAiChatMessages: async () => state.messages.map((m, i) => ({ id: i + 1, ...m })),
    appendAiChatMessage: async (uid, chatId, msg) => {
      state.messages.push({ role: msg.role, content: msg.content, tool_trace: msg.toolTrace ?? null, error: msg.error ?? null });
      return { id: state.messages.length, role: msg.role, content: msg.content };
    },
    getAiUsageToday: async () => state.usage,
    bumpAiUsage: async (uid, delta) => { state.bumps.push(delta); },
    listChannels: async () => [
      { id: 3, username: 'notem', title: 'Канал', status: 'active', source: 'qr', ig_connected: false },
    ],
    listCampaigns: async () => [],
    getChannel: async () => null,
    ...over,
  };
}

function build({ db = fakeDb(), provider, limit = 50, rounds = 4 } = {}) {
  const p = provider || createAiProvider({ apiKey: '', allowMock: true, model: '', maxOutputTokens: 512 });
  const service = createAiChatService({
    db, log: () => {}, provider: p, dailyMessageLimit: limit, maxToolRounds: rounds,
  });
  return { db, service };
}

test('mock-провайдер: полный цикл — meta → tool(start/end) → text → done; персист и tool_trace', async () => {
  const { db, service } = build();
  const ctx = await service.preflight({ uid: 1, role: 'superuser' }, 1, 'Как дела у канала?');
  const events = [];
  const out = await service.answer({
    user: { uid: 1, role: 'superuser', email: 'a@b.c' },
    chat: ctx.chat,
    text: 'Как дела у канала?',
    emit: (e) => events.push(e),
  });

  assert.equal(out.ok, true);
  assert.equal(out.toolCalls, 1, 'mock делает ровно один tool-вызов');
  assert.equal(events[0].type, 'meta');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('tool'), 'события инструмента эмитятся');
  assert.ok(types.includes('text'), 'текст стримится');
  assert.equal(types.at(-1), 'done');

  // Персист: вопрос + ответ; у ответа есть tool_trace с успешным вызовом.
  assert.equal(db.state.messages.length, 2);
  assert.equal(db.state.messages[0].role, 'user');
  const saved = db.state.messages[1];
  assert.equal(saved.role, 'assistant');
  assert.match(saved.content, /mock-режим/);
  assert.equal(saved.tool_trace.length, 1);
  assert.equal(saved.tool_trace[0].ok, true);

  // Бухгалтерия: +1 сообщение и токены хода.
  assert.deepEqual(db.state.bumps[0], { messages: 1 });
  assert.ok(db.state.bumps[1].inputTokens > 0);
});

test('квота: preflight бросает code=quota при исчерпанном дневном лимите', async () => {
  const db = fakeDb();
  db.state.usage.messages = 5;
  const { service } = build({ db, limit: 5 });
  await assert.rejects(
    service.preflight({ uid: 1 }, 1, 'ещё вопрос'),
    (e) => e.code === 'quota' && /лимит/i.test(e.message),
  );
});

test('preflight: чужой чат → not_found; пустой и гигантский текст → bad_text', async () => {
  const { service } = build();
  await assert.rejects(service.preflight({ uid: 1 }, 99, 'q'), (e) => e.code === 'not_found');
  await assert.rejects(service.preflight({ uid: 1 }, 1, '   '), (e) => e.code === 'bad_text');
  await assert.rejects(service.preflight({ uid: 1 }, 1, 'я'.repeat(4001)), (e) => e.code === 'bad_text');
});

test('потолок tool-раундов: вечно просящий инструменты провайдер принудительно завершается', async () => {
  let turns = 0;
  const greedy = {
    mode: 'mock',
    model: 'greedy',
    async streamTurn({ toolChoice, onEvent }) {
      turns += 1;
      if (toolChoice && toolChoice.type === 'none') {
        onEvent({ type: 'text', delta: 'Итог по собранному.' });
        return { content: [{ type: 'text', text: 'Итог по собранному.' }], stopReason: 'end_turn', usage: { input: 1, output: 1 } };
      }
      return {
        content: [{ type: 'tool_use', id: `t${turns}`, name: 'get_campaigns', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 1, output: 1 },
      };
    },
  };
  const { db, service } = build({ provider: greedy, rounds: 3 });
  const events = [];
  const out = await service.answer({
    user: { uid: 1, role: 'superuser' }, chat: { id: 1, title: '' }, text: 'вопрос',
    emit: (e) => events.push(e),
  });
  assert.equal(out.ok, true);
  assert.equal(turns, 4, '3 tool-раунда + финальный ход с tool_choice none');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(db.state.messages.at(-1).content, 'Итог по собранному.');
});

test('ошибка провайдера: error-событие + честный персист пустого ответа с пометкой', async () => {
  const failing = {
    mode: 'anthropic', model: 'x',
    async streamTurn() {
      throw Object.assign(new Error('rate limited'), { userMessage: 'AI-провайдер ограничил частоту запросов.' });
    },
  };
  const { db, service } = build({ provider: failing });
  const events = [];
  const out = await service.answer({
    user: { uid: 1 }, chat: { id: 1, title: '' }, text: 'вопрос', emit: (e) => events.push(e),
  });
  assert.equal(out.ok, false);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /частоту/);
  assert.equal(db.state.messages.at(-1).error, 'provider');
});

test('aiTools: ownership-гейт — чужой/несуществующий канал неотличим от отсутствующего', async () => {
  const tools = createAiTools({ db: fakeDb() }); // getChannel → null
  for (const name of ['get_telegram_metrics', 'get_telegram_top_posts', 'get_instagram_metrics', 'get_mentions_summary']) {
    const res = await tools.run(name, { channel_id: 777 }, { uid: 1 });
    assert.match(res.error, /не найден или недоступен/, name);
  }
  const noArg = await tools.run('get_telegram_metrics', {}, { uid: 1 });
  assert.match(noArg.error, /channel_id/);
});

test('aiTools: TG-метрики — тоталы и недельные бакеты для длинного окна', async () => {
  const days = 60;
  const rows = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2026, 4, 1 + i)); // с 1 мая 2026
    return {
      day: d.toISOString().slice(0, 10),
      subscribers: 1000 + i, joins: 2, leaves: 1, views: 100, forwards: 3, reactions: 5,
    };
  });
  const db = fakeDb({
    getChannel: async (id) => (id === 3 ? { id: 3, title: 'Канал', username: 'notem' } : null),
    getChannelHistoryForActor: async () => rows,
  });
  const tools = createAiTools({ db });
  const res = await tools.run('get_telegram_metrics', { channel_id: 3, days }, { uid: 1 });
  assert.equal(res.totals.views, 100 * days);
  assert.equal(res.totals.net_subscribers, days); // 2 join − 1 leave в день
  assert.equal(res.subscribers.end, 1000 + days - 1);
  assert.ok(!res.daily, 'длинное окно не отдаёт дневные строки');
  assert.ok(res.weekly.length >= 8 && res.weekly.length <= 10, `недельных бакетов ~9, получили ${res.weekly.length}`);
  assert.equal(res.weekly.reduce((a, w) => a + w.views, 0), 100 * days, 'бакеты сохраняют сумму');
});

test('aiTools: топ постов — окно по дате, сортировка по ER, обрезка текста', async () => {
  const now = Date.now();
  const db = fakeDb({
    getChannel: async () => ({ id: 3, title: 'Канал', username: 'notem' }),
    listPostsForActor: async () => [
      { id: '1', date: new Date(now - 2 * 864e5), text: 'Свежий хит', views: 1000, reactions: 90, forwards: 10, replies: 0, media_type: 'photo' },
      { id: '2', date: new Date(now - 3 * 864e5), text: 'Тихий пост', views: 1000, reactions: 5, forwards: 0, replies: 5, media_type: 'text' },
      { id: '3', date: new Date(now - 40 * 864e5), text: 'Старый', views: 99999, reactions: 1, forwards: 1, replies: 1, media_type: 'photo' },
    ],
  });
  const tools = createAiTools({ db });
  const res = await tools.run('get_telegram_top_posts', { channel_id: 3, days: 30, sort_by: 'er', limit: 5 }, { uid: 1 });
  assert.equal(res.posts_in_window, 2, 'пост старше окна отброшен');
  assert.equal(res.top[0].post_id, '1');
  assert.equal(res.top[0].er_percent, 10);
});

test('makeChatTitle: схлопывает пробелы и режет по границе слова', () => {
  assert.equal(makeChatTitle('  Как   растёт \n канал?  '), 'Как растёт канал?');
  const long = 'слово '.repeat(30).trim();
  const title = makeChatTitle(long);
  assert.ok(title.length <= 81, 'не длиннее лимита + многоточие');
  assert.ok(title.endsWith('…'));
  assert.equal(makeChatTitle('   '), null);
});

// ── Складские инструменты (МойСклад) ────────────────────────────────────────────────────────────

const skladDb = (over = {}) => fakeDb({
  getChannel: async (id) => (id === 9 ? { id: 9, title: 'ИП Тест Склад', username: null } : null),
  getMsDailyAllForActor: async () => [],
  getMsCustomersForActor: async () => ({
    summary: {
      customers: 0, new_customers: 0, repeat_customers: 0, orders_new: 0, orders_repeat: 0,
      sum_new_kopecks: 0, sum_repeat_kopecks: 0, no_agent_orders: 0, repeat_ever: 0,
    },
    series: [],
  }),
  getMsFunnelForActor: async () => [],
  getMsAccount: async () => null,
  ...over,
});

test('sklad_metrics: окно фильтруется, копейки → рубли, средний чек считается', async () => {
  const today = new Date();
  const dayAgo = (n) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const db = skladDb({
    getMsDailyAllForActor: async () => [
      { day: dayAgo(100), revenue_kopecks: 999_00, orders_count: 9, orders_sum_kopecks: 999_00 }, // вне окна
      { day: dayAgo(5), revenue_kopecks: 500_00, orders_count: 2, orders_sum_kopecks: 600_00 },
      { day: dayAgo(1), revenue_kopecks: 250_50, orders_count: 1, orders_sum_kopecks: 200_00 },
    ],
  });
  const tools = createAiTools({ db });
  const res = await tools.run('get_sklad_metrics', { channel_id: 9, days: 30 }, { uid: 1 });
  assert.equal(res.totals.revenue_rub, 750.5, 'строка вне окна отброшена, копейки → рубли');
  assert.equal(res.totals.orders_count, 3);
  assert.equal(res.totals.orders_sum_rub, 800);
  assert.ok(Math.abs(res.totals.avg_check_rub - 266.67) < 0.01, 'средний чек = сумма заказов / число заказов');
  assert.equal(res.daily.length, 2);
});

test('sklad_customers: маппинг новых/повторных в рубли + честная пустота', async () => {
  const db = skladDb({
    getMsCustomersForActor: async () => ({
      summary: {
        customers: 10, new_customers: 6, repeat_customers: 4, orders_new: 6, orders_repeat: 9,
        sum_new_kopecks: 100_000, sum_repeat_kopecks: 250_000, no_agent_orders: 2, repeat_ever: 17,
      },
      series: [],
    }),
  });
  const tools = createAiTools({ db });
  const res = await tools.run('get_sklad_customers', { channel_id: 9 }, { uid: 1 });
  assert.equal(res.new_customers, 6);
  assert.equal(res.revenue_rub.by_repeat, 2500);
  assert.equal(res.orders_without_customer, 2);

  // Пустой архив (дефолтный skladDb) — честная пустота, не ошибка.
  const empty = await createAiTools({ db: skladDb() }).run('get_sklad_customers', { channel_id: 9 }, { uid: 1 });
  assert.match(empty.note, /Заказов с покупателями за период нет/);
});

test('sklad_funnel: имена статусов из живого словаря; без аккаунта — id + пометка', async () => {
  const rows = [
    { state_id: 's-new', orders: 5, sum_kopecks: 500_00 },
    { state_id: null, orders: 1, sum_kopecks: 100_00 },
  ];
  const withDict = createAiTools({
    db: skladDb({
      getMsFunnelForActor: async () => rows,
      getMsAccount: async () => ({ access_token_enc: 'enc' }),
    }),
    sklad: {
      msCrypto: { configured: () => true, decrypt: (e) => `TOKEN:${e}` },
      msFetch: async (token, path) => {
        assert.equal(token, 'TOKEN:enc');
        assert.match(path, /customerorder\/metadata/);
        return { states: [{ id: 's-new', name: 'Новый' }] };
      },
    },
  });
  const named = await withDict.run('get_sklad_funnel', { channel_id: 9 }, { uid: 1 });
  assert.deepEqual(named.statuses.map((s) => s.status), ['Новый', 'Без статуса']);
  assert.equal(named.statuses[0].sum_rub, 500);

  const bare = await createAiTools({ db: skladDb({ getMsFunnelForActor: async () => rows }) })
    .run('get_sklad_funnel', { channel_id: 9 }, { uid: 1 });
  assert.equal(bare.statuses[0].status, 's-new', 'без словаря — технический id');
  assert.match(bare.note, /Справочник имён статусов недоступен/);
});

test('sklad_top_products: сортировка по выручке у нас; без аккаунта — честная ошибка', async () => {
  const tools = createAiTools({
    db: skladDb({ getMsAccount: async () => ({ access_token_enc: 'enc' }) }),
    sklad: {
      msCrypto: { configured: () => true, decrypt: () => 'T' },
      msFetch: async (_t, path) => {
        assert.match(path, /report\/profit\/byproduct/);
        assert.match(path, /limit=1000/);
        return {
          meta: { size: 3 },
          rows: [
            { assortment: { name: 'А-мелочь' }, sellQuantity: 61, sellSum: 0, profit: 0 },
            { assortment: { name: 'Б-хит' }, sellQuantity: 2, sellSum: 900_00, profit: 300_00 },
            { assortment: { name: 'В-середина' }, sellQuantity: 1, sellSum: 400_00, profit: 100_00 },
          ],
        };
      },
    },
  });
  const res = await tools.run('get_sklad_top_products', { channel_id: 9, limit: 2 }, { uid: 1 });
  assert.deepEqual(res.top.map((r) => r.name), ['Б-хит', 'В-середина'], 'топ по выручке, не по алфавиту');
  assert.equal(res.top[0].revenue_rub, 900);
  assert.equal(res.products_in_window, 3);

  const noAccount = await createAiTools({ db: skladDb() })
    .run('get_sklad_top_products', { channel_id: 9 }, { uid: 1 });
  assert.match(noAccount.error, /не подключён/);
});

test('sklad-инструменты: ownership-гейт — чужой канал неотличим от отсутствующего', async () => {
  const tools = createAiTools({ db: skladDb() });
  for (const name of ['get_sklad_metrics', 'get_sklad_customers', 'get_sklad_funnel', 'get_sklad_top_products']) {
    const res = await tools.run(name, { channel_id: 777 }, { uid: 1 });
    assert.match(res.error, /не найден или недоступен/, name);
  }
});
