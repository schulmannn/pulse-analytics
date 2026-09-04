'use strict';

/**
 * ЖИЗНЕННЫЙ ЦИКЛ ФОНОВОГО БЕГУНКА — один на все (аудит #554, «шесть источников, три поколения
 * паттернов»).
 *
 * `operationalRunner` и `collectionRecoveryRunner` держали ОДИН И ТОТ ЖЕ код побайтово: single-flight
 * гвард, обёртка прохода в jobTracker, планировщик с unref, идемпотентные start/stop и возвращаемый
 * объект — около шестидесяти строк в каждом. Различался только сам проход и его метка в трекере.
 *
 * Копия опасна не размером, а тем, что чинится она по одной: правка гейта дренажа или семантики
 * `stop()` в одном бегунке молча оставляла второй на старом поведении.
 *
 * Здесь живёт цикл, а вызывающий приносит только `pass` — тело прохода — и `job` — метку.
 */

/**
 * @param {object} deps
 * @param {{ run: (fn: Function) => Promise<any> }} deps.jobTracker трекер фоновых задач; сам глотает
 *   ошибки прохода и во время дренажа отклоняет новую работу (`{ accepted: false }`).
 * @param {string} deps.job метка прохода в трекере.
 * @param {() => Promise<void>} deps.pass тело одного прохода.
 * @param {number} deps.intervalMs период между проходами.
 * @param {number} deps.initialDelayMs задержка первого прохода после start().
 * @param {boolean} [deps.enabled] выключённый бегунок не планирует и не выполняет ничего.
 * @param {Function} [deps.setTimeoutFn] инъекции для тестов (детерминированные таймеры).
 * @param {Function} [deps.clearTimeoutFn]
 */
function createIntervalRunner({
  jobTracker,
  job,
  pass,
  intervalMs,
  initialDelayMs,
  enabled = true,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let timer = null;
  let running = false; // in-process single-flight
  let stopped = false;
  let started = false;

  // Один проход, защищённый in-process single-flight: перекрывающийся вызов (гонка таймера или
  // ручной триггер) сразу выходит, не удваивая работу. Возвращается наружу (`runOnce`) — тестируемо
  // и пригодно как ручной триггер.
  async function runOnce() {
    if (!enabled || stopped) return { skipped: true };
    if (running) return { skipped: true }; // single-flight: не запускаем перекрывающийся проход
    running = true;
    try {
      // jobTracker.run сам глотает ошибки задачи и во время дренажа отклоняет новую работу
      // ({ accepted:false }) — тогда проход просто не выполняется. Дожидаемся, чтобы single-flight
      // держался до конца реальной работы прохода.
      const result = await jobTracker.run(pass, { job });
      if (result && result.accepted === false) return { skipped: true };
      return { skipped: false };
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimeoutFn(tick, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    await runOnce();
    if (!stopped) schedule(intervalMs); // перепланируем только если ещё не остановлены
  }

  // Стартует бегунок: один раз, не в DB-disabled режиме, не после stop(). Первый проход отложен.
  function start() {
    if (!enabled || started || stopped) return;
    started = true;
    schedule(initialDelayMs);
  }

  // Останавливает планирование новых проходов и гасит таймер. Идемпотентен. Уже сабмиченный в
  // jobTracker проход дожидается сам tracker в waitForIdle.
  function stop() {
    stopped = true;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce,
    get isRunning() {
      return running;
    },
    get isStopped() {
      return stopped;
    },
  };
}

module.exports = { createIntervalRunner };
