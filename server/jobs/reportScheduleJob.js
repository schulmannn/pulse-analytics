// ═══════════════════════════════════════════════════════════════
//  Atlavue — email-выгрузка отчётов (job)
// ═══════════════════════════════════════════════════════════════
/* Email-выгрузка отчётов (v1). Дёргается fire-and-forget из дневного ingest-крона
   (единственный ежедневный тик системы — отдельного планировщика нет): weekly уходит
   в понедельник UTC, monthly — 1-го числа UTC. Если крон в «свой» день не сработал,
   действует catch-up: weekly шлётся, когда last_sent_at старше 8 дней, monthly — 32
   дней (первая отправка якорится к понедельнику / 1-му). Окно по last_sent_at в
   listDueReports остаётся анти-дублем, если крон сработал дважды за день. Все ошибки
   логируются и никогда не влияют на ответ ingest-а.
   Тела перенесены из index.js literal (PR E); без Express/env/таймеров. */

'use strict';

// Серверный «Неделя канала» (фаза 3 нарратива): shared-движок narrative.gen.cjs + сборка входа
// из архива. Секция опциональна — без артефакта/данных письмо-ссылка уходит как раньше.
const { assembleWeekInput, reportHasWeekBlock, weekSectionHtml } = require('../lib/weekDigest');

function createReportScheduleJob({ db, log, sendEmailDetailed, emailShell, emailBtn, escHtml, emailConfigured, now }) {
  const clock = now || (() => new Date());
  const reportEmailHtml = (base, report, weekHtml) => emailShell(`Отчёт „${escHtml(report.name)}“`,
    `${weekHtml || ''}<p>Ваш регулярный отчёт Atlavue готов:</p>${emailBtn(`${base}/reports/${report.id}`, 'Открыть отчёт')}` +
    `<p style="color:#64748d;font-size:13px">Отчёт можно сохранить как PDF — кнопка «Печать» на странице отчёта.</p>`);

  async function processReportSchedules(base) {
    if (!db.enabled) return;
    // Без почтового провайдера рассылка невозможна: dev-заглушка sendEmail вернула бы true,
    // и last_sent_at проставился бы без единого отправленного письма.
    if (!emailConfigured()) {
      console.log('[reports] schedule skipped: email not configured');
      return;
    }
    const now = clock();
    const isMonday = now.getUTCDay() === 1;    // понедельник UTC
    const isFirst  = now.getUTCDate() === 1;   // 1-е число UTC
    let candidates = [];
    try { candidates = await db.listDueReports({ weekly: true, monthly: true }); }
    catch (e) { log('error', 'report_schedule_query_failed', { error: e.message }); return; }
    // Пер-строчный гейт с catch-up вместо строгого «только в понедельник / 1-го»: если крон
    // в тот день не сработал, письмо уходит, как только last_sent_at старше 8 дней (weekly)
    // или 32 дней (monthly). Первая отправка (last_sent_at IS NULL) якорится к понедельнику /
    // 1-му. Анти-дубль в течение дня остаётся SQL-окном в listDueReports.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const olderThan = (sentAt, limitDays) =>
      sentAt != null && now.getTime() - new Date(sentAt).getTime() > limitDays * DAY_MS;
    const due = candidates.filter((r) =>
      r.schedule === 'weekly'
        ? isMonday || olderThan(r.last_sent_at, 8)
        : isFirst  || olderThan(r.last_sent_at, 32));
    // ISO-week key (YYYY-Www) so the weekly job key is stable across the whole week.
    const isoWeekKey = (d) => {
      const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of this ISO week
      const week = Math.ceil((((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000) + 1) / 7);
      return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    };
    for (const r of due) {
      // Idempotency key per (report, period): a double cron tick, the catch-up branch firing next
      // to the anchored one, or a SECOND SERVER INSTANCE can all re-discover the same candidate —
      // the jobs row makes exactly one of them send (roadmap P0 «Background job idempotency»).
      const periodKey = r.schedule === 'weekly' ? isoWeekKey(now) : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      try {
        const outcome = await db.runJobOnce('report_email', `report:${r.id}:${periodKey}`, async () => {
          // GDPR-гонка: юзер мог стереть аккаунт между снапшотом listDueReports (несёт email в
          // строке) и отправкой — перепроверяем существование, письмо на стёртый адрес не уходит.
          if (!(await db.getUserById(r.uid))) return { sent: false, erased: true };
          // «Неделя канала» в теле письма — только weekly-отчётам с week/digest-блоком. Любая
          // ошибка сборки секции НЕ роняет отправку: письмо уходит без неё (рассказ — бонус).
          let weekHtml = null;
          try {
            if (r.schedule === 'weekly' && reportHasWeekBlock(r.config)) {
              const chans = await db.listChannels({ uid: r.uid });
              // Канал нарратива = канал САМОГО ОТЧЁТА (config.channelId — то, что рендерит
              // страница /reports/:id, куда ведёт кнопка письма). Раньше всегда брался chans[0]
              // (старейший канал юзера): письмо ссылалось на отчёт канала B, а цифры внутри были
              // канала A. Членство в chans = ownership-check; чужой/удалённый id → прежний фолбэк.
              const cfgId = Number(r.config && r.config.channelId) || 0;
              const chId = (cfgId && chans.some((c) => c.id === cfgId))
                ? cfgId
                : (chans[0] && chans[0].id);
              if (chId) {
                // Internal-ридеры (cron): доступ уже установлен членством chans выше (listChannels).
                const [daily, posts, igDaily] = await Promise.all([
                  db.getChannelHistoryInternal(chId, 35),
                  db.listPostsWindow(chId, 28),
                  db.listIgDailyInternal(chId, 14),
                ]);
                weekHtml = weekSectionHtml(assembleWeekInput({ daily, posts, igDaily }));
              }
            }
          } catch (e) {
            log('warn', 'report_week_section_failed', { report_id: r.id, error: e.message });
          }
          // Build the body FIRST, then take the durable reservation immediately before the provider.
          // The jobs row already makes exactly one discovery send within its 24h-ish life, but Resend's
          // Idempotency-Key only dedupes for 24h and the NEXT daily tick can fall outside that window —
          // this own-side reservation is the durable at-most-once gate beyond provider retention. A
          // crash AFTER reserving and before/while sending is intentionally fail-closed for the period:
          // the re-claim rebuilds, reserve() returns false, and the period is skipped (one missed report
          // is preferred over a duplicate).
          const html = reportEmailHtml(base, r, weekHtml);
          const reserved = await db.reserveReportDelivery(r.id, periodKey);
          if (!reserved) {
            log('info', 'report_email_period_reserved', { report_id: r.id, period: periodKey });
            return { sent: false, alreadyReserved: true };
          }
          // Stable provider key from internal ids ONLY (never user text), ≤256 chars (validated in the
          // email service too). Identical across the immediate retries so Resend collapses duplicates.
          const providerKey = `report-email/${r.id}/${periodKey}`;
          const result = await sendEmailDetailed(r.email, `Atlavue — отчёт „${r.name}“`, html, { idempotencyKey: providerKey });
          switch (result.outcome) {
            case 'sent': {
              // Confirmed delivered: keep the reservation and stamp last_sent_at. A markReportSent
              // failure AFTER confirmed delivery must NOT make the job retry/resend — the reservation
              // is durable, so log safely and return terminal success anyway.
              try {
                await db.markReportSent(r.id);
              } catch {
                log('error', 'report_email_mark_failed', { report_id: r.id, period: periodKey });
              }
              return { sent: true, period: periodKey };
            }
            case 'ambiguous': {
              // May or may not have sent: keep the reservation, DO NOT mark, and return terminal
              // success. Intentionally favors one missed report over a duplicate.
              log('warn', 'report_email_ambiguous', { report_id: r.id, period: periodKey, reason: result.reason });
              return { sent: false, ambiguous: true };
            }
            case 'retryable': {
              // HTTP 429 = provider explicitly rejected BEFORE sending (known-not-sent). Clear the
              // EXACT reservation so the next daily tick can retry cleanly; only if the clear succeeds
              // do we throw (jobs row → failed, re-claimable). If the clear fails, fail closed: return
              // terminal so we never resend against a reservation we could not release.
              let cleared = false;
              try {
                cleared = await db.clearReportDelivery(r.id, periodKey);
              } catch {
                log('error', 'report_email_reserve_clear_failed', { report_id: r.id, period: periodKey });
                return { sent: false, retryableLocked: true };
              }
              if (cleared) throw new Error('report email rate-limited (known not sent)');
              log('error', 'report_email_reserve_clear_failed', { report_id: r.id, period: periodKey });
              return { sent: false, retryableLocked: true };
            }
            case 'rejected':
            default: {
              // Permanent rejection (invalid key/payload/auth): keep the reservation and go terminal
              // for this period so we do not hammer the provider every daily tick. Actionable + safe.
              log('error', 'report_email_rejected', { report_id: r.id, period: periodKey, status: result.status, name: result.name });
              return { sent: false, rejected: true };
            }
          }
        });
        if (outcome.skipped) {
          log('info', 'report_email_deduped', { report_id: r.id, period: periodKey });
        }
      } catch (e) {
        log('error', 'report_email_failed', { report_id: r.id, error: e.message });
      }
    }
  }

  return { processReportSchedules };
}

module.exports = { createReportScheduleJob };
