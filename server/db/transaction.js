'use strict';

// DB core (P2 db/core): общий BEGIN/COMMIT/ROLLBACK-хелпер. Репозитории, участвующие в составной
// транзакции, НЕ копируют connect/BEGIN/ROLLBACK/release — оборачивают тело в transaction(fn).
// Конвенция репо: метод принимает `executor = pool` по умолчанию, а внутри transaction — переданный
// client, поэтому один и тот же метод работает и автокоммитом, и как часть транзакции.
//
// Пока НЕ потребляется — инфраструктура под перенос доменов из db.js (usersRepo, channelsRepo, …);
// шесть inline-BEGIN'ов в db.js переедут на неё вместе со своими доменами.

const { pool } = require('./pool');

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { transaction };
