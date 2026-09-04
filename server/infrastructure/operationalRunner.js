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

const { createIntervalRunner } = require('./intervalRunner');

const { boundedAllSettled } = require('../lib/boundedSettled');

function createOperationalRunner({
  log = () => {},
  jobTracker,
  processReportSchedules,
  runDailyMaintenanceOnce,
  // Опциональная третья полоса: почасовой свип доставки упоминаний (mentionNotifyJob). Расписание
  // «в какой час/дни слать» живёт в самой подписке; свип лишь даёт тик чаще раза в день.
  processMentionNotify = null,
  // Опциональная четвёртая полоса: проактивное продление токенов Instagram (igTokenRefreshJob).
  // Раньше продление происходило только при чтении экрана — аккаунт, на который перестали смотреть,
  // молча доезжал до истечения. Полоса идемпотентна: окно перепроверяется на каждом продлении.
  processIgTokenRefresh = null,
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
  // Жизненный цикл — общий (createIntervalRunner): single-flight, обёртка в jobTracker, unref-таймеры,
  // идемпотентные start/stop. Здесь остаётся только САМ ПРОХОД — то, чем бегунки и различаются
  // (аудит #554: шестьдесят строк были побайтово одинаковы в обоих файлах).
  const loop = createIntervalRunner({
    jobTracker,
    job: 'operational_pass',
    intervalMs,
    initialDelayMs,
    enabled,
    setTimeoutFn,
    clearTimeoutFn,
    pass: async () => {
        // Независимые полосы под concurrency 2: отчёты (собственный durable per-report/period
        // reservation-гейт и внутренний bounded dispatch), maintenance (durable per-UTC-day гейт)
        // и — если передана — доставка упоминаний (durable per-МСК-day гейт per-подписка).
        // boundedAllSettled НИКОГДА не реджектит, поэтому каждая полоса пытается выполниться,
        // даже если соседняя бросает.
        const lanes = [
          () => processReportSchedules(publicUrl),
          () => runDailyMaintenanceOnce(),
          ...(processMentionNotify ? [() => processMentionNotify()] : []),
          ...(processIgTokenRefresh ? [() => processIgTokenRefresh()] : []),
        ];
        const [rep, maint, ...rest] = await boundedAllSettled(lanes, (fn) => fn(), 2);
        // Хвост позиционен ровно так же, как собран выше: опциональные полосы не сдвигают друг друга.
        const mentions = processMentionNotify ? rest.shift() : null;
        const igToken = processIgTokenRefresh ? rest.shift() : null;
        // Только безопасные статусы — ни result, ни user-данные в лог не попадают.
        log('info', 'operational_pass_done', {
          rep: rep.status,
          maint: maint.status,
          ...(mentions ? { mentions: mentions.status } : {}),
          ...(igToken ? { igToken: igToken.status } : {}),
        });
    },
  });

  return loop;
}

module.exports = { createOperationalRunner };
