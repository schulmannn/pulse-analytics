// ═══════════════════════════════════════════════════════════════
//  Atlavue — standalone recovery worker (без HTTP)
//  Node.js
// ═══════════════════════════════════════════════════════════════
// Отдельный Railway-процесс, который владеет ТОЛЬКО recovery-бегунком фонового сбора и не поднимает
// HTTP-listener. Переиспользует общий граф зависимостей (createComposition) и тот же бегунок, что и
// web в режиме `inline` — продуктовая логика сбора не дублируется. Контракт:
//   • COLLECTION_RECOVERY_MODE обязан быть `worker` — иначе процесс не стартует (не молчит в inline);
//   • JOBS_MODE (гейт web-планировщиков в server/main.js) worker ИГНОРИРУЕТ: смысл worker-процесса —
//     всегда гонять свои джобы, поэтому «те же env, что у web» (включая JOBS_MODE=off) его не гасят;
//   • БД обязана быть включена и достижима — иначе процесс падает явно, а не «выглядит здоровым» вхолостую;
//   • recovery-бегунок использует unref-таймеры (не держат event loop), поэтому процесс держится живым
//     собственным ref-таймером-keepalive до явной остановки;
//   • SIGTERM/SIGINT и фатальные ошибки: сперва прекращаем планирование, гасим keepalive, дренажим
//     jobTracker, останавливаем кэш-таймеры и закрываем каждый реальный пул РОВНО по одному разу —
//     bounded-семантика согласована с server/main.js.

'use strict';

const { loadConfig, validateConfig } = require('./config');
const { closeDatabases, reportConfigErrors } = require('./main');

async function runWorker({
  env = process.env,
  compositionFactory,
  installSignalHandlers = true,
  shutdownTimeoutMs = 25_000,
  // Fatal-runtime policy knobs (DI so lifecycle tests never terminate the test runner) — как в main.js.
  exit = (code) => process.exit(code),
  fatalExitTimeoutMs = 10_000,
  // Keepalive-таймер (DI для тестов): ref-таймер держит event loop, пока бегунок жив.
  keepAliveMs = 1 << 30,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const config = loadConfig(env);
  reportConfigErrors(config, validateConfig(config));

  // Worker-entrypoint не должен молча работать в неверном режиме: inline/external — это web-режимы,
  // а worker обязан быть явным `worker`. Иначе запуск worker рядом с inline-web удвоил бы сбор.
  if (config.runtime.collectionRecoveryMode !== 'worker') {
    throw new Error(
      `[worker] COLLECTION_RECOVERY_MODE обязан быть 'worker' для standalone recovery-процесса ` +
        `(получено '${config.runtime.collectionRecoveryMode}'); web-процесс запускается через server/index.js.`,
    );
  }

  // JOBS_MODE — гейт ТОЛЬКО web-планировщиков (server/main.js). Worker-сервису Railway копирует env
  // web-сервиса, поэтому здесь может оказаться JOBS_MODE=off — worker его сознательно игнорирует
  // (иначе «выключенный web» выключил бы и worker, и джобы не гонял бы никто). Логируем для ops.
  if (env.JOBS_MODE !== undefined) {
    console.log('[worker] JOBS_MODE игнорируется: worker всегда гоняет свои джобы (гейт относится только к web)');
  }

  const createComposition =
    compositionFactory || require('./composition').createComposition;
  const composition = await createComposition(config);

  // DB-disabled/misconfigured worker обязан падать явно, а не выглядеть здоровым, ничего не собирая.
  // Проверяем ВСЕ реальные пулы (main + background дедуплицированы в composition.databases).
  const pools = Array.from(
    new Set((composition.databases || [composition.db, composition.backgroundDb]).filter(Boolean)),
  );
  const dbEnabled = pools.length > 0 && pools.every((pool) => pool.enabled);
  if (!dbEnabled) {
    await closeDatabases(composition);
    throw new Error(
      '[worker] recovery worker требует включённую БД (DATABASE_URL); отказ работать вхолостую.',
    );
  }

  await composition.boot();

  // boot() намеренно глотает сбой db.init (web остаётся живым с dbReady=false). У worker такого
  // фолбэка нет — активно доказываем достижимость каждого пула и падаем явно, если БД недоступна.
  try {
    await Promise.all(pools.map((pool) => pool.ping()));
  } catch (error) {
    await closeDatabases(composition);
    throw new Error(`[worker] БД недостижима при старте: ${error && error.message}`);
  }

  // Ref-таймер keepalive: бегунок планируется unref-таймерами и не держит event loop, HTTP-listener'а
  // тоже нет, поэтому без keepalive процесс просто вышел бы. Гасится в stop() → чистое завершение.
  const keepAlive = setIntervalFn(() => {}, keepAliveMs);

  composition.collectionRunner?.start?.();
  console.log('[worker] Atlavue recovery worker запущен (без HTTP-listener)');

  let stoppedPromise = null;

  const onSignal = (signal) => {
    console.log(`[worker:shutdown] received ${signal}`);
    stop().catch((error) => {
      console.error('[worker:shutdown] failed:', error && error.message);
      process.exitCode = 1;
    });
  };
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');

  // Фатальная ошибка оставляет процесс в неизвестном состоянии → не глотаем: дренажим один раз и
  // выходим с кодом 1. Single-flight + bounded forced-exit таймер (как в server/main.js).
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
    console.error(`[worker:fatal] ${kind} — draining then exit(1):`, detail);

    const forced = setTimeout(() => {
      console.error(`[worker:fatal] ${kind}: forced exit after ${fatalExitTimeoutMs}ms (drain did not finish)`);
      exitFatal();
    }, fatalExitTimeoutMs);
    fatalHandling = stop()
      .catch((error) => {
        console.error('[worker:fatal] shutdown failed:', error && error.message);
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
      if (composition.drainState) composition.drainState.draining = true;
      removeSignalHandlers();
      // Прекращаем планирование новых проходов ДО дренажа: уже сабмиченный проход отслеживается
      // jobTracker и дожидается в waitForIdle ниже; новые не заводятся.
      composition.collectionRunner?.stop?.();
      // Keepalive больше не нужен — после дренажа процесс обязан суметь выйти сам.
      clearIntervalFn(keepAlive);

      composition.jobTracker.beginDrain();
      await composition.jobTracker.waitForIdle({ timeoutMs: shutdownTimeoutMs });

      // Кэш-свип worker не запускает (нет HTTP), но stop() идемпотентен — гасим на всякий случай.
      composition.memoryCache?.stop?.();
      // Оба реальных пула (main + background) закрываются здесь РОВНО по одному разу.
      await closeDatabases(composition);
    })();

    return stoppedPromise;
  }

  if (installSignalHandlers) {
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    process.on('uncaughtException', onUncaughtException);
    process.on('unhandledRejection', onUnhandledRejection);
  }

  return { config, composition, stop, handleFatal };
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  runWorker().catch((error) => {
    console.error('[worker] fatal:', error && error.message);
    process.exit(1);
  });
}

module.exports = { runWorker };
