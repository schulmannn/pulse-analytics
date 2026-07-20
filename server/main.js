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
  // Fatal-runtime policy knobs (DI so lifecycle tests never terminate the test runner):
  // `exit` records the code instead of killing Node, and a short `fatalExitTimeoutMs`
  // exercises the forced-exit timer without a real hang.
  exit = (code) => process.exit(code),
  fatalExitTimeoutMs = 10_000,
} = {}) {
  // Configuration must be known-good before application modules are loaded. Some of
  // those modules create DB/network clients at module scope for their default adapters.
  const config = loadConfig(env);
  reportConfigErrors(config, validateConfig(config));

  // `worker` — режим standalone recovery-процесса (server/worker.js), а не web. Web-entrypoint отвергает
  // его до создания composition, чтобы web не мог случайно стартовать как worker (и не поднял HTTP+сбор
  // там, где ожидается только worker). `inline`/`external` — валидные web-режимы (см. composition:
  // external не планирует бегунок).
  if (config.runtime.collectionRecoveryMode === 'worker') {
    throw new Error(
      "[boot] COLLECTION_RECOVERY_MODE=worker недопустим для web-процесса; запусти server/worker.js (npm run worker).",
    );
  }

  // JOBS_MODE — web-гейт периодических планировщиков (готовность к выносу джоб в отдельный
  // Railway-сервис, см. docs/WORKER.md):
  //   • 'inline' (дефолт) — прежнее поведение: web стартует collection- и operational-бегунки;
  //   • 'off'    — web НЕ планирует периодические джобы (оба бегунка собраны composition, но не
  //     стартуют). HTTP/health и вся по-запросу работа — ingest-хвосты POST /api/ingest/daily,
  //     kick бэкфилла POST /api/ms/backfill — работают как раньше: они request-driven и этим
  //     гейтом не покрываются.
  // Неизвестное значение фатально сразу (та же философия, что typo в COLLECTION_RECOVERY_MODE):
  // молчаливый фолбэк в 'inline' рядом с работающим worker удвоил бы запуск джобов (ADR-002).
  // Worker-entrypoint (server/worker.js) этот гейт игнорирует — его смысл всегда гонять джобы.
  const jobsMode = String(env.JOBS_MODE || 'inline').trim().toLowerCase();
  if (!['inline', 'off'].includes(jobsMode)) {
    throw new Error(
      `[boot] JOBS_MODE должен быть 'inline' или 'off' (получено '${env.JOBS_MODE}').`,
    );
  }

  const createComposition =
    compositionFactory || require('./composition').createComposition;
  const composition = await createComposition(config);

  await composition.boot();
  const app = composition.createHttpApp();
  const listenPort = port != null ? port : config.http.port;
  const server = app.listen(listenPort);

  // Явные HTTP-таймауты выставляются СИНХРОННО сразу после app.listen (до await'а listening), чтобы
  // ни одно соединение не могло попасть на дефолтный 5-секундный keepAliveTimeout Node — короче
  // 60-секундного keep-alive Railway-прокси. headersTimeout держим строго больше keepAliveTimeout
  // (требование Node). server.timeout НАМЕРЕННО не трогаем — он остаётся 0 (нет тайм-аута простоя
  // in-flight сокета), иначе долгий стриминговый ответ GDPR-экспорта обрывался бы на полпути.
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.headersTimeout = config.http.headersTimeoutMs;
  server.requestTimeout = config.http.requestTimeoutMs;

  try {
    await waitForListening(server);
  } catch (error) {
    await closeDatabases(composition);
    throw error;
  }

  composition.memoryCache.start();
  if (jobsMode !== 'off') {
    // Recovery-бегунок фонового сбора: стартует ПОСЛЕ listen (не задерживает readiness); инертен при
    // выключенной БД и в composition без этого поля (тесты жизненного цикла).
    composition.collectionRunner?.start?.();
    // Operational-бегунок (scheduled-отчёты + дневная maintenance): стартует web-only ПОСЛЕ listen
    // рядом с collection runner; инертен при выключенной БД и в composition без этого поля (тесты
    // жизненного цикла). Standalone worker его НЕ стартует.
    composition.operationalRunner?.start?.();
  } else {
    // JOBS_MODE=off: периодические джобы гоняет отдельный worker-процесс (docs/WORKER.md).
    // stop() ниже всё равно зовёт runner.stop() — он идемпотентен и безопасен для не-стартовавшего.
    console.log('[boot] JOBS_MODE=off — web не планирует периодические джобы (их гоняет worker)');
  }
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

  // Explicit fatal-runtime policy: an uncaughtException / unhandledRejection leaves the process in an
  // unknown state, so it is NOT swallowed — we drain once and exit non-zero. Single-flight (a second
  // fault while draining is ignored), and a bounded forced-exit timer guarantees a hung close/drain
  // can never leave a corrupted process alive. Installed only alongside production-style signal
  // handlers; normal SIGTERM/SIGINT keep their graceful, natural-exit behavior above.
  let fatalHandling = null;
  let fatalExitStarted = false;
  function exitFatal() {
    if (fatalExitStarted) return;
    fatalExitStarted = true;
    exit(1);
  }
  function handleFatal(kind, reason) {
    if (fatalHandling) return fatalHandling;
    process.exitCode = 1;
    const detail = reason && (reason.stack || reason.message) ? reason.stack || reason.message : reason;
    console.error(`[fatal] ${kind} — draining then exit(1):`, detail);

    const forced = setTimeout(() => {
      console.error(`[fatal] ${kind}: forced exit after ${fatalExitTimeoutMs}ms (drain did not finish)`);
      exitFatal();
    }, fatalExitTimeoutMs);

    fatalHandling = stop()
      .catch((error) => {
        console.error('[fatal] shutdown failed:', error && error.message);
      })
      .finally(() => {
        clearTimeout(forced);
        exitFatal();
      });
    return fatalHandling;
  }
  const onUncaughtException = (error) => handleFatal('uncaughtException', error);
  const onUnhandledRejection = (reason) => handleFatal('unhandledRejection', reason);

  function removeSignalHandlers() {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }

  async function stop() {
    if (stoppedPromise) return stoppedPromise;

    stoppedPromise = (async () => {
      composition.drainState.draining = true;
      removeSignalHandlers();
      // Останавливаем планирование новых recovery-проходов ДО дренажа: уже сабмиченный проход
      // отслеживается jobTracker и дожидается в waitForIdle ниже; новые не заводятся.
      composition.collectionRunner?.stop?.();
      // Operational-бегунок гасится симметрично — ДО дренажа: уже сабмиченный проход дожидается
      // jobTracker в waitForIdle ниже; новые проходы не заводятся.
      composition.operationalRunner?.stop?.();

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
    // Fatal runtime faults are owned here too (server/index.js keeps only the boot-time catch).
    process.on('uncaughtException', onUncaughtException);
    process.on('unhandledRejection', onUnhandledRejection);
  }

  return { app, server, config, composition, stop, handleFatal };
}

// closeDatabases/reportConfigErrors переиспользует standalone worker (server/worker.js), чтобы
// bounded-shutdown и репорт конфиг-ошибок были байт-в-байт согласованы между web и worker.
module.exports = { main, closeDatabases, reportConfigErrors };
