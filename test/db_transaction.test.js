'use strict';

// Юниты db/transaction (DB-3/DB-6) на фейковом клиенте-EventEmitter — БД не нужна.
// DB-3: pg-pool снимает свой обработчик 'error' с выданного клиента, а pg Client при обрыве сокета
// делает emit('error'); без слушателя emit бросает → uncaughtException → падает весь web-процесс.
// DB-6: неудавшийся ROLLBACK оставлял соединение с открытой транзакцией и возвращал его в пул.
// Живой обрыв через pg_terminate_backend — в db_transaction.integration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTransaction } = require('../server/db/transaction');

// Минимальный контракт pg Client + pg-pool: query(sql) → Promise, release(err) — один раз;
// handler(sql) задаёт поведение запросов, this.dead — «сокет умер».
class FakeClient extends EventEmitter {
  constructor(handler = () => ({ rows: [] })) {
    super();
    this.handler = handler;
    this.calls = [];
    this.released = [];
    this.dead = false;
  }

  async query(sql) {
    this.calls.push(sql);
    if (this.dead) throw new Error('Client has encountered a connection error and is not queryable');
    return this.handler.call(this, sql);
  }

  release(err) {
    this.released.push(err);
  }
}

const fakePool = (client) => ({ connect: async () => client });

test('transaction: BEGIN/COMMIT, результат наружу, исправный клиент возвращается в пул', async () => {
  const client = new FakeClient();
  const logs = [];
  const transaction = createTransaction(fakePool(client), { onError: (...args) => logs.push(args) });

  const result = await transaction(async (c) => {
    assert.equal(c, client);
    // Пока клиент выдан, на нём висит наш обработчик 'error'.
    assert.equal(c.listenerCount('error'), 1);
    await c.query('SELECT 1');
    return 42;
  });

  assert.equal(result, 42);
  assert.deepEqual(client.calls, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.deepEqual(client.released, [undefined]);
  assert.equal(client.listenerCount('error'), 0, 'слушатель снят до release — пул вешает свой idle-обработчик');
  assert.deepEqual(logs, []);
});

test('transaction: обрыв соединения, пока клиент выдан, не бросает uncaught — клиент уничтожается через release(err) (DB-3)', async () => {
  const client = new FakeClient();
  const logs = [];
  const transaction = createTransaction(fakePool(client), { onError: (...args) => logs.push(args) });
  const dropped = new Error('terminating connection due to administrator command');

  await assert.rejects(
    transaction(async (c) => {
      // Как pg Client._handleErrorEvent: emit('error') из I/O-колбэка. Без слушателя emit бросает
      // саму ошибку — в проде это uncaughtException → handleFatal → exit(1).
      assert.doesNotThrow(() => c.emit('error', dropped));
      c.dead = true;
      // После FATAL сервера следом приходит ещё и «Connection terminated unexpectedly».
      assert.doesNotThrow(() => c.emit('error', new Error('Connection terminated unexpectedly')));
      await c.query('SELECT 1');
    }),
    /not queryable/,
    'исходная ошибка запроса пробрасывается вызывающему без изменений',
  );

  assert.deepEqual(client.calls, ['BEGIN', 'SELECT 1', 'ROLLBACK']);
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0], dropped, 'битое соединение — release(err), пул его уничтожит');
  assert.equal(client.listenerCount('error'), 0);
  // В лог — одна строка и только message (без SQL/параметров).
  assert.deepEqual(logs, [['[db] transaction client error:', dropped.message]]);
});

test('transaction: обрыв на COMMIT — ошибка наружу, клиент уничтожается', async () => {
  const client = new FakeClient(function (sql) {
    if (sql === 'COMMIT') {
      this.emit('error', new Error('Connection terminated unexpectedly'));
      this.dead = true;
      throw new Error('Connection terminated unexpectedly');
    }
    return { rows: [] };
  });
  const transaction = createTransaction(fakePool(client), { onError: () => {} });

  await assert.rejects(transaction(async () => 'ok'), /Connection terminated unexpectedly/);
  assert.equal(client.released.length, 1);
  assert.ok(client.released[0] instanceof Error);
});

test('transaction: неудавшийся ROLLBACK — наружу исходная ошибка, клиент отдаётся release(err) (DB-6)', async () => {
  const rollbackError = new Error('Query read timeout');
  const client = new FakeClient((sql) => {
    if (sql === 'ROLLBACK') throw rollbackError;
    return { rows: [] };
  });
  const transaction = createTransaction(fakePool(client), { onError: () => {} });
  const original = new Error('boom');

  await assert.rejects(
    transaction(async () => {
      throw original;
    }),
    (error) => error === original,
  );

  assert.deepEqual(client.calls, ['BEGIN', 'ROLLBACK']);
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0], rollbackError, 'соединение с незакрытой транзакцией не возвращается в пул');
  assert.equal(client.listenerCount('error'), 0);
});

test('transaction: ошибка тела при удачном ROLLBACK — клиент исправен и возвращается в пул', async () => {
  const client = new FakeClient();
  const transaction = createTransaction(fakePool(client), { onError: () => {} });
  const original = new Error('unique_violation');

  await assert.rejects(
    transaction(async (c) => {
      await c.query('INSERT 1');
      throw original;
    }),
    (error) => error === original,
  );

  assert.deepEqual(client.calls, ['BEGIN', 'INSERT 1', 'ROLLBACK']);
  assert.deepEqual(client.released, [undefined]);
});
