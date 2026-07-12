'use strict';

// DB core (P2 db/core): общий BEGIN/COMMIT/ROLLBACK-хелпер как ФАБРИКА над инъектированным пулом.
// Репозитории, участвующие в составной транзакции, НЕ копируют connect/BEGIN/ROLLBACK/release —
// оборачивают тело в transaction(fn). Конвенция репо: метод принимает `executor = pool` по
// умолчанию, а внутри transaction — переданный client, поэтому один и тот же метод работает и
// автокоммитом, и как часть транзакции.
//
// Почему фабрика, а не singleton-импорт pool: репозитории получают pool через DI (createXRepo({pool}))
// — тот же путь должен быть у транзакции, иначе появляется второй способ достать DB-зависимость и
// helper нельзя протестировать с тестовым пулом. Композиция (db.js) создаёт один `transaction` из
// своего пула и инжектит его в репо; ручные inline-BEGIN'ы переезжают на него.
function createTransaction(pool) {
  return async function transaction(fn) {
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
  };
}

module.exports = { createTransaction };
