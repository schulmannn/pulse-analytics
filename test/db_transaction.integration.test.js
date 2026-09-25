'use strict';

// Integration db/transaction (DB-3/DB-6) на РЕАЛЬНОМ Postgres через серверные createPool +
// createTransaction. Без TEST_DATABASE_URL — SKIP. Локальный стенд:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test
// DB-3: pg_terminate_backend бэкенда транзакции (как рестарт Postgres на Railway) раньше давал
// uncaughtException («Connection terminated unexpectedly» / «terminating connection due to
// administrator command») — node:test валит на нём тест. Теперь транзакция штатно реджектится,
// процесс жив, а пул продолжает работать на новом соединении.
// DB-6: клиентский query_timeout снимает и сам запрос, и ROLLBACK за ним — соединение с открытой
// транзакцией раньше возвращалось в пул, и следующий «автокоммит» пул.query шёл внутрь неё.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../server/db/pool');
const { createTransaction } = require('../server/db/transaction');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let admin = null;

test.before(async () => {
  if (!TEST_DB) return;
  const pg = require('pg');
  admin = new pg.Pool({ connectionString: TEST_DB, max: 1, ssl: false });
});

test.after(async () => {
  if (admin) await admin.end();
});

// poolMax 1: пул обязан отдать следующему запросу либо ТО ЖЕ соединение, либо новое — по pid видно,
// выкинул ли он битого клиента.
function makeTx(overrides = {}) {
  const core = createPool(
    { url: TEST_DB, sslMode: process.env.PGSSL || 'disable', poolMax: 1, ...overrides },
    { onError: () => {} },
  );
  const logs = [];
  const transaction = createTransaction(core.pool, { onError: (...args) => logs.push(args) });
  return { core, transaction, logs };
}

async function backendPid(pool) {
  const { rows } = await pool.query('SELECT pg_backend_pid() AS pid');
  return rows[0].pid;
}

test('transaction: обрыв бэкенда во время активного запроса — reject вместо падения процесса, пул жив', { skip }, async () => {
  const { core, transaction, logs } = makeTx();
  let txPid = null;
  try {
    await assert.rejects(
      transaction(async (client) => {
        txPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        setTimeout(() => admin.query('SELECT pg_terminate_backend($1)', [txPid]).catch(() => {}), 200);
        await client.query('SELECT pg_sleep(3)');
      }),
      /terminat/i,
    );
    const nextPid = await backendPid(core.pool);
    assert.notEqual(nextPid, txPid, 'битое соединение не вернулось в пул');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[db] transaction client error:');
  } finally {
    await core.close();
  }
});

test('transaction: обрыв бэкенда, пока клиент простаивает внутри транзакции — reject, пул жив', { skip }, async () => {
  const { core, transaction } = makeTx();
  let txPid = null;
  try {
    await assert.rejects(
      transaction(async (client) => {
        txPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await admin.query('SELECT pg_terminate_backend($1)', [txPid]);
        // Клиент ни о чём не спрашивает — FATAL приходит «сам», emit('error') без активного запроса.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query('SELECT 1');
      }),
      /connection error|terminat/i,
    );
    const nextPid = await backendPid(core.pool);
    assert.notEqual(nextPid, txPid);
  } finally {
    await core.close();
  }
});

test('transaction: ROLLBACK снят по query_timeout — соединение с открытой транзакцией не возвращается в пул (DB-6)', { skip }, async () => {
  // query_timeout короче ответа сервера эмулирует сетевой стопор: запрос остаётся на соединении,
  // ROLLBACK ждёт за ним в очереди и сам снимается по таймауту, так и не будучи отправленным.
  const { core, transaction } = makeTx({ queryTimeoutMs: 250 });
  let txPid = null;
  try {
    await assert.rejects(
      transaction(async (client) => {
        txPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await client.query('SELECT pg_sleep(1.5)');
      }),
      /Query read timeout/,
    );
    // Свой query_timeout: на старом коде запрос ждёт за «висящим» pg_sleep и выполняется внутри
    // незакрытой транзакции (тот же pid, now() — время её начала), а не падает по таймауту.
    const { rows } = await core.pool.query({
      text: 'SELECT pg_backend_pid() AS pid, now() = statement_timestamp() AS autocommit',
      query_timeout: 5000,
    });
    assert.notEqual(rows[0].pid, txPid, 'клиент с неудавшимся ROLLBACK уничтожен');
    assert.equal(rows[0].autocommit, true, 'следующий запрос не попал в чужую незакрытую транзакцию');
  } finally {
    await core.close();
  }
});
