'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotionCrashClient } = require('../server/lib/notion_crash');

test('Notion crash client is inert without the injected config pair', async () => {
  let calls = 0;
  const client = createNotionCrashClient(
    {},
    {
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );

  assert.equal(client.enabled, false);
  assert.equal(await client.createCrashCard({}), null);
  assert.equal(calls, 0);
});

test('Notion crash client uses injected credentials and database id', async () => {
  const calls = [];
  const client = createNotionCrashClient(
    { token: 'token', crashDatabaseId: 'database-id' },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ id: 'page-id' }) };
      },
    },
  );

  const pageId = await client.createCrashCard({
    scope: 'app',
    name: 'Error',
    message: 'boom',
    count: 1,
    at: '2026-07-13T00:00:00.000Z',
  });

  assert.equal(client.enabled, true);
  assert.equal(pageId, 'page-id');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.equal(
    JSON.parse(calls[0].options.body).parent.database_id,
    'database-id',
  );
});
