'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerBugsRoutes } = require('../server/routes/bugs');

function startCrashApp({ db, notionCrash }) {
  const app = express();
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  const requireAuth = (req, _res, next) => {
    req.user = { uid: 42 };
    next();
  };

  registerBugsRoutes({
    app,
    express,
    db,
    rateLimit: () => pass,
    requireAuth,
    requireSuper: pass,
    fetchWithTimeout: async () => ({ status: 204, text: async () => '' }),
    AUTH_SECRET: 'test-auth-secret',
    commitSha: 'abcdef123456',
    githubRepo: '',
    githubDispatchToken: '',
    notionCrash,
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('POST /api/client-errors awaits the atomic crash record and reuses its signature metadata', async (t) => {
  const recorded = [];
  const notionCards = [];
  const notionLinks = [];
  const db = {
    enabled: true,
    BUG_STATUSES: [],
    BUG_KINDS: [],
    async recordCrashOccurrence(fields) {
      recorded.push(fields);
      return {
        bug: { id: 77 },
        signature: { isNew: true, count: 3, notionPageId: null, lastNotified: null },
      };
    },
    async setCrashNotionPage(signature, pageId) {
      notionLinks.push({ signature, pageId });
    },
  };
  const notionCrash = {
    enabled: true,
    async createCrashCard(fields) {
      notionCards.push(fields);
      return 'notion-page-1';
    },
    async updateCrashCard() {
      assert.fail('a first occurrence must create, not update, a Notion card');
    },
  };
  const { server, url } = await startCrashApp({ db, notionCrash });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const response = await fetch(`${url}/api/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'route-test' },
    body: JSON.stringify({
      scope: 'widget',
      name: 'TypeError',
      message: 'boom',
      route: '/home',
      widgetId: 'growth',
      label: 'Рост',
      traceId: 'trace-1',
      componentStack: 'at Growth',
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: 77, traceId: 'trace-1' });
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].signature, /^[a-f0-9]{16}$/);
  assert.equal(recorded[0].commit, 'abcdef1');
  assert.equal(recorded[0].traceId, 'trace-1');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notionCards.length, 1);
  assert.equal(notionCards[0].signature, recorded[0].signature, 'Notion receives the same signature');
  assert.equal(notionCards[0].count, 3, 'Notion receives the committed ledger count');
  assert.deepEqual(notionLinks, [{ signature: recorded[0].signature, pageId: 'notion-page-1' }]);
});
