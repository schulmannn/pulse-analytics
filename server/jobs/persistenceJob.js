// ═══════════════════════════════════════════════════════════════
//  Atlavue — оркестратор дневного персистенса (job)
// ═══════════════════════════════════════════════════════════════
// Бывший processPersistence из index.js (PR E), тело literal. Вызывается fire-and-
// forget ПОСЛЕ ответа крона; без Express/env/таймеров — всё из deps.

'use strict';

function createPersistenceJob({ db, log, igCrypto, collectIgForAccount, capacityRollups }) {
  // Оркестратор персистенса (вызывается fire-and-forget ПОСЛЕ ответа крона):
  //   (a) сырой снимок TG /graphs для центрального канала (catch-all для серий, которые
  //       не ложатся в channel_daily: views_by_source, languages, top_hours и т.п.);
  //   (b) IG-сбор по КАЖДОМУ аккаунту из ig_accounts (не только центральный — IG цепляется
  //       к любому каналу), ПОСЛЕДОВАТЕЛЬНО, чтобы не устраивать thundering herd;
  //   (c) прунинг raw_snapshots. Ничего не бросает наружу.
  async function processPersistence(centralChannelId, graphs) {
    if (!db.enabled) return;
    const day = new Date().toISOString().slice(0, 10);
    // (a) сырой TG /graphs — payload уже в руках (лишнего mtproto-вызова нет).
    if (centralChannelId && graphs && graphs.available) {
      try { await db.saveRawSnapshot(centralChannelId, 'tg', 'graphs', day, graphs); }
      catch (e) { log('error', 'tg_graphs_snapshot_failed', { channelId: centralChannelId, error: e.message }); }
    }
    // (b) IG по каждому подключённому аккаунту. Без IG_TOKEN_KEY токенов нет — пропускаем.
    //     Гейтим ДНЕВНОЙ джобой (runJobOnce per день, lease 1ч): 504ca50 ввёл same-day-ретрай
    //     degraded-дня, а IG-фан-аут НЕ идемпотентен по квоте (upsert'ы идемпотентны, но каждый
    //     прогон заново жжёт Graph-квоту). Под гейтом ТОЛЬКО IG — (a) сырой TG-снимок идёт каждый
    //     раз, чтобы recovered-ретрай не потерял /graphs (узкая часть a2cbcc4-гейта).
    if (igCrypto.configured()) {
      await db.runJobOnce('ig_persistence', `central:${day}`, async () => {
        let accounts = [];
        try { accounts = await db.listIgAccounts(); }
        catch (e) { log('error', 'ig_list_accounts_failed', { error: e.message }); }
        for (const acc of accounts) {
          try { await collectIgForAccount(acc, day); }   // sequential: по-доброму к квоте
          catch (e) { log('error', 'ig_collect_account_failed', { channelId: acc && acc.channel_id, error: e.message }); }
        }
      }, { leaseSeconds: 60 * 60 }).catch(e => log('warn', 'ig_persistence_gate_failed', { error: e.message }));
    }
    // (c) ретеншн — не даём append-only таблицам расти безгранично.
    try { await db.pruneRawSnapshots(); }
    catch (e) { log('error', 'raw_snapshots_prune_failed', { error: e.message }); }
    try { await db.pruneIgMediaDaily(); }
    catch (e) { log('error', 'ig_media_daily_prune_failed', { error: e.message }); }
    // (d) capacity: nightly monthly rollup of channel_daily (long-range read scaling). INERT by
    // default — only runs when CAPACITY_ROLLUPS=1, and the jobs row makes exactly one web instance
    // recompute it per day (idempotent, cheap: bounded to recent months). Nothing reads channel_monthly
    // yet, so this is groundwork; enable it before wiring the long-range history reader.
    if (capacityRollups) {
      const rollupKey = `channel_monthly:${day}`;
      try { await db.runJobOnce('rollup_channel_monthly', rollupKey, () => db.rollupChannelMonthly(3)); }
      catch (e) { log('error', 'channel_monthly_rollup_failed', { error: e.message }); }
    }
  }

  return { processPersistence };
}

module.exports = { createPersistenceJob };
