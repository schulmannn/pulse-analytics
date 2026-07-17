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
