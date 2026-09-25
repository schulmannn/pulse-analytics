'use strict';

// Юниты runMigrations: жизненный цикл выданного клиента (DB-3/DB-6) на фейковом EventEmitter-клиенте.
// Обрыв соединения посреди миграции не должен становиться uncaughtException, а битый клиент
// (обрыв, неудавшийся ROLLBACK или pg_advisory_unlock) — возвращаться в пул: release(err).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runMigrations, MIGRATIONS_DIR } = require('../server/migrations');

const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
const LAST = FILES[FILES.length - 1];
const LAST_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, LAST), 'utf8').trim();

// applied — какие файлы уже в schema_migrations; fail(sql) — вернуть ошибку для запроса или null.
class FakeClient extends EventEmitter {
  constructor({ applied = FILES, fail = () => null, onQuery = () => {} } = {}) {
    super();
    this.applied = applied;
    this.fail = fail;
    this.onQuery = onQuery;
    this.calls = [];
    this.released = [];
  }

  async query(sql) {
    const text = String(sql).trim();
    this.calls.push(text);
    this.onQuery.call(this, text);
    const error = this.fail(text);
    if (error) throw error;
    if (text === 'SELECT version FROM schema_migrations') {
      return { rows: this.applied.map((version) => ({ version })) };
    }
    return { rows: [] };
  }

  release(err) {
    this.released.push(err);
  }
}

const fakePool = (client) => ({ connect: async () => client });
// Контракт logger'а в тестах — только .log.
const quietLogger = (lines = []) => ({ log: (line) => lines.push(line) });

test('runMigrations: всё применено — клиент возвращается в пул исправным, слушатель снят', async () => {
  const client = new FakeClient({
    onQuery() {
      assert.equal(this.listenerCount('error'), 1, 'пока клиент выдан, на нём висит обработчик error');
    },
  });

  const files = await runMigrations(fakePool(client), quietLogger());

  assert.deepEqual(files, FILES);
  assert.equal(client.calls.at(-1), 'SELECT pg_advisory_unlock($1)');
  assert.deepEqual(client.released, [undefined]);
  assert.equal(client.listenerCount('error'), 0);
});

test('runMigrations: обрыв соединения посреди прогона не бросает uncaught — клиент уничтожается (DB-3)', async () => {
  const dropped = new Error('Connection terminated unexpectedly');
  let emitThrew = null;
  const client = new FakeClient({
    onQuery(text) {
      if (text !== 'SELECT version FROM schema_migrations') return;
      // Как pg Client._handleErrorEvent: emit('error') из I/O-колбэка, вне чьего-либо try.
      try {
        this.emit('error', dropped);
        emitThrew = false;
      } catch (_) {
        emitThrew = true;
      }
    },
    fail: (text) => (text === 'SELECT version FROM schema_migrations' || text.startsWith('SELECT pg_advisory_unlock')
      ? new Error('Client has encountered a connection error and is not queryable')
      : null),
  });
  const lines = [];

  await assert.rejects(runMigrations(fakePool(client), quietLogger(lines)), /not queryable/);

  assert.equal(emitThrew, false, 'emit(error) без слушателя = uncaughtException в проде');
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0], dropped);
  assert.equal(client.listenerCount('error'), 0);
  assert.deepEqual(lines, ['[db] migration client error: Connection terminated unexpectedly']);
});

test('runMigrations: упавшая миграция + неудавшийся ROLLBACK — наружу ошибка миграции, release(err) (DB-6)', async () => {
  const rollbackError = new Error('Query read timeout');
  const client = new FakeClient({
    applied: FILES.slice(0, -1),
    fail: (text) => {
      if (text === 'ROLLBACK') return rollbackError;
      if (text === LAST_SQL) return new Error('syntax error at or near "BOOM"');
      return null;
    },
  });

  await assert.rejects(
    runMigrations(fakePool(client), quietLogger()),
    (error) => error.message === `migration ${LAST} failed: syntax error at or near "BOOM"`,
  );
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0], rollbackError, 'соединение в неизвестном состоянии не возвращается в пул');
});

test('runMigrations: неудавшийся pg_advisory_unlock — клиент с удержанной блокировкой уничтожается', async () => {
  const unlockError = new Error('Query read timeout');
  const client = new FakeClient({
    fail: (text) => (text.startsWith('SELECT pg_advisory_unlock') ? unlockError : null),
  });

  const files = await runMigrations(fakePool(client), quietLogger());

  assert.deepEqual(files, FILES);
  assert.deepEqual(client.released, [unlockError]);
});
