// ═══════════════════════════════════════════════════════════════
//  Atlavue — оркестратор дневного персистенса (job)
// ═══════════════════════════════════════════════════════════════
// Бывший processPersistence из index.js (PR E), тело literal. Вызывается fire-and-
// forget ПОСЛЕ ответа крона; без Express/env/таймеров — всё из deps.

'use strict';

function createPersistenceJob({ db, log, igCrypto, collectIgForAccount, capacityRollups, igAccountsPerPass = 25 }) {
  // Один проход IG-сбора: durable per (account, day) гейты вместо прежней монолитной дневной
  // джобы ig_persistence. Прежний гейт держал ВСЕ аккаунты под одним lease — деплой/креш посреди
  // фан-аута оставлял весь остаток непокрытым до следующего внешнего крона. Теперь каждый аккаунт
  // — своя runJobOnce-строка (per-account изоляция + kindness к Graph-квоте: same-day повтор
  // пропускается, upsert-семантика дня неизменна), а бегунок добирает остаток последующими проходами.
  //   • детерминированный порядок (стабильный по channel_id) → проходы согласованы;
  //   • cap = сколько НОВОСТАРТОВАННЫХ аккаунтов трогаем за проход; skipped-завершённые лимит НЕ
  //     тратят, поэтому следующий проход продолжает с остатка;
  //   • возвращает { started, skipped, failed, capped } — статистику прохода.
  async function runIgCollectionPass({ cap = igAccountsPerPass } = {}) {
    const stats = { started: 0, skipped: 0, failed: 0, capped: false };
    if (!db.enabled || !igCrypto.configured()) return stats;   // без IG_TOKEN_KEY токенов нет
    const day = new Date().toISOString().slice(0, 10);
    let accounts = [];
    try { accounts = await db.listIgAccounts(); }
    catch (e) { log('error', 'ig_list_accounts_failed', { error: e.message }); return stats; }
    // Детерминированный порядок: одинаковый на каждом проходе, чтобы cap резал стабильный хвост.
    accounts = [...accounts].sort((a, b) => Number(a && a.channel_id) - Number(b && b.channel_id));
    for (const acc of accounts) {
      if (stats.started >= cap) { stats.capped = true; break; }
      let started = false;
      try {
        // Include both the Atlavue channel and current IG identity: reconnecting a different
        // Instagram account to the same channel must not inherit today's succeeded job.
        const accountKey = `${acc && acc.channel_id}:${(acc && acc.ig_user_id) || 'unknown'}:${day}`;
        const out = await db.runJobOnce('ig_account_collect', accountKey, () => {
          started = true;
          return collectIgForAccount(acc, day);   // sequential: по-доброму к квоте
        });
        if (out.skipped) { stats.skipped++; continue; }   // завершён/под lease — cap не тратим
        stats.started++;
      } catch (e) {
        if (started) stats.started++;   // реально стартовавший (сжёг квоту) аккаунт тратит cap
        stats.failed++;
        log('error', 'ig_collect_account_failed', { channelId: acc && acc.channel_id, error: e.message });
      }
    }
    return stats;
  }

  // Ежедневная maintenance (ретеншн + capacity-rollup). Отделена от сбора, чтобы recovery-бегунок
  // не гонял дорогой прунинг/rollup каждый короткий интервал — её зовёт только дневной хвост.
  async function runDailyMaintenance() {
    if (!db.enabled) return;
    const day = new Date().toISOString().slice(0, 10);
    try { await db.pruneRawSnapshots(); }
    catch (e) { log('error', 'raw_snapshots_prune_failed', { error: e.message }); }
    try { await db.pruneIgMediaDaily(); }
    catch (e) { log('error', 'ig_media_daily_prune_failed', { error: e.message }); }
    // capacity: nightly monthly rollup of channel_daily (long-range read scaling). INERT by
    // default — only runs when CAPACITY_ROLLUPS=1, and the jobs row makes exactly one web instance
    // recompute it per day (idempotent, cheap: bounded to recent months). Nothing reads channel_monthly
    // yet, so this is groundwork; enable it before wiring the long-range history reader.
    if (capacityRollups) {
      const rollupKey = `channel_monthly:${day}`;
      try { await db.runJobOnce('rollup_channel_monthly', rollupKey, () => db.rollupChannelMonthly(3)); }
      catch (e) { log('error', 'channel_monthly_rollup_failed', { error: e.message }); }
    }
  }

  // Оркестратор дневного персистенса (вызывается fire-and-forget ПОСЛЕ ответа крона):
  //   (a) сырой снимок TG /graphs для центрального канала (catch-all для серий, которые
  //       не ложатся в channel_daily: views_by_source, languages, top_hours и т.п.);
  //   (b) IG-сбор по КАЖДОМУ аккаунту (per-account/day гейты, детерминированный порядок);
  //   (c) ежедневная maintenance (прунинг + capacity-rollup). Ничего не бросает наружу.
  async function processPersistence(centralChannelId, graphs) {
    if (!db.enabled) return;
    const day = new Date().toISOString().slice(0, 10);
    // (a) сырой TG /graphs — payload уже в руках (лишнего mtproto-вызова нет).
    if (centralChannelId && graphs && graphs.available) {
      try { await db.saveRawSnapshot(centralChannelId, 'tg', 'graphs', day, graphs); }
      catch (e) { log('error', 'tg_graphs_snapshot_failed', { channelId: centralChannelId, error: e.message }); }
    }
    // (b) IG по каждому подключённому аккаунту — тот же проход, что и у recovery-бегунка.
    await runIgCollectionPass().catch(e => log('warn', 'ig_persistence_pass_failed', { error: e.message }));
    // (c) ретеншн + rollup — не даём append-only таблицам расти безгранично.
    await runDailyMaintenance();
  }

  return { processPersistence, runIgCollectionPass, runDailyMaintenance };
}

module.exports = { createPersistenceJob };
