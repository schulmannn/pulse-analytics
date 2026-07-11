const test = require('node:test');
const assert = require('node:assert/strict');
const { createJobsRepo } = require('../server/repos/jobsRepo');

// Мок-пул, воспроизводящий семантику таблицы jobs ровно настолько, насколько её использует
// репо: INSERT..ON CONFLICT-клейм (queued/failed/протухший lease переклеймливаются, running
// под lease и succeeded — нет), complete/fail, SELECT по ключу. Гарантия фикса «degraded
// ingest» держится на этих переходах: пустой день бросает из fn → строка failed → повторный
// тик ТОГО ЖЕ дня переклеймливает и повторяет тяжёлый проход (см. /api/ingest/daily).
function makePool() {
  const store = new Map();
  let idSeq = 1;
  return {
    _store: store,
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO jobs')) {
        const [kind, key] = params;
        const k = `${kind}|${key}`;
        const row = store.get(k);
        if (!row) {
          const fresh = { id: idSeq++, kind, idempotency_key: key, status: 'running', attempts: 1, result: null, error: null, lease_alive: true };
          store.set(k, fresh);
          return { rows: [fresh] };
        }
        const reclaimable = ['queued', 'failed'].includes(row.status)
          || (row.status === 'running' && !row.lease_alive);
        if (!reclaimable) return { rows: [] };
        row.status = 'running'; row.attempts += 1; row.lease_alive = true;
        return { rows: [row] };
      }
      if (sql.includes("status='succeeded'")) {
        const [id, result] = params;
        for (const r of store.values()) if (r.id === id) { r.status = 'succeeded'; r.result = result ? JSON.parse(result) : null; }
        return { rows: [] };
      }
      if (sql.includes("status='failed'")) {
        const [id, error] = params;
        for (const r of store.values()) if (r.id === id) { r.status = 'failed'; r.error = error; }
        return { rows: [] };
      }
      if (sql.includes('SELECT * FROM jobs')) {
        const [kind, key] = params;
        const r = store.get(`${kind}|${key}`);
        return { rows: r ? [r] : [] };
      }
      return { rows: [] };
    },
  };
}

test('деградировавший прогон (fn бросает) пишет failed и остаётся ретраябельным в тот же день', async () => {
  const pool = makePool();
  const repo = createJobsRepo({ pool, enabled: true });
  let runs = 0;

  // Тик 1: upstream лёг → fn бросает INGEST_DEGRADED → строка failed, ошибка проброшена.
  const degraded = new Error('channel_daily=0');
  degraded.code = 'INGEST_DEGRADED';
  await assert.rejects(
    repo.runJobOnce('daily_ingest', 'central:2026-07-11', async () => { runs++; throw degraded; }),
    (e) => e.code === 'INGEST_DEGRADED',
  );
  assert.equal(runs, 1);
  assert.equal((await repo.getJob('daily_ingest', 'central:2026-07-11')).status, 'failed');

  // Тик 2 (same-day ретрай): failed переклеймливается, fn запускается снова и успевает.
  const retry = await repo.runJobOnce('daily_ingest', 'central:2026-07-11', async () => { runs++; return { channel_daily: 400 }; });
  assert.equal(retry.skipped, false);
  assert.equal(retry.result.channel_daily, 400);
  assert.equal(runs, 2);
  assert.equal((await repo.getJob('daily_ingest', 'central:2026-07-11')).status, 'succeeded');

  // Тик 3 (дубль успешного дня): skipped, fn НЕ перезапускается, кэш непустой.
  const dup = await repo.runJobOnce('daily_ingest', 'central:2026-07-11', async () => { runs++; return {}; });
  assert.equal(dup.skipped, true);
  assert.equal(runs, 2);
  assert.equal(dup.job.status, 'succeeded');
  assert.equal(dup.job.result.channel_daily, 400);
});

test('дубль под живым lease скипается без перезапуска (ветка in_progress в ingest-роуте)', async () => {
  const pool = makePool();
  const repo = createJobsRepo({ pool, enabled: true });

  // Первый клейм держит lease (fn «ещё выполняется» — не завершаем job).
  const first = await pool.query(
    `INSERT INTO jobs (kind, idempotency_key, status, attempts, locked_until, payload)
     VALUES ($1, $2, 'running', 1, now() + make_interval(secs => $3), $4)
     ON CONFLICT (kind, idempotency_key) DO UPDATE SET status='running' WHERE jobs.status IN ('queued','failed') OR (jobs.status='running' AND jobs.locked_until < now()) RETURNING *`,
    ['daily_ingest', 'central:2026-07-12', 900, null]);
  assert.equal(first.rows.length, 1);

  let ran = false;
  const dup = await repo.runJobOnce('daily_ingest', 'central:2026-07-12', async () => { ran = true; });
  assert.equal(dup.skipped, true);
  assert.equal(ran, false);
  assert.equal(dup.job.status, 'running');   // роут отвечает in_progress, НЕ degraded

  // Протухший lease: строка снова переклеймливается (упавший раннер не блокирует день навсегда).
  pool._store.get('daily_ingest|central:2026-07-12').lease_alive = false;
  const reclaimed = await repo.runJobOnce('daily_ingest', 'central:2026-07-12', async () => ({ channel_daily: 7 }));
  assert.equal(reclaimed.skipped, false);
  assert.equal(reclaimed.result.channel_daily, 7);
});
