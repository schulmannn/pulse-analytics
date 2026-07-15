'use strict';

const { loadConfig, validateConfig, ConfigError } = require('./config');

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// Закрываем ВСЕ реальные пулы РОВНО по одному разу. composition.databases дедуплицирует случай
// backgroundDb === db (инъектированный тестовый db); фолбэк на [db] сохраняет прежнее поведение
// для composition-объектов без поля databases (напр. в тестах жизненного цикла).
function closeDatabases(composition) {
  const pools = composition.databases || [composition.db];
  return Promise.all(
    Array.from(new Set(pools.filter(Boolean))).map((pool) =>
      pool.close().catch(() => {}),
    ),
  );
}

function reportConfigErrors(config, errors) {
  if (!errors.length) return;

  if (config.isProduction) {
    console.error(
      [
        '[boot] FATAL: invalid production configuration.',
        ...errors.map((error) => `[boot] ${error.field}: ${error.message}`),
      ].join('\n'),
    );
    throw new ConfigError(errors);
  }

  for (const error of errors) {
    console.warn(`[boot:dev] config: ${error.field}: ${error.message}`);
  }
}

async function main({
  env = process.env,
  port,
  compositionFactory,
  installSignalHandlers = true,
  shutdownTimeoutMs = 25_000,
} = {}) {
  // Configuration must be known-good before application modules are loaded. Some of
  // those modules create DB/network clients at module scope for their default adapters.
  const config = loadConfig(env);
  reportConfigErrors(config, validateConfig(config));

  const createComposition =
    compositionFactory || require('./composition').createComposition;
  const composition = await createComposition(config);

  await composition.boot();
  const app = composition.createHttpApp();
  const listenPort = port != null ? port : config.http.port;
  const server = app.listen(listenPort);

  try {
    await waitForListening(server);
  } catch (error) {
    await closeDatabases(composition);
    throw error;
  }

  composition.memoryCache.start();
  // Recovery-бегунок фонового сбора: стартует ПОСЛЕ listen (не задерживает readiness); инертен при
  // выключенной БД и в composition без этого поля (тесты жизненного цикла).
  composition.collectionRunner?.start?.();
  const boundAddress = server.address();
  const boundPort =
    boundAddress && typeof boundAddress === 'object'
      ? boundAddress.port
      : listenPort;
  console.log(`[boot] Atlavue listening on http://localhost:${boundPort}`);

  let stoppedPromise = null;

  const onSignal = (signal) => {
    console.log(`[shutdown] received ${signal}`);
    stop().catch((error) => {
      console.error('[shutdown] failed:', error && error.message);
      process.exitCode = 1;
    });
  };
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');

  function removeSignalHandlers() {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }

  async function stop() {
    if (stoppedPromise) return stoppedPromise;

    stoppedPromise = (async () => {
      composition.drainState.draining = true;
      removeSignalHandlers();
      // Останавливаем планирование новых recovery-проходов ДО дренажа: уже сабмиченный проход
      // отслеживается jobTracker и дожидается в waitForIdle ниже; новые не заводятся.
      composition.collectionRunner?.stop?.();

      // Existing requests may schedule post-response tails, so stop accepting traffic
      // and let all request handlers finish before freezing the tracker.
      await closeServer(server);
      composition.jobTracker.beginDrain();
      await composition.jobTracker.waitForIdle({
        timeoutMs: shutdownTimeoutMs,
      });

      composition.memoryCache.stop();
      // Оба реальных пула (main + background) закрываются здесь РОВНО по одному разу.
      await closeDatabases(composition);
    })();

    return stoppedPromise;
  }

  if (installSignalHandlers) {
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
  }

  return { app, server, config, composition, stop };
}

module.exports = { main };
