'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuditRepo } = require('../server/repos/auditRepo');

test('recordAuditEvent preserves the former db facade write contract', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  const repo = createAuditRepo({ pool, enabled: true });
  const metadata = { report_id: 17 };
  const action = 'x'.repeat(120);

  assert.equal(await repo.recordAuditEvent({
    uid: 4,
    channel_id: 9,
    action,
    request_id: 'req-1',
    ip_hash: 'hash-1',
    metadata,
  }), true);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO audit_events/);
  assert.deepEqual(calls[0].params, [4, 9, 'x'.repeat(100), 'req-1', 'hash-1', metadata]);
});

test('recordAuditEvent is a query-free no-op without DB or action', async () => {
  let queries = 0;
  const pool = { query: async () => { queries += 1; } };

  assert.equal(await createAuditRepo({ pool, enabled: false }).recordAuditEvent({ action: 'login' }), false);
  assert.equal(await createAuditRepo({ pool, enabled: true }).recordAuditEvent({ action: '' }), false);
  assert.equal(queries, 0);
});
