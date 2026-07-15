'use strict';

// Integration tests (real Postgres) for the bounded operational retention added to the daily
// maintenance job: jobsRepo.pruneTerminalJobs + usersRepo.pruneEmailTokens. They prove the actual
// DELETE predicates against a live schema — boundary timestamps, batch cap + repeat-run drain, and
// that PROTECTED rows (queued/running jobs; valid unused tokens) survive. Run against the local
// stand exactly like the other *.integration.test.js:
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:54329/pulse npm test
//
// Without TEST_DATABASE_URL every test SKIPS (CI/`npm run check` stay DB-less). Rows carry a run
// nonce and are cleaned up after the suite so re-runs and parallel suites don't collide.

const test = require('node:test');
const assert = require('node:assert');
const { createTestDatabase } = require('./testDatabase');
const { createJobsRepo } = require('../server/repos/jobsRepo');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `ret${Date.now().toString(36)}${process.pid}`;

test.before(() => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM jobs WHERE idempotency_key LIKE $1`, [`${nonce}%`]);
  // email_tokens уходят каскадом вместе с юзером.
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${nonce}%`]);
  await pool.end();
});

// Вставляет job-строку с явными status/updated_at (created_at = updated_at для простоты).
async function mkJob(tag, status, updatedDaysAgo, { lockedDaysAgo = null } = {}) {
  const key = `${nonce}:${tag}`;
  await pool.query(
    `INSERT INTO jobs (kind, idempotency_key, status, attempts, locked_until, created_at, updated_at)
     VALUES ('ret_test', $1, $2, 1, $3, now() - make_interval(days => $4), now() - make_interval(days => $4))`,
    [key, status, lockedDaysAgo == null ? null : new Date(Date.now() - lockedDaysAgo * 86400000), updatedDaysAgo]);
  return key;
}
async function jobExists(key) {
  const { rows } = await pool.query(`SELECT 1 FROM jobs WHERE idempotency_key = $1`, [key]);
  return rows.length > 0;
}

async function mkUser(tag) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, pass_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`,
    [`${tag}.${nonce}@it.local`]);
  return u.id;
}
// Вставляет email-token с явными created_at / used_at / expires_at.
async function mkToken(uid, tag, { createdDaysAgo, usedDaysAgo = null, expiresInDays }) {
  const { rows: [t] } = await pool.query(
    `INSERT INTO email_tokens (uid, kind, token_hash, expires_at, used_at, created_at)
     VALUES ($1, 'verify', $2,
             now() + make_interval(days => $3),
             $4, now() - make_interval(days => $5))
     RETURNING id`,
    [uid, `${nonce}:${tag}`,
     expiresInDays,
     usedDaysAgo == null ? null : new Date(Date.now() - usedDaysAgo * 86400000),
     createdDaysAgo]);
  return t.id;
}
async function tokenExists(id) {
  const { rows } = await pool.query(`SELECT 1 FROM email_tokens WHERE id = $1`, [id]);
  return rows.length > 0;
}

test('pruneTerminalJobs: границы времени, защита queued/running, повтор добирает cap-остаток', { skip }, async () => {
  // Горизонт = 10 дней. updated_at 11 дней → под удаление; 9 дней → выживает.
  const oldSucceeded = await mkJob('js-old-ok', 'succeeded', 11);
  const oldFailed = await mkJob('js-old-fail', 'failed', 11);
  const freshSucceeded = await mkJob('js-fresh-ok', 'succeeded', 9);   // моложе горизонта
  const oldQueued = await mkJob('js-old-queued', 'queued', 30);        // НИКОГДА не трогаем
  const oldRunningDeadLease = await mkJob('js-old-run', 'running', 30, { lockedDaysAgo: 20 }); // протухший lease — не наш

  const r = await db.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 500, maxBatches: 40 });
  assert.ok(r.deleted >= 2, 'удалены оба старых терминальных');

  assert.strictEqual(await jobExists(oldSucceeded), false, 'старый succeeded удалён');
  assert.strictEqual(await jobExists(oldFailed), false, 'старый failed удалён');
  assert.strictEqual(await jobExists(freshSucceeded), true, 'свежий терминальный выжил (граница)');
  assert.strictEqual(await jobExists(oldQueued), true, 'queued НИКОГДА не удаляется');
  assert.strictEqual(await jobExists(oldRunningDeadLease), true, 'running (даже с мёртвым lease) не удаляется');

  // Cap + повтор: 5 старых терминальных, batchSize=2, maxBatches=2 → 4 удалены, capped; остаток — следующей ночью.
  const keys = [];
  for (let i = 0; i < 5; i++) keys.push(await mkJob(`js-cap-${i}`, 'succeeded', 20));
  const capped = await db.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(capped.capped, true, 'упёрлись в cap');
  assert.strictEqual(capped.deleted, 4, 'ровно batchSize*maxBatches удалено за прогон');
  const survivorsAfterCap = [];
  for (const k of keys) if (await jobExists(k)) survivorsAfterCap.push(k);
  assert.strictEqual(survivorsAfterCap.length, 1, 'один остаток пережил capped-прогон');

  const drain = await db.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(drain.capped, false, 'повторный прогон дочистил без cap');
  assert.strictEqual(await jobExists(survivorsAfterCap[0]), false, 'остаток добран следующим прогоном');

  // Идемпотентность: третий прогон на пустом хвосте — ноль удалений.
  const noop = await db.pruneTerminalJobs({ maxAgeDays: 10 });
  assert.strictEqual(noop.deleted, 0);
});

test('pruneTerminalJobs: занятый failed не блокирует cleanup и переживает concurrent reclaim', { skip }, async () => {
  const key = await mkJob('js-reclaim-race', 'failed', 20);
  const locker = await pool.connect();
  const pg = require('pg');
  const prunePool = new pg.Pool({
    connectionString: TEST_DB,
    max: 1,
    ssl: false,
  });
  const raceRepo = createJobsRepo({ pool: prunePool, enabled: true });
  let inTransaction = false;
  try {
    await locker.query('BEGIN');
    inTransaction = true;
    const { rows: [row] } = await locker.query(
      'SELECT id FROM jobs WHERE idempotency_key=$1 FOR UPDATE', [key]);

    // A live claim already owns the row lock. Maintenance must SKIP it rather than wait behind the
    // user-facing/recovery path; the next daily pass can reconsider it.
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('retention waited on row lock')), 1000);
    });
    const result = await Promise.race([
      raceRepo.pruneTerminalJobs({ maxAgeDays: 10, batchSize: 1, maxBatches: 1 }),
      timeout,
    ]).finally(() => clearTimeout(timeoutId));
    assert.strictEqual(result.deleted, 0, 'locked failed row was skipped');

    // The normal claim transition makes the protected row live before releasing the lock.
    await locker.query(
      `UPDATE jobs SET status='running', updated_at=now(), locked_until=now()+interval '15 minutes'
        WHERE id=$1`, [row.id]);
    await locker.query('COMMIT');
    inTransaction = false;

    const { rows: [after] } = await pool.query(
      'SELECT status FROM jobs WHERE idempotency_key=$1', [key]);
    assert.strictEqual(after.status, 'running');
  } finally {
    if (inTransaction) await locker.query('ROLLBACK').catch(() => {});
    locker.release();
    await prunePool.end();
  }
});

test('pruneEmailTokens: consumed/expired режутся, валидный неиспользованный выживает, границы', { skip }, async () => {
  const uid = await mkUser('retok');
  // Горизонт created_at = 10 дней.
  const consumedOld = await mkToken(uid, 'consumed-old', { createdDaysAgo: 11, usedDaysAgo: 5, expiresInDays: 30 });
  const expiredOld = await mkToken(uid, 'expired-old', { createdDaysAgo: 11, usedDaysAgo: null, expiresInDays: -1 }); // истёк, неиспользован
  const validUnusedOld = await mkToken(uid, 'valid-old', { createdDaysAgo: 11, usedDaysAgo: null, expiresInDays: 30 }); // ЖИВОЙ — защищён
  const consumedFresh = await mkToken(uid, 'consumed-fresh', { createdDaysAgo: 9, usedDaysAgo: 1, expiresInDays: 30 }); // моложе горизонта
  const validUnusedFresh = await mkToken(uid, 'valid-fresh', { createdDaysAgo: 1, usedDaysAgo: null, expiresInDays: 30 });

  const r = await db.pruneEmailTokens({ maxAgeDays: 10, batchSize: 500, maxBatches: 40 });
  assert.ok(r.deleted >= 2, 'удалены старые мёртвые токены');

  assert.strictEqual(await tokenExists(consumedOld), false, 'старый использованный удалён');
  assert.strictEqual(await tokenExists(expiredOld), false, 'старый истёкший (неиспользованный) удалён');
  assert.strictEqual(await tokenExists(validUnusedOld), true, 'валидный неиспользованный НЕ удаляется, даже если старый');
  assert.strictEqual(await tokenExists(consumedFresh), true, 'свежий использованный выжил (граница created_at)');
  assert.strictEqual(await tokenExists(validUnusedFresh), true, 'свежий валидный выжил');

  // Cap + повтор на пяти старых мёртвых токенах.
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await mkToken(uid, `tk-cap-${i}`, { createdDaysAgo: 20, usedDaysAgo: 10, expiresInDays: 30 }));
  const capped = await db.pruneEmailTokens({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(capped.capped, true);
  assert.strictEqual(capped.deleted, 4);
  let survivors = 0;
  for (const id of ids) if (await tokenExists(id)) survivors++;
  assert.strictEqual(survivors, 1, 'один остаток пережил capped-прогон');

  const drain = await db.pruneEmailTokens({ maxAgeDays: 10, batchSize: 2, maxBatches: 2 });
  assert.strictEqual(drain.capped, false);
  let left = 0;
  for (const id of ids) if (await tokenExists(id)) left++;
  assert.strictEqual(left, 0, 'остаток добран повторным прогоном');
});
