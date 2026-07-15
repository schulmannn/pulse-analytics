'use strict';

// Unit tests (no PG) for the bounded operational-retention prunes:
//   jobsRepo.pruneTerminalJobs  — старые succeeded/failed jobs
//   usersRepo.pruneEmailTokens  — мёртвые (consumed/expired) email-токены
// Мок-пул возвращает заданную последовательность rowCount, чтобы детерминированно проверить
// цикл батчей, cap, накопление счётчиков, DB-off и клэмп аргументов. Точная семантика предиката
// (границы времени, выживание защищённых строк) проверяется на реальном Postgres в
// operational_retention.integration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobsRepo } = require('../server/repos/jobsRepo');
const { createUsersRepo } = require('../server/repos/usersRepo');

// Пул, отдающий rowCount по очереди (потом 0). Запоминает каждый (sql, params) вызов.
function makePool(rowCounts = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const rc = i < rowCounts.length ? rowCounts[i] : 0;
      i += 1;
      return { rowCount: rc };
    },
  };
}

const prunes = [
  {
    name: 'pruneTerminalJobs',
    make: (pool, enabled) => createJobsRepo({ pool, enabled }).pruneTerminalJobs,
    // предикат обязан резать только терминальные и никогда queued/running
    assertSql: (sql) => {
      assert.equal((sql.match(/status IN \('succeeded', 'failed'\)/g) || []).length, 1,
        'only terminal status enters the locked selector');
      assert.equal((sql.match(/updated_at < now\(\)/g) || []).length, 1,
        'only old rows enter the locked selector');
      assert.match(sql, /ORDER BY updated_at, id/);
      assert.match(sql, /FOR UPDATE SKIP LOCKED/, 'maintenance never waits behind a live claim');
      assert.doesNotMatch(sql, /status\s+(?:IN\s*\([^)]*)?(?:=\s*)?'(?:queued|running)'/,
        'queued/running are never delete candidates');
    },
  },
  {
    name: 'pruneEmailTokens',
    make: (pool, enabled) => createUsersRepo({ pool, enabled, transaction: async (fn) => fn() }).pruneEmailTokens,
    assertSql: (sql) => {
      assert.match(sql, /used_at IS NOT NULL OR expires_at <= now\(\)/);
      assert.match(sql, /created_at < now\(\)/);
      assert.match(sql, /ORDER BY created_at, id/);
      assert.match(sql, /FOR UPDATE SKIP LOCKED/, 'maintenance skips tokens used by an auth flow');
    },
  },
];

for (const p of prunes) {
  test(`${p.name}: сливает хвост батчами и суммирует счётчики`, async () => {
    const pool = makePool([500, 500, 120]);
    const prune = p.make(pool, true);
    const r = await prune({ batchSize: 500, maxBatches: 40 });
    assert.deepEqual(r, { deleted: 1120, batches: 3, capped: false });
    assert.equal(pool.calls.length, 3);
    p.assertSql(pool.calls[0].sql);
  });

  test(`${p.name}: cap ограничивает число батчей и помечает capped`, async () => {
    const pool = makePool([500, 500, 500, 500]);
    const prune = p.make(pool, true);
    const r = await prune({ batchSize: 500, maxBatches: 2 });
    assert.deepEqual(r, { deleted: 1000, batches: 2, capped: true });
    assert.equal(pool.calls.length, 2);   // не ушли за cap
  });

  test(`${p.name}: повторный прогон добирает остаток (идемпотентно/повторяемо)`, async () => {
    const prune1 = p.make(makePool([500, 500]), true);   // ровно cap → capped
    const first = await prune1({ batchSize: 500, maxBatches: 2 });
    assert.equal(first.capped, true);
    const pool2 = makePool([300]);   // следующая ночь: остаток меньше батча → чисто
    const second = await p.make(pool2, true)({ batchSize: 500, maxBatches: 2 });
    assert.deepEqual(second, { deleted: 300, batches: 1, capped: false });
  });

  test(`${p.name}: DB-off → нулевые счётчики без запросов`, async () => {
    const pool = makePool([500]);
    const r = await p.make(pool, false)();
    assert.deepEqual(r, { deleted: 0, batches: 0, capped: false });
    assert.equal(pool.calls.length, 0);
  });

  test(`${p.name}: аргументы клэмпятся к безопасным границам`, async () => {
    const pool = makePool([]);   // 0 удалённых → один батч и стоп
    await p.make(pool, true)({ maxAgeDays: 'nonsense', batchSize: 0, maxBatches: -5 });
    // maxAgeDays невалиден → дефолт 30; batchSize 0 → минимум 1; maxBatches -5 → минимум 1 (один вызов)
    assert.equal(pool.calls.length, 1);
    assert.equal(pool.calls[0].params[0], 30);
    assert.equal(pool.calls[0].params[1], 1);
  });

  test(`${p.name}: batchSize клэмпится сверху до 10000`, async () => {
    const pool = makePool([]);
    await p.make(pool, true)({ batchSize: 999999 });
    assert.equal(pool.calls[0].params[1], 10000);
  });
}
