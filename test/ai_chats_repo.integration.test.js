'use strict';

// Integration-тесты aiChatsRepo (личные AI-диалоги, 028) — на РЕАЛЬНОМ Postgres. Без
// TEST_DATABASE_URL всё SKIP'ается (как campaigns/users/channels). Локальный стенд:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// Каждый прогон живёт на своих строках (nonce в email) и чистит за собой (удаление
// пользователей каскадит чаты/сообщения/usage).

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `ai${Date.now().toString(36)}${process.pid}`;
const mail = (tag) => `${tag}.${nonce}@it.local`;
const S = {};

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
  S.userA = await db.createUser({ email: mail('a'), pass_hash: 'x', role: 'superuser', status: 'active' });
  S.userB = await db.createUser({ email: mail('b'), pass_hash: 'x', role: 'user', status: 'active' });
});

test.after(async () => {
  if (!TEST_DB) return;
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${nonce}%`]);
  await pool.end();
  await db.close();
});

test('чат: create → append(user) ставит заголовок из первого вопроса, updated_at растёт', { skip }, async () => {
  const chat = await db.createAiChat(S.userA.id);
  assert.ok(chat.id > 0);
  assert.equal(chat.title, '');
  S.chatA = chat;

  const q = 'Как выросли просмотры за неделю?   И почему?';
  const m1 = await db.appendAiChatMessage(S.userA.id, chat.id, { role: 'user', content: q });
  assert.ok(m1.id > 0);
  const after = await db.getAiChat(S.userA.id, chat.id);
  assert.equal(after.title, 'Как выросли просмотры за неделю? И почему?');

  const m2 = await db.appendAiChatMessage(S.userA.id, chat.id, {
    role: 'assistant',
    content: 'Просмотры выросли на 12%.',
    toolTrace: [{ name: 'get_telegram_metrics', ok: true, ms: 42 }],
    model: 'claude-sonnet-5',
    inputTokens: 1200,
    outputTokens: 80,
  });
  assert.ok(m2.id > m1.id);

  const messages = await db.listAiChatMessages(S.userA.id, chat.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].tool_trace[0].name, 'get_telegram_metrics');
  assert.equal(messages[1].input_tokens, 1200);
});

test('tenancy: чужой чат неотличим от несуществующего (get/append/delete/messages)', { skip }, async () => {
  assert.equal(await db.getAiChat(S.userB.id, S.chatA.id), null);
  assert.equal(
    await db.appendAiChatMessage(S.userB.id, S.chatA.id, { role: 'user', content: 'взлом' }),
    null,
  );
  assert.deepEqual(await db.listAiChatMessages(S.userB.id, S.chatA.id), []);
  assert.equal(await db.deleteAiChat(S.userB.id, S.chatA.id), false);
  // Список B пуст, список A содержит его чат.
  assert.deepEqual(await db.listAiChats(S.userB.id), []);
  const listA = await db.listAiChats(S.userA.id);
  assert.equal(listA.length, 1);
  assert.equal(listA[0].message_count, 2);
});

test('usage: bump агрегирует за UTC-день, чтение отдаёт числа', { skip }, async () => {
  const before = await db.getAiUsageToday(S.userA.id);
  await db.bumpAiUsage(S.userA.id, { messages: 1 });
  await db.bumpAiUsage(S.userA.id, { inputTokens: 500, outputTokens: 60 });
  const after = await db.getAiUsageToday(S.userA.id);
  assert.equal(after.messages, before.messages + 1);
  assert.equal(after.input_tokens, before.input_tokens + 500);
  assert.equal(typeof after.input_tokens, 'number');
});

test('удаление чата каскадит сообщения; пустой title у нового чата не перетирается ассистентом', { skip }, async () => {
  const chat = await db.createAiChat(S.userA.id);
  await db.appendAiChatMessage(S.userA.id, chat.id, { role: 'assistant', content: 'сирота' });
  assert.equal((await db.getAiChat(S.userA.id, chat.id)).title, '', 'assistant не задаёт title');
  assert.equal(await db.deleteAiChat(S.userA.id, chat.id), true);
  assert.equal(await db.getAiChat(S.userA.id, chat.id), null);
  const orphans = await pool.query('SELECT count(*)::int AS c FROM ai_chat_messages WHERE chat_id=$1', [chat.id]);
  assert.equal(orphans.rows[0].c, 0, 'сообщения удалены каскадом');
});
