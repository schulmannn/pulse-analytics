// ═══════════════════════════════════════════════════════════════
//  Atlavue — внутрипроцессный operational-бегунок (отчёты + daily maintenance)
// ═══════════════════════════════════════════════════════════════
// Раньше scheduled-отчёты и дневная maintenance достигались ТОЛЬКО из хвоста удачного POST
// /api/ingest/daily — единственная внешняя зависимость. Если внешний крон пропустит/500-нёт этот
// вызов, отчёты и прунинг откладываются бесконечно. Этот бегунок делает их независимыми, оставаясь
// безопасным рядом с прежним хвостом и любым вторым вызывающим (durable job/reservation-гейты —
// авторитет):
//   • первый проход — через initialDelay после listen/boot, дальше — с интервалом interval;
//   • single-flight в процессе (пересекающийся тик пропускается, но перепланируется);
//   • каждый проход = ДВЕ независимые полосы (отчёты, maintenance) через boundedAllSettled(concurrency
//     2): обе пытаются выполниться, даже если одна падает (boundedAllSettled никогда не реджектит);
//   • работа сабмитится через jobTracker, чтобы shutdown её дожидался;
//   • unref-таймеры (не держат event loop), во время дренажа новые проходы не планируются, а stop()
//     зовётся ДО закрытия пулов БД;
//   • не работает при выключенной БД; веб-only (composition строит его независимо от recovery-режима,
//     стартует только web main.js; standalone worker строит, но НЕ стартует).
// В лог идут только безопасные статусы полос ('fulfilled'/'rejected') — никаких result/user-данных.

'use strict';

const { boundedAllSettled } = require('../lib/boundedSettled');

function createOperationalRunner({
  log = () => {},
  jobTracker,
  processReportSchedules,
  runDailyMaintenanceOnce,
  // Опциональная третья полоса: почасовой свип доставки упоминаний (mentionNotifyJob). Расписание
  // «в какой час/дни слать» живёт в самой подписке; свип лишь даёт тик чаще раза в день.
  processMentionNotify = null,
  // Канонический публичный origin (config.http.publicUrl) — базой для ссылок в письмах отчётов;
  // request-объекта здесь нет, поэтому appBase(req) недоступен.
  publicUrl,
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
        // Независимые полосы под concurrency 2: отчёты (собственный durable per-report/period
        // reservation-гейт и внутренний bounded dispatch), maintenance (durable per-UTC-day гейт)
        // и — если передана — доставка упоминаний (durable per-МСК-day гейт per-подписка).
        // boundedAllSettled НИКОГДА не реджектит, поэтому каждая полоса пытается выполниться,
        // даже если соседняя бросает.
        const lanes = [
          () => processReportSchedules(publicUrl),
          () => runDailyMaintenanceOnce(),
          ...(processMentionNotify ? [() => processMentionNotify()] : []),
        ];
        const [rep, maint, mentions] = await boundedAllSettled(lanes, (fn) => fn(), 2);
        // Только безопасные статусы — ни result, ни user-данные в лог не попадают.
        log('info', 'operational_pass_done', {
          rep: rep.status,
          maint: maint.status,
          ...(mentions ? { mentions: mentions.status } : {}),
        });
      }, { job: 'operational_pass' });
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

module.exports = { createOperationalRunner };
