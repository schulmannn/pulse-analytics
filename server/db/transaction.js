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
//
// Жизненный цикл выданного клиента (DB-3/DB-6):
// - pg-pool на время выдачи снимает свой idle-обработчик 'error', а pg Client при обрыве сокета
//   (рестарт Postgres, pg_terminate_backend, сетевой сбой) делает emit('error'). Без нашего
//   слушателя это uncaughtException → handleFatal → весь web-процесс падает. Поэтому слушатель
//   висит всё время, пока клиент у нас, и лишь помечает соединение битым (сама ошибка и так
//   придёт в ожидающий query → catch ниже).
// - Битый клиент и клиент с неудавшимся ROLLBACK (состояние соединения неизвестно: транзакция
//   могла остаться открытой) отдаём через release(err) — пул уничтожает соединение, а не
//   возвращает его, иначе чужие автокоммит-запросы молча уйдут в «висящую» транзакцию.
// В лог — только message: без SQL и параметров запросов.
function createTransaction(pool, { onError = console.error } = {}) {
  return async function transaction(fn) {
    const client = await pool.connect();
    let broken = null;
    const onClientError = (error) => {
      if (broken) return; // после FATAL сервера следом приходит ещё и обрыв сокета — логируем один раз
      broken = error || new Error('db client error');
      onError('[db] transaction client error:', error?.message);
    };
    client.on('error', onClientError);
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        if (!broken) broken = rollbackError || new Error('ROLLBACK failed');
      });
      throw error;
    } finally {
      client.removeListener('error', onClientError);
      client.release(broken || undefined);
    }
  };
}

module.exports = { createTransaction };
