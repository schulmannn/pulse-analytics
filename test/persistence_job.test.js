'use strict';

// Focused unit tests for the IG collection PASS (durable per-account/day gates that replaced the
// monolithic ig_persistence gate). No PG, no network: a fake runJobOnce backed by a shared "jobs"
// store models completed / crashed / fresh accounts, and collectIgForAccount is a counter. Asserts:
// deterministic order, cap only counts NEWLY-STARTED accounts (completed skips do NOT consume cap),
// crash/resume across passes, and returned pass stats.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPersistenceJob } = require('../server/jobs/persistenceJob');

// Fake jobs store: a `done` set marks accounts already collected this day (runJobOnce → skipped).
// runJobOnce runs `fn` only for fresh accounts and records completion, exactly like the real
// per-(account,day) idempotency gate.
function makePass({ accounts, done = new Set(), collectImpl, cap, igConfigured = true } = {}) {
  const collected = [];
  const collect = collectImpl || (async (acc) => { collected.push(acc.channel_id); });
  const logs = [];
  const db = {
    enabled: true,
    listIgAccounts: async () => accounts,
    runJobOnce: async (_kind, key, fn) => {
      const id = key.split(':')[0];
      if (done.has(id)) return { skipped: true };   // completed today → resume-skip
      const result = await fn();
      done.add(id);
      return { skipped: false, result };
    },
    // maintenance methods — not exercised by runIgCollectionPass, present for factory completeness.
    saveRawSnapshot: async () => {},
    pruneRawSnapshots: async () => {},
    pruneIgMediaDaily: async () => {},
    rollupChannelMonthly: async () => {},
  };
  const job = createPersistenceJob({
    db,
    log: (level, event, meta) => logs.push({ level, event, meta }),
    igCrypto: { configured: () => igConfigured },
    collectIgForAccount: collect,
    capacityRollups: false,
    igAccountsPerPass: cap,
  });
  return { job, collected, done, logs };
}

const accs = (...ids) => ids.map((id) => ({ channel_id: id, ig_user_id: `ig-${id}` }));

test('runIgCollectionPass: детерминированный порядок (по channel_id) независимо от порядка БД', async () => {
  const { job, collected } = makePass({ accounts: accs(3, 1, 2), cap: 25 });
  const stats = await job.runIgCollectionPass();
  assert.deepEqual(collected, [1, 2, 3]);
  assert.deepEqual(stats, { started: 3, skipped: 0, failed: 0, capped: false });
});

test('runIgCollectionPass: завершённые аккаунты пропускаются и НЕ тратят cap', async () => {
  // channel 1 уже собран сегодня; cap=1. Если бы skip тратил cap, ничего бы не собралось.
  const { job, collected } = makePass({ accounts: accs(1, 2, 3), done: new Set(['1']), cap: 1 });
  const stats = await job.runIgCollectionPass();
  assert.deepEqual(collected, [2]);   // 1 пропущен (cap не тронут), 2 стартовал → cap исчерпан
  assert.equal(stats.started, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.capped, true);
});

test('runIgCollectionPass: креш/резюме — второй проход добирает остаток, завершённые не переигрываются', async () => {
  const done = new Set();
  const collected = [];
  const collect = async (acc) => { collected.push(acc.channel_id); };
  const accounts = accs(1, 2, 3, 4);

  // Проход 1, cap=2: собирает 1,2, упирается в cap (3,4 не тронуты) — модель прерванного деплоем батча.
  const first = makePass({ accounts, done, collectImpl: collect, cap: 2 });
  const s1 = await first.job.runIgCollectionPass();
  assert.deepEqual(collected, [1, 2]);
  assert.deepEqual(s1, { started: 2, skipped: 0, failed: 0, capped: true });

  // Проход 2, cap=2: 1,2 уже завершены → skip (cap не тратят), добирает 3,4.
  const second = makePass({ accounts, done, collectImpl: collect, cap: 2 });
  const s2 = await second.job.runIgCollectionPass();
  assert.deepEqual(collected, [1, 2, 3, 4]);   // никаких повторов 1,2
  assert.equal(s2.started, 2);
  assert.equal(s2.skipped, 2);
  assert.equal(s2.capped, false);
});

test('runIgCollectionPass: стартовавший, но упавший аккаунт тратит cap и считается failed', async () => {
  // collectIgForAccount обычно глотает свои ошибки; здесь моделируем сбой на уровне гейта (напр.
  // ошибка записи внутри fn), чтобы проверить учёт failed и трату cap реально стартовавшим.
  const collect = async (acc) => {
    if (acc.channel_id === 1) throw new Error('write failed');
  };
  const { job, logs } = makePass({ accounts: accs(1, 2), collectImpl: collect, cap: 25 });
  const stats = await job.runIgCollectionPass();
  assert.equal(stats.started, 2);   // оба реально стартовали (1 упал, 2 собрался)
  assert.equal(stats.failed, 1);
  assert.ok(logs.some((l) => l.event === 'ig_collect_account_failed' && l.meta.channelId === 1));
});

test('runIgCollectionPass: параметр cap вызова переопределяет инъектированный дефолт', async () => {
  const { job, collected } = makePass({ accounts: accs(1, 2, 3, 4, 5), cap: 25 });
  const stats = await job.runIgCollectionPass({ cap: 2 });
  assert.deepEqual(collected, [1, 2]);
  assert.equal(stats.capped, true);
});

test('runIgCollectionPass: новая IG identity того же канала не наследует succeeded job', async () => {
  const accounts = [{ channel_id: 1, ig_user_id: 'ig-new' }];
  const seenKeys = [];
  const db = {
    enabled: true,
    listIgAccounts: async () => accounts,
    runJobOnce: async (_kind, key, fn, opts) => {
      seenKeys.push(key);
      assert.equal(opts, undefined, 'per-account recovery uses the standard 15-minute job lease');
      await fn();
      return { skipped: false };
    },
  };
  let collected = 0;
  const job = createPersistenceJob({
    db,
    log: () => {},
    igCrypto: { configured: () => true },
    collectIgForAccount: async () => { collected++; },
    capacityRollups: false,
    igAccountsPerPass: 25,
  });
  await job.runIgCollectionPass();
  assert.equal(collected, 1);
  assert.match(seenKeys[0], /^1:ig-new:/, 'job key includes current external identity');
});

test('runIgCollectionPass: БД выключена или IG не сконфигурирован → пустая статистика без обхода', async () => {
  const off = makePass({ accounts: accs(1, 2), cap: 25, igConfigured: false });
  assert.deepEqual(await off.job.runIgCollectionPass(), { started: 0, skipped: 0, failed: 0, capped: false });
  assert.deepEqual(off.collected, []);

  const job = createPersistenceJob({
    db: { enabled: false, listIgAccounts: async () => accs(1) },
    log: () => {},
    igCrypto: { configured: () => true },
    collectIgForAccount: async () => { throw new Error('should not run'); },
    capacityRollups: false,
    igAccountsPerPass: 25,
  });
  assert.deepEqual(await job.runIgCollectionPass(), { started: 0, skipped: 0, failed: 0, capped: false });
});

test('processPersistence: пишет сырой TG-снимок и прогоняет IG-проход + maintenance', async () => {
  const calls = { snapshot: [], pruned: 0, collected: [], jobsPruneArgs: null, tokensPruneArgs: null };
  const logs = [];
  const done = new Set();
  const db = {
    enabled: true,
    saveRawSnapshot: async (channelId, net, kind) => { calls.snapshot.push([channelId, net, kind]); },
    listIgAccounts: async () => accs(1, 2),
    runJobOnce: async (_k, key, fn) => {
      const id = key.split(':')[0];
      if (done.has(id)) return { skipped: true };
      const r = await fn();
      done.add(id);
      return { skipped: false, result: r };
    },
    pruneRawSnapshots: async () => { calls.pruned++; },
    pruneIgMediaDaily: async () => { calls.pruned++; },
    pruneTerminalJobs: async (opts) => { calls.jobsPruneArgs = opts; return { deleted: 3, batches: 1, capped: false }; },
    pruneEmailTokens: async (opts) => { calls.tokensPruneArgs = opts; return { deleted: 2, batches: 1, capped: false }; },
  };
  const job = createPersistenceJob({
    db,
    log: (level, event, meta) => logs.push({ level, event, meta }),
    igCrypto: { configured: () => true },
    collectIgForAccount: async (acc) => { calls.collected.push(acc.channel_id); },
    capacityRollups: false,
    igAccountsPerPass: 25,
    jobsRetentionDays: 30,
    emailTokensRetentionDays: 30,
  });
  await job.processPersistence(50, { available: true });
  assert.deepEqual(calls.snapshot, [[50, 'tg', 'graphs']]);
  assert.deepEqual(calls.collected.sort(), [1, 2]);
  assert.equal(calls.pruned, 2);   // raw_snapshots + ig_media_daily pruned once each
  // Операционный ретеншн получил сконфигурированные горизонты и залогировал структурные счётчики.
  assert.deepEqual(calls.jobsPruneArgs, { maxAgeDays: 30 });
  assert.deepEqual(calls.tokensPruneArgs, { maxAgeDays: 30 });
  assert.ok(logs.some((l) => l.event === 'jobs_pruned' && l.meta.deleted === 3));
  assert.ok(logs.some((l) => l.event === 'email_tokens_pruned' && l.meta.deleted === 2));
});

// ── Продуктовый ретеншн (ingest_receipts / audit_events) — независимые флаги, dark deployment ──────
// Собирает job с полным набором prune-методов на db (все спаны), чтобы проверить, что флаги
// решают, ЗВАТЬ ли новый прунинг, и что сбой одного не роняет остальную maintenance.
function makeMaintenanceJob({ flags = {}, throwOn = null } = {}) {
  const calls = { ingest: null, audit: null };
  const logs = [];
  const db = {
    enabled: true,
    pruneRawSnapshots: async () => {},
    pruneIgMediaDaily: async () => {},
    pruneTerminalJobs: async () => ({ deleted: 0, batches: 0, capped: false }),
    pruneEmailTokens: async () => ({ deleted: 0, batches: 0, capped: false }),
    pruneIngestReceipts: async (opts) => {
      calls.ingest = opts;
      if (throwOn === 'ingest') throw new Error('ingest prune boom');
      return { deleted: 7, batches: 1, capped: false };
    },
    pruneAuditEvents: async (opts) => {
      calls.audit = opts;
      if (throwOn === 'audit') throw new Error('audit prune boom');
      return { deleted: 5, batches: 1, capped: false };
    },
  };
  const job = createPersistenceJob({
    db,
    log: (level, event, meta) => logs.push({ level, event, meta }),
    igCrypto: { configured: () => true },
    collectIgForAccount: async () => {},
    capacityRollups: false,
    igAccountsPerPass: 25,
    ...flags,
  });
  return { job, calls, logs };
}

test('runDailyMaintenance: флаги OFF (dark deployment) → новый прунинг НЕ вызывается', async () => {
  const { job, calls, logs } = makeMaintenanceJob();   // дефолтные флаги OFF
  await job.runDailyMaintenance();
  assert.equal(calls.ingest, null, 'ingest_receipts prune не вызван при выключенном флаге');
  assert.equal(calls.audit, null, 'audit_events prune не вызван при выключенном флаге');
  assert.ok(!logs.some((l) => l.event === 'ingest_receipts_pruned'));
  assert.ok(!logs.some((l) => l.event === 'audit_events_pruned'));
});

test('runDailyMaintenance: каждый флаг включает СВОЙ прунинг независимо, с настроенным горизонтом', async () => {
  const onlyIngest = makeMaintenanceJob({ flags: { ingestReceiptsRetentionEnabled: true, ingestReceiptsRetentionDays: 90 } });
  await onlyIngest.job.runDailyMaintenance();
  assert.deepEqual(onlyIngest.calls.ingest, { maxAgeDays: 90 });
  assert.equal(onlyIngest.calls.audit, null, 'audit-флаг остался OFF — audit не тронут');
  assert.ok(onlyIngest.logs.some((l) => l.event === 'ingest_receipts_pruned' && l.meta.deleted === 7));

  const onlyAudit = makeMaintenanceJob({ flags: { auditEventsRetentionEnabled: true, auditEventsRetentionDays: 365 } });
  await onlyAudit.job.runDailyMaintenance();
  assert.deepEqual(onlyAudit.calls.audit, { maxAgeDays: 365 });
  assert.equal(onlyAudit.calls.ingest, null, 'ingest-флаг остался OFF — ingest не тронут');
  assert.ok(onlyAudit.logs.some((l) => l.event === 'audit_events_pruned' && l.meta.deleted === 5));
});

test('runDailyMaintenance: сбой одного прунинга изолирован и не мешает другому', async () => {
  const { job, calls, logs } = makeMaintenanceJob({
    flags: {
      ingestReceiptsRetentionEnabled: true, ingestReceiptsRetentionDays: 90,
      auditEventsRetentionEnabled: true, auditEventsRetentionDays: 365,
    },
    throwOn: 'ingest',
  });
  await job.runDailyMaintenance();   // не должно бросать наружу
  assert.deepEqual(calls.ingest, { maxAgeDays: 90 }, 'ingest prune был вызван (и упал)');
  assert.deepEqual(calls.audit, { maxAgeDays: 365 }, 'audit prune всё равно выполнен после сбоя ingest');
  assert.ok(logs.some((l) => l.level === 'error' && l.event === 'ingest_receipts_prune_failed'));
  assert.ok(logs.some((l) => l.event === 'audit_events_pruned' && l.meta.deleted === 5));
});

// ── App-level usage-gate тормозит проход ДО claim'а (pacedStop) ────────────────────────────────────
// Gate инъектируется в createPersistenceJob; runJobOnce фиксирует claim'нутые ключи, чтобы доказать,
// что остановленные аккаунты вообще не берутся в работу.
function makeGatedPass({ accounts, gate, collectImpl, cap = 25 }) {
  const claimed = [];
  const collected = [];
  const done = new Set();
  const collect = collectImpl || (async (acc) => { collected.push(acc.channel_id); });
  const db = {
    enabled: true,
    listIgAccounts: async () => accounts,
    runJobOnce: async (_kind, key, fn) => {
      const id = key.split(':')[0];
      claimed.push(id);
      if (done.has(id)) return { skipped: true };
      const result = await fn();
      done.add(id);
      return { skipped: false, result };
    },
  };
  const job = createPersistenceJob({
    db,
    log: () => {},
    igCrypto: { configured: () => true },
    collectIgForAccount: collect,
    capacityRollups: false,
    igAccountsPerPass: cap,
    usageGate: gate,
  });
  return { job, claimed, collected };
}

test('gate: открытый app-gate останавливает проход ДО первого claim (pacedStop)', async () => {
  const gate = { open: true, shouldStopPass() { return this.open; } };
  const { job, claimed, collected } = makeGatedPass({ accounts: accs(1, 2, 3), gate });
  const stats = await job.runIgCollectionPass();
  assert.deepEqual(claimed, [], 'ни один аккаунт не claim\'нут при открытом gate');
  assert.deepEqual(collected, []);
  assert.equal(stats.started, 0);
  assert.equal(stats.capped, true);
  assert.equal(stats.pacedStop, true);
});

test('gate: pacedStop ставится ТОЛЬКО на остановленный результат — при закрытом gate его нет', async () => {
  const gate = { open: false, shouldStopPass() { return this.open; } };
  const { job } = makeGatedPass({ accounts: accs(1, 2), gate });
  const stats = await job.runIgCollectionPass();
  assert.equal(stats.pacedStop, undefined, 'нормальный проход не несёт pacedStop');
  assert.deepEqual(stats, { started: 2, skipped: 0, failed: 0, capped: false });
});

test('gate: in-account app-throttle роняет аккаунт и следующий проход-виток не claim\'ит остальные', async () => {
  const gate = { open: false, shouldStopPass() { return this.open; } };
  const collect = async (acc) => {
    if (acc.channel_id === 1) { gate.open = true; const e = new Error('app throttled'); e.status = 429; throw e; }
  };
  const { job, claimed } = makeGatedPass({ accounts: accs(1, 2, 3), gate, collectImpl: collect });
  const stats = await job.runIgCollectionPass();
  assert.deepEqual(claimed, ['1'], 'аккаунты 2 и 3 не claim\'нуты — gate открылся после падения 1');
  assert.equal(stats.started, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.pacedStop, true);
});

test('gate: account-scoped 429 роняет свой аккаунт, но при закрытом gate проход продолжается', async () => {
  const gate = { open: false, shouldStopPass() { return this.open; } };
  const collected = [];
  const collect = async (acc) => {
    if (acc.channel_id === 1) { const e = new Error('user rate limit'); e.status = 429; throw e; }   // user/page → gate НЕ открыт
    collected.push(acc.channel_id);
  };
  const { job, claimed } = makeGatedPass({ accounts: accs(1, 2, 3), gate, collectImpl: collect });
  const stats = await job.runIgCollectionPass();
  assert.deepEqual(claimed, ['1', '2', '3'], 'gate закрыт → все аккаунты обработаны');
  assert.deepEqual(collected, [2, 3], 'unrelated-аккаунты собраны после падения одного');
  assert.equal(stats.started, 3);
  assert.equal(stats.failed, 1);
  assert.equal(stats.pacedStop, undefined);
});

test('runDailyMaintenance: DB выключена → maintenance no-op, прунинг не вызывается даже при флагах ON', async () => {
  const calls = { ingest: 0, audit: 0 };
  const job = createPersistenceJob({
    db: {
      enabled: false,
      pruneIngestReceipts: async () => { calls.ingest++; },
      pruneAuditEvents: async () => { calls.audit++; },
    },
    log: () => {},
    igCrypto: { configured: () => true },
    collectIgForAccount: async () => {},
    capacityRollups: false,
    ingestReceiptsRetentionEnabled: true,
    auditEventsRetentionEnabled: true,
  });
  await job.runDailyMaintenance();
  assert.equal(calls.ingest, 0);
  assert.equal(calls.audit, 0);
});
