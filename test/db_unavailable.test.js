const test = require('node:test');
const assert = require('node:assert');
const { isDbUnavailable } = require('../server/db');

test('isDbUnavailable: true для SQLSTATE доступности Postgres', () => {
  assert.strictEqual(isDbUnavailable({ code: '53300' }), true);
  assert.strictEqual(isDbUnavailable({ code: '08006' }), true);
});

test('isDbUnavailable: true для pg-pool timeout и оборванного соединения', () => {
  assert.strictEqual(isDbUnavailable({ message: 'timeout exceeded when trying to connect' }), true);
  assert.strictEqual(isDbUnavailable({ message: 'Connection terminated unexpectedly' }), true);
});

test('isDbUnavailable: false для обычных ошибок и пустого входа', () => {
  assert.strictEqual(isDbUnavailable({ code: '23505' }), false);
  assert.strictEqual(isDbUnavailable(new Error('boom')), false);
  assert.strictEqual(isDbUnavailable(null), false);
  assert.strictEqual(isDbUnavailable(undefined), false);
});
