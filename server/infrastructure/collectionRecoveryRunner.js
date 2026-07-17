// ═══════════════════════════════════════════════════════════════
//  Atlavue — внутрипроцессный recovery-бегунок фонового сбора
// ═══════════════════════════════════════════════════════════════
// Мы НЕ можем поднять отдельный Railway-сервис в этом code-only релизе, поэтому возобновление
// незавершённого сбора живёт в web-процессе как безопасный бегунок:
//   • первый проход — через initialDelay после listen/boot, дальше — с интервалом interval;
//   • single-flight в процессе (пересекающийся тик пропускается, но перепланируется);
//   • каждый проход = один IG-проход + один TG QR-батч; их item-level runJobOnce делает повторные
//     проходы идемпотентными и добирающими остаток того же дня (завершённое пропускается);
//   • работа сабмитится через jobTracker, чтобы shutdown её дожидался;
//   • unref-таймеры (не держат event loop), во время дренажа новые проходы не планируются, а stop()
//     зовётся ДО закрытия пулов БД;
//   • не работает при выключенной БД и не задерживает readiness/HTTP-ответы (таймер после listen).
// Дорогой прунинг/rollup сюда НЕ входит (см. persistenceJob.runDailyMaintenance) — только сбор.

'use strict';

function createCollectionRecoveryRunner({
  log = () => {},
  jobTracker,
  runIgCollectionPass,
  processTgQrCollection,
  // Bounded, best-effort central-channel cover repair (fills tg_post_media so the open thumb proxy stops
  // 503-ing). Optional so pure-scheduler tests need not inject it; defaults to an inert no-op.
  repairCentralMedia = async () => ({ skipped: true }),
  // Дневной сбор МойСклада (jobs/msCollectionJob) — едет тем же планировщиком/интервалом, что
  // IG-проход; внутри свой durable day-gate, так что реальная работа случается раз в день.
  // Optional (inert no-op) — pure-scheduler тесты и composition без МС-вертикали не задеты.
  runMsCollectionPass = async () => ({ skipped: true }),
  igCap,
  tgCap,
  mediaCap,
  mediaWindowDays,
  initialDelayMs,
  intervalMs,
  enabled = true,
  // Инъекции для тестов (детерминированные таймеры).
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let timer = null;
  let running = false;   // in-process single-flight
  let stopped = false;
  let started = false;

  // Один проход, защищённый in-process single-flight: перекрывающийся вызов (гонка таймера или
  // ручной триггер) сразу выходит, не удваивая работу. Возвращается наружу (`runOnce`) — тестируемо
  // и пригодно как ручной триггер.
  async function runOnce() {
    if (!enabled || stopped) return { skipped: true };
    if (running) return { skipped: true };   // single-flight: не запускаем перекрывающийся проход
    running = true;
    try {
      // jobTracker.run сам глотает ошибки задачи и во время дренажа отклоняет новую работу
      // ({ accepted:false }) — тогда проход просто не выполняется. Дожидаемся, чтобы single-flight
      // держался до конца реальной работы прохода.
      const result = await jobTracker.run(async () => {
        // IG, Telegram и МойСклад — независимые upstream'ы и идут параллельными lanes. Внутри
        // Telegram lane обычный QR-сбор и узкий central-media repair идут ПОСЛЕДОВАТЕЛЬНО: один
        // пользовательский session не получает два одновременных MTProto fan-out, а repair не
        // превращается в лишнюю конкурентную pipeline. Каждая lane изолирует свой сбой и
        // наследует общий lifecycle/gating.
        const [ig, tgLane, ms] = await Promise.all([
          runIgCollectionPass({ cap: igCap })
            .catch((e) => { log('error', 'recovery_ig_pass_failed', { error: e.message }); return null; }),
          (async () => {
            const tg = await processTgQrCollection({ cap: tgCap })
              .catch((e) => { log('error', 'recovery_tg_pass_failed', { error: e.message }); return null; });
            const media = await repairCentralMedia({ cap: mediaCap, windowDays: mediaWindowDays })
              .catch((e) => { log('error', 'recovery_media_pass_failed', { error: e.message }); return null; });
            return { tg, media };
          })(),
          runMsCollectionPass()
            .catch((e) => { log('error', 'recovery_ms_pass_failed', { error: e.message }); return null; }),
        ]);
        const { tg, media } = tgLane;
        log('info', 'collection_recovery_pass_done', { ig, tg, media, ms });
      }, { job: 'collection_recovery_pass' });
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
    if (!stopped) schedule(intervalMs);   // перепланируем только если ещё не остановлены
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
    if (timer) { clearTimeoutFn(timer); timer = null; }
  }

  return {
    start,
    stop,
    runOnce,
    get isRunning() { return running; },
    get isStopped() { return stopped; },
  };
}

module.exports = { createCollectionRecoveryRunner };
