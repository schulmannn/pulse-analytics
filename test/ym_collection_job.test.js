'use strict';

// Focused unit tests для дневного сбора Яндекс.Метрики (jobs/ymCollectionJob). Без сети:
// ymFetch — программируемый фейк по path; db — фейк с записью upsert'ов/маркеров и passthrough
// runJobOnce. Проверяем: СТАБИЛЬНЫЙ порядок 10 метрик, разбор отчёта «по дням» в плотные строки
// (счётчики — нули, доли — NULL; null-семантика и округление качества), одноразовый
// историко-качественный бэкфилл по маркеру (существующий архив без маркера тоже добирается),
// маркер ТОЛЬКО на успешном НЕПУСТОМ бэкфилле (пустой upstream/сбой маркер не сжигают), окно с
// перекрытием ПОСЛЕ маркера, decrypt-fail = warn+skip БЕЗ claim'а day-gate, изоляцию сбоя одного
// счётчика, day-gate skip и инертность без ключа/БД.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createYmCollectionJob,
  YM_BACKFILL_ANCHOR_DAY,
  YM_DAILY_METRICS_ORDER,
} = require('../server/jobs/ymCollectionJob');

// Учётки БЕЗ маркера качества (quality_backfilled_at=null) → одноразовый полный бэкфилл.
const ACC1 = {
  channel_id: 7, counter_id: 'cnt-1', counter_name: 'notem.ru',
  counter_created_day: '2024-03-01', access_token_enc: 'enc1', quality_backfilled_at: null,
};
const ACC2 = {
  channel_id: 9, counter_id: 'cnt-2', counter_name: 'shop.ru',
  counter_created_day: null, access_token_enc: 'enc2', quality_backfilled_at: null,
};
// Учётка С маркером → дневное окно с перекрытием (история качества уже докачана).
const ACC1_MARKED = { ...ACC1, quality_backfilled_at: '2026-01-01T00:00:00' };

// Плотная строка дня без трафика: счётчики — честный 0, доли/средние — NULL.
const zeroRow = (day) => ({
  day, visits: 0, users: 0, pageviews: 0,
  bounce_rate: null, avg_visit_duration_seconds: null, page_depth: null,
  new_users: 0, percent_new_visitors: null, robot_visits: 0, robot_percentage: null,
});
// День с трафиком из «трёхметричного» отчёта: качество отсутствует (m[3..9] нет) → NULL,
// включая отсутствующие счётчики новых/роботных визитов (не ложный измеренный 0).
const dataRow = (day, visits, users, pageviews) => ({
  ...zeroRow(day),
  visits,
  users,
  pageviews,
  new_users: null,
  robot_visits: null,
});

function makeDb({ accounts = [], skipKeys = [], hasDaily = () => true } = {}) {
  const upserts = [];
  const jobKeys = [];
  const marks = [];
  const skips = new Set(skipKeys);
  return {
    enabled: true,
    upserts,
    jobKeys,
    marks,
    listYmAccounts: async () => accounts,
    hasYmDaily: async (channelId) => hasDaily(channelId),
    upsertYmDaily: async (channelId, rows) => { upserts.push({ channelId, rows }); return rows.length; },
    markYmQualityBackfilled: async (channelId, counterId) => { marks.push({ channelId, counterId }); return true; },
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

// Отчёт «по дням»: строки с трафиком в форме Reporting API (dimensions=[{name:день}]).
// report — «трёхметричный» (visits/users/pageviews); reportQ — полные 10 метрик (для качества).
const report = (rows) => ({
  data: rows.map(([day, v, u, p]) => ({ dimensions: [{ name: day }], metrics: [v, u, p] })),
});
const reportQ = (rows) => ({
  data: rows.map(([day, ...m]) => ({ dimensions: [{ name: day }], metrics: m })),
});

test('порядок метрик — стабильный контракт (visits…robotPercentage), 10 метрик под лимитом API', () => {
  assert.deepEqual(YM_DAILY_METRICS_ORDER, [
    'ym:s:visits',
    'ym:s:users',
    'ym:s:pageviews',
    'ym:s:bounceRate',
    'ym:s:avgVisitDurationSeconds',
    'ym:s:pageDepth',
    'ym:s:newUsers',
    'ym:s:percentNewVisitors',
    'ym:s:robotVisits',
    'ym:s:robotPercentage',
  ]);
  assert.equal(YM_DAILY_METRICS_ORDER.length, 10);
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
    zeroRow('2026-07-14'),
    // 25.4 просмотра → Math.round-страховка от дробной точки upstream'а.
    dataRow('2026-07-15', 10, 7, 25),
    zeroRow('2026-07-16'),
  ]);
});

test('reportToRows (качество): доли null-safe + округление, счётчики целые, null-знаменатель → NULL', () => {
  const { job } = makeJob({ db: makeDb(), handlers: () => report([]) });
  const rows = job.reportToRows(
    // [day, visits, users, pageviews, bounce, avgDur, pageDepth, newUsers, pctNew, robotVisits, robotPct]
    reportQ([
      ['2026-07-15', 100, 60, 250, 34.234, 96.44, 2.777, 40, 61.25, 12, 8.756],
      // Нулевые визиты/посетители: доли/средние честно недоступны (NULL), счётчики — 0.
      ['2026-07-16', 0, 0, 0, 55, 80, 3, 0, 42, 0, 5],
    ]),
    { fillFrom: '2026-07-15', fillTo: '2026-07-16' },
  );
  assert.deepEqual(rows[0], {
    day: '2026-07-15', visits: 100, users: 60, pageviews: 250,
    bounce_rate: 34.23,               // round2
    avg_visit_duration_seconds: 96.4, // round1
    page_depth: 2.78,                 // round2
    new_users: 40,
    percent_new_visitors: 61.25,      // round2
    robot_visits: 12,
    robot_percentage: 8.76,           // round2
  });
  // visits=0 → отказ/длительность/глубина/роботность NULL; users=0 → доля новых NULL; счётчики 0.
  assert.deepEqual(rows[1], {
    day: '2026-07-16', visits: 0, users: 0, pageviews: 0,
    bounce_rate: null, avg_visit_duration_seconds: null, page_depth: null,
    new_users: 0, percent_new_visitors: null, robot_visits: 0, robot_percentage: null,
  });
});

test('reportToRows (бэкфилл, fillFrom=null): нули только от ПЕРВОГО дня с данными; пустой отчёт → []', () => {
  const { job } = makeJob({ db: makeDb(), handlers: () => report([]) });
  const rows = job.reportToRows(
    report([['2026-07-14', 5, 4, 9], ['2026-07-16', 2, 2, 3]]),
    { fillFrom: null, fillTo: '2026-07-17' },
  );
  assert.deepEqual(rows.map((r) => r.day), ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']);
  assert.deepEqual(rows[1], zeroRow('2026-07-15'));
  // Пустой отчёт: архив не засеивается нулями (решение «бэкфилл или окно» не сгорает).
  assert.deepEqual(job.reportToRows(report([]), { fillFrom: null, fillTo: '2026-07-17' }), []);
});

test('окно после маркера: перекрытие, 10-метричный отчёт, day-gate ключ канал:счётчик:q2:день, маркер НЕ ставится', async () => {
  const db = makeDb({ accounts: [ACC1_MARKED] });
  const { job, fetches } = makeJob({ db, handlers: () => report([['2026-07-15', 10, 7, 25]]) });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.channels, 1);
  assert.equal(stats.errors, 0);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0].channelId, 7);
  // Окно 8 дневных точек (сегодня−7 … сегодня) дозаполнено нулями.
  assert.equal(db.upserts[0].rows.length, 8);
  const day = new Date().toISOString().slice(0, 10);
  assert.deepEqual(db.jobKeys, [`ym_collect|7:cnt-1:q2:${day}`]);
  assert.equal(db.marks.length, 0, 'при окне маркер не передёргивается');
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].token === 'TOKEN:enc1');
  assert.ok(fetches[0].path.includes('accuracy=full'));
  assert.ok(fetches[0].path.includes('ym:s:robotVisits,ym:s:robotPercentage'), 'запрошены обе метрики роботности');
  assert.ok(fetches[0].path.includes('dimensions=ym%3As%3Adate') || fetches[0].path.includes('dimensions=ym:s:date'));
});

test('без маркера: полный бэкфилл — date1 от даты создания счётчика (или якоря), маркер на успешном непустом upsert', async () => {
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
  // Маркер проставлен по обоим счётчикам (guarded channel+counter).
  assert.deepEqual(db.marks.sort((a, b) => a.channelId - b.channelId), [
    { channelId: 7, counterId: 'cnt-1' },
    { channelId: 9, counterId: 'cnt-2' },
  ]);
});

test('существующий непустой архив без маркера: одноразовый качественный бэкфилл (маркер решает, не пустота архива)', async () => {
  // hasDaily=true (архив слайсов 1–3 уже есть), но маркера нет → всё равно полный бэкфилл.
  const db = makeDb({ accounts: [ACC1], hasDaily: () => true });
  const { job, fetches } = makeJob({ db, handlers: () => report([['2024-03-01', 1, 1, 2]]) });
  await job.runYmCollectionPass();
  assert.ok(fetches[0].path.includes('date1=2024-03-01'), 'бэкфилл от даты создания, а не окно');
  assert.deepEqual(db.marks, [{ channelId: 7, counterId: 'cnt-1' }]);
});

test('пустой upstream в бэкфилле: НЕ upsert и НЕ маркер (retryable следующим проходом)', async () => {
  const db = makeDb({ accounts: [ACC1], hasDaily: () => false });
  const { job } = makeJob({ db, handlers: () => report([]) });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.channels, 1);
  assert.equal(stats.days, 0);
  assert.equal(db.upserts.length, 0, 'пустой отчёт архив не засеивает');
  assert.equal(db.marks.length, 0, 'маркер не сгорает — история качества добьётся позже');
});

test('недешифруемый токен: warn+skip БЕЗ claim\'а дня — починка ключа не ждёт завтра', async () => {
  const db = makeDb({ accounts: [{ ...ACC1, access_token_enc: 'broken' }, ACC2] });
  const { job, fetches } = makeJob({ db, handlers: () => report([['2026-07-15', 1, 1, 1]]) });
  const stats = await job.runYmCollectionPass();
  assert.equal(stats.errors, 1);
  assert.equal(stats.channels, 1);
  assert.equal(db.jobKeys.length, 1, 'день битого счётчика НЕ заклеймлен (retryable после починки ключа)');
  assert.ok(db.jobKeys[0].startsWith('ym_collect|9:cnt-2:q2:'));
  assert.ok(fetches.every((f) => f.token === 'TOKEN:enc2'), 'в Метрику сходил только здоровый счётчик');
});

test('сбой одного счётчика изолирован: у сбойного НИЧЕГО не записано и маркер не тронут, второй собран', async () => {
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
  // Маркер выставлен только у собранного счётчика; у сбойного (бросок до mark) — нет.
  assert.deepEqual(db.marks, [{ channelId: 9, counterId: 'cnt-2' }]);
});

test('day-gate skip: сегодня уже собрано → ни fetch\'а, ни upsert\'а, skipped++', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const db = makeDb({ accounts: [ACC1], skipKeys: [`7:cnt-1:q2:${day}`] });
  const { job, fetches } = makeJob({ db, handlers: () => report([]) });
  const stats = await job.runYmCollectionPass();
  assert.deepEqual(stats, { channels: 0, days: 0, errors: 0, skipped: 1 });
  assert.equal(fetches.length, 0);
  assert.equal(db.upserts.length, 0);
  assert.equal(db.marks.length, 0);
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
