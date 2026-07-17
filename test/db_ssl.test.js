'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let sslForDatabase;
test.before(async () => {
  ({ sslForDatabase } = await import('../ops/db-ssl.mjs'));
});

test('operator DB tools verify external auto connections and preserve private/local behavior', () => {
  assert.deepEqual(sslForDatabase('postgres://public.example/db', {}), { rejectUnauthorized: true });
  assert.equal(sslForDatabase('postgres://db.railway.internal/db', {}), false);
  assert.equal(sslForDatabase('postgres://localhost/db', {}), false);
});

test('operator DB tools require an explicit choice for weaker TLS and reject mode typos', () => {
  assert.deepEqual(sslForDatabase('postgres://public.example/db', { PGSSLMODE: 'VERIFY-FULL' }), {
    rejectUnauthorized: true,
  });
  assert.deepEqual(sslForDatabase('postgres://public.example/db', { PGSSL: 'require' }), {
    rejectUnauthorized: false,
  });
  assert.equal(sslForDatabase('postgres://public.example/db', { PGSSL: 'disable' }), false);
  assert.throws(() => sslForDatabase('postgres://public.example/db', { PGSSL: 'bogus' }), /must be one of/);
});
