'use strict';

// Focused unit tests для дневного сбора Яндекс.Метрики (jobs/ymCollectionJob). Без сети:
// ymFetch — программируемый фейк по path; db — фейк с записью upsert'ов и passthrough
// runJobOnce. Проверяем: разбор отчёта «по дням» в плотные строки (нули дозаполняются),
// ветку бэкфилла всей истории на пустом архиве (якорь от даты создания счётчика, нули только
// от первого дня с данными, пустой отчёт архив не засеивает), окно с перекрытием на живом
// архиве, decrypt-fail = warn+skip БЕЗ claim'а day-gate, изоляцию сбоя одного счётчика,
// day-gate skip и инертность без ключа/БД.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createYmCollectionJob, YM_BACKFILL_ANCHOR_DAY } = require('../server/jobs/ymCollectionJob');

const ACC1 = {
  channel_id: 7, counter_id: 'cnt-1', counter_name: 'notem.ru',
  counter_created_day: '2024-03-01', access_token_enc: 'enc1',
};
const ACC2 = {
  channel_id: 9, counter_id: 'cnt-2', counter_name: 'shop.ru',
  counter_created_day: null, access_token_enc: 'enc2',
};

function makeDb({ accounts = [], skipKeys = [], hasDaily = () => true } = {}) {
  const upserts = [];
  const jobKeys = [];
  const skips = new Set(skipKeys);
  return {
    enabled: true,
    upserts,
    jobKeys,
    listYmAccounts: async () => accounts,
    hasYmDaily: async (channelId) => hasDaily(channelId),
    upsertYmDaily: async (channelId, rows) => { upserts.push({ channelId, rows }); return rows.length; },
    // Passthrough-гейт: фиксирует ключи; помеченные — «сегодня уже собрано».
    runJobOnce: async (kind, key, fn) => {
      jobKeys.push(`${kind}|${key}`);
      if (skips.has(key)) return { skipped: true, job: null };
      const result = await fn();
      return { skipped: false, result };
    },
  };
}

function makeJob({ db, handlers }) {
  const fetches = [];
  const ymFetch = async (token, path) => {
    fetches.push({ token, path });
    return handlers(token, path);
  };
  const job = createYmCollectionJob({
    db,
    ymFetch,
    ymCrypto: { configured: () => true, decrypt: (enc) => (enc === 'broken' ? (() => { throw new Error('bad blob'); })() : `TOKEN:${enc}`) },
    log: () => {},
  });
  return { job, fetches };
}

// Отчёт «по дням»: две точки с трафиком (форма Reporting API — dimensions=[{name:день}]).
const report = (rows) => ({
  data: rows.map(([day, v, u, p]) => ({ dimensions: [{ name: day }], metrics: [v, u, p] })),
});

test('окно сбора: сегодня−7 … сегодня (7-дневное перекрытие, дневные границы)', () => {
  const { job } = makeJob({ db: makeDb(), handlers: () => report([]) });
  const w = job.collectionWindow(new Date(2026, 6, 17, 15, 30));   // 17 июля 2026, местное
  assert.equal(w.date1, '2026-07-10');
  assert.equal(w.date2, '2026-07-17');
});

test('reportToRows (окно): дни с трафиком из отчёта, остальное окно — честные нули, мусорные дни отброшены', () => {
  const { job } = makeJob({ db: makeDb(), handlers: () => report([]) });
  const rows = job.reportToRows(
    {
      data: [
        { dimensions: [{ name: '2026-07-15' }], metrics: [10, 7, 25.4] },
        { dimensions: [{ name: 'мусор' }], metrics: [1, 1, 1] },
      ],
    },
    { fillFrom: '2026-07-14', fillTo: '2026-07-16' },
  );
  assert.deepEqual(rows, [
    { day: '2026-07-14', visits: 0, users: 0, pageviews: 0 },
    // 25.4 просмотра → Math.round-страховка от дробной точки upstream'а.
    { day: '2026-07-15', visits: 10, users: 7, pageviews: 25 },
    { day: '2026-07-16', visits: 0, users: 0, pageviews: 0 },
  ]);
});

test('reportToRows (бэкфилл, fillFrom=null): нули только от ПЕРВОГО дня с данными; пустой отчёт → []', () => {
  const { job } = makeJob({ db: makeDb(), handlers: () => report([]) });
  const rows = job.reportToRows(
    report([['2026-07-14', 5, 4, 9], ['2026-07-16', 2, 2, 3]]),
    { fillFrom: null, fillTo: '2026-07-17' },
  );
  assert.deepEqual(rows.map((r) => r.day), ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
  assert.deepEqual(rows[1], { day: '2026-07-15', visits: 0, users: 0, pageviews: 0 });
  // Пустой отчёт: архив не засеивается нулями (решение «бэкфилл или окно» не сгорает).
  assert.deepEqual(job.reportToRows(report([]), { fillFrom: null, fillTo: '2026-07-17' }), []);
});

test('живой архив: окно с перекрытием, day-gate ключ канал:счётчик:день, accuracy=full', async () => {
  const db = makeDb({ accounts: [ACC1] });
  const { job, fetches } = makeJob({ db, handlers: () => report([['2026-07-15', 10, 7, 25]]) });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.channels, 1);
  assert.equal(stats.errors, 0);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0].channelId, 7);
  // Окно 8 дневных точек (сегодня−7 … сегодня) дозаполнено нулями.
  assert.equal(db.upserts[0].rows.length, 8);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(db.jobKeys, [`ym_collect|7:cnt-1:${day}`]);
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].token === 'TOKEN:enc1');
  assert.ok(fetches[0].path.includes('accuracy=full'));
  assert.ok(fetches[0].path.includes('dimensions=ym%3As%3Adate') || fetches[0].path.includes('dimensions=ym:s:date'));
});

test('пустой архив: бэкфилл всей истории — date1 от даты создания счётчика (или якоря)', async () => {
  const db = makeDb({ accounts: [ACC1, ACC2], hasDaily: () => false });
  const { job, fetches } = makeJob({
    db,
    handlers: () => report([['2026-07-10', 3, 2, 5]]),
  });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.channels, 2);
  const p1 = fetches.find((f) => f.token === 'TOKEN:enc1').path;
  const p2 = fetches.find((f) => f.token === 'TOKEN:enc2').path;
  assert.ok(p1.includes('date1=2024-03-01'), 'дата создания счётчика — якорь бэкфилла');
  assert.ok(p2.includes(`date1=${YM_BACKFILL_ANCHOR_DAY}`), 'без даты создания — консервативный якорь');
  // Строки бэкфилла начинаются с первого дня С ДАННЫМИ, а не с якоря.
  for (const u of db.upserts) assert.equal(u.rows[0].day, '2026-07-10');
});

test('недешифруемый токен: warn+skip БЕЗ claim\'а дня — починка ключа не ждёт завтра', async () => {
  const db = makeDb({ accounts: [{ ...ACC1, access_token_enc: 'broken' }, ACC2] });
  const { job, fetches } = makeJob({ db, handlers: () => report([['2026-07-15', 1, 1, 1]]) });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.errors, 1);
  assert.equal(stats.channels, 1);
  assert.equal(db.jobKeys.length, 1, 'день битого счётчика НЕ заклеймлен (retryable после починки ключа)');
  assert.ok(db.jobKeys[0].startsWith('ym_collect|9:cnt-2:'));
  assert.ok(fetches.every((f) => f.token === 'TOKEN:enc2'), 'в Метрику сходил только здоровый счётчик');
});

test('сбой одного счётчика изолирован: у сбойного НИЧЕГО не записано, второй собран', async () => {
  const db = makeDb({ accounts: [ACC1, ACC2] });
  const { job } = makeJob({
    db,
    handlers: (token) => {
      if (token === 'TOKEN:enc1') {
        const e = new Error('Яндекс.Метрика: HTTP 500'); e.status = 500; throw e;
      }
      return report([['2026-07-15', 1, 1, 1]]);
    },
  });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.errors, 1);
  assert.equal(stats.channels, 1);
  assert.deepEqual(db.upserts.map((u) => u.channelId), [9]);
});

test('day-gate skip: сегодня уже собрано → ни fetch\'а, ни upsert\'а, skipped++', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const db = makeDb({ accounts: [ACC1], skipKeys: [`7:cnt-1:${day}`] });
  const { job, fetches } = makeJob({ db, handlers: () => report([]) });
  const stats = await job.runYmCollectionPass();
  assert.deepEqual(stats, { channels: 0, days: 0, errors: 0, skipped: 1 });
  assert.equal(fetches.length, 0);
  assert.equal(db.upserts.length, 0);
});

test('DB off / YM_TOKEN_KEY не задан: проход инертен', async () => {
  const dbOff = { ...makeDb({ accounts: [ACC1] }), enabled: false };
  const { job: jobOff, fetches: fetchesOff } = makeJob({ db: dbOff, handlers: () => report([]) });
  assert.deepEqual(await jobOff.runYmCollectionPass(), { channels: 0, days: 0, errors: 0, skipped: 0 });
  assert.equal(fetchesOff.length, 0);

  const db = makeDb({ accounts: [ACC1] });
  const fetches = [];
  const job = createYmCollectionJob({
    db,
    ymFetch: async (...a) => { fetches.push(a); return {}; },
    ymCrypto: { configured: () => false, decrypt: () => 'X' },
    log: () => {},
  });
  assert.deepEqual(await job.runYmCollectionPass(), { channels: 0, days: 0, errors: 0, skipped: 0 });
  assert.equal(fetches.length, 0);
});
