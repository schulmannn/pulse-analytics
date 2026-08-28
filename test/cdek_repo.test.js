'use strict';

// Тесты cdekRepo на фейковом пуле (паттерн ms_returns_repo.test.js): проверяется ФОРМА запросов —
// то, от чего зависит идемпотентность импорта. Здесь ловятся регрессы, которые в интеграционном
// тесте выглядели бы как «просто другие числа»: COALESCE вместо замены заказа, потерянное
// удаление исчезнувших позиций, идентичность источника по коду склада вместо канала.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCdekRepo } = require('../server/repos/cdekRepo');

function repoWith({ rowsFor = () => ({ rows: [], rowCount: 0 }), accessible = false } = {}) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return rowsFor(sql, params) || { rows: [], rowCount: 0 };
    },
  };
  const sources = [];
  const repo = createCdekRepo({
    pool,
    enabled: true,
    transaction: async (fn) => fn(pool),
    ensureExternalSource: async (network, externalId, meta) => {
      sources.push({ network, externalId, meta });
      return 900;
    },
    getAccessibleChannel: accessible ? async (id) => ({ id }) : undefined,
  });
  return { repo, queries, pool, sources };
}

const find = (queries, re) => queries.find((q) => re.test(q.sql));

const ORDER = {
  order_id: '33984926',
  created: '2025-09-05 08:01:51',
  status: 'complete',
  carrier: 'Cdek',
  channel: 'own',
  external_order_id: '1184538545',
  track_number: '10157204962',
  warehouse_code: '19821',
  comment: null,
  kind: 'sale',
  items: [
    { product_id: '33066119', unit_price_kopecks: 375000, qty: 1, qty_reserved: 1 },
    { product_id: '33066116', unit_price_kopecks: 285000, qty: 2, qty_reserved: null },
  ],
};

test('заказ пере-записывается целиком, а не доливается COALESCE', async () => {
  // В СДЭКе статус правится задним числом: перевыгрузка обязана донести правку, а не сохранить
  // первое увиденное значение.
  const { repo, queries } = repoWith();
  await repo.applyCdekImport({ channelId: 5, importId: 77, tz: 'Europe/Moscow', orders: [ORDER] });

  const upsert = find(queries, /INSERT INTO cdek_orders/);
  assert.ok(upsert);
  assert.match(upsert.sql, /ON CONFLICT \(channel_id, order_id\) DO UPDATE/);
  for (const field of ['status', 'carrier', 'channel', 'track_number', 'comment', 'kind']) {
    assert.match(upsert.sql, new RegExp(`${field} = EXCLUDED\\.${field}`), `${field} заменяется`);
  }
  assert.doesNotMatch(upsert.sql, /COALESCE\(cdek_orders/);
});

test('наивное время заказа переводится в зону ИСТОЧНИКА, а не рантайма', async () => {
  const { repo, queries } = repoWith();
  await repo.applyCdekImport({ channelId: 5, importId: 77, tz: 'Asia/Yekaterinburg', orders: [ORDER] });
  const upsert = find(queries, /INSERT INTO cdek_orders/);
  assert.match(upsert.sql, /\(o->>'created'\)::timestamp AT TIME ZONE \$3/);
  assert.equal(upsert.params[2], 'Asia/Yekaterinburg');
  const payload = JSON.parse(upsert.params[1]);
  assert.equal(payload[0].created, '2025-09-05 08:01:51');
  assert.equal(payload[0].items, undefined, 'позиции едут своим запросом, не внутри заказа');
});

test('позиции уезжают параллельными массивами, дубли количества и цены не путаются', async () => {
  const { repo, queries } = repoWith();
  await repo.applyCdekImport({ channelId: 5, importId: 77, orders: [ORDER] });
  const items = find(queries, /INSERT INTO cdek_order_items/);
  assert.deepEqual(items.params[1], ['33984926', '33984926']);
  assert.deepEqual(items.params[2], ['33066119', '33066116']);
  assert.deepEqual(items.params[3], [375000, 285000]);
  assert.deepEqual(items.params[4], [1, 2]);
  assert.deepEqual(items.params[5], [1, null], 'отсутствующий резерв едет NULL, а не нулём');
  assert.equal(items.params[6], 77);
});

test('позиция, исчезнувшая из новой версии заказа, удаляется', async () => {
  // Без этого удаления строка навсегда останется в базе и будет считаться в выручке заказа,
  // которого в ней уже нет: последующие импорты её не тронут — её просто нет в файле.
  const { repo, queries } = repoWith();
  await repo.applyCdekImport({ channelId: 5, importId: 77, orders: [ORDER] });
  const del = find(queries, /DELETE FROM cdek_order_items/);
  assert.ok(del, 'удаление устаревших позиций обязательно');
  assert.match(del.sql, /NOT EXISTS[\s\S]*unnest\(\$2::text\[\], \$3::text\[\]\)/);
  assert.deepEqual(del.params[1], ['33984926', '33984926']);
  assert.ok(queries.indexOf(del) > queries.indexOf(find(queries, /INSERT INTO cdek_orders/)),
    'сначала заказ (внешний ключ), потом чистка позиций');
});

test('вставки и обновления считаются по xmax, без предварительного SELECT', async () => {
  const { repo } = repoWith({
    rowsFor: (sql) => (/INSERT INTO cdek_order_items/.test(sql)
      ? { rows: [{ inserted: true }, { inserted: false }], rowCount: 2 }
      : { rows: [], rowCount: 4 }),
  });
  const counts = await repo.applyCdekImport({ channelId: 5, importId: 77, orders: [ORDER] });
  assert.deepEqual(counts, { inserted: 1, updated: 1, deleted: 4 });
});

test('большой файл режется на чанки — по своей транзакции на каждый', async () => {
  const orders = Array.from({ length: 1101 }, (_, i) => ({
    ...ORDER, order_id: `o${i}`, items: [{ product_id: 'p', unit_price_kopecks: 100, qty: 1, qty_reserved: 1 }],
  }));
  const { repo, queries } = repoWith();
  await repo.applyCdekImport({ channelId: 5, importId: 77, orders });
  const upserts = queries.filter((q) => /INSERT INTO cdek_orders/.test(q.sql));
  assert.equal(upserts.length, 3, '1101 заказ при чанке 500 — три прохода');
  assert.equal(JSON.parse(upserts[2].params[1]).length, 101);
});

test('идентичность источника — пер-канальная, а не по коду склада', async () => {
  // external_sources общая для всех воркспейсов: канонизация по коду склада схлопнула бы две
  // независимые компании с одинаковым кодом в один источник.
  const { repo, queries, sources } = repoWith();
  await repo.saveCdekSource(5, { warehouse_code: '19821', tz: 'Europe/Moscow', title: 'Склад' });
  assert.deepEqual(sources[0].network, 'cdek');
  assert.equal(sources[0].externalId, 'ch:5');
  const stamp = find(queries, /UPDATE channels SET source_id/);
  assert.match(stamp.sql, /source = 'cdek'/);
  assert.match(stamp.sql, /source_id IS NULL/, 'штамп только на неканонизированный канал');
});

test('код склада проставляется один раз и не переезжает молча', async () => {
  const { repo, queries } = repoWith();
  await repo.setCdekWarehouse(5, '19821');
  assert.match(queries[0].sql, /warehouse_code IS NULL/);
});

test('гонка на финише импорта: 23505 снимает свою pending-строку и честно отвечает «дубль»', async () => {
  const { repo, queries } = repoWith({
    rowsFor: (sql) => {
      if (/UPDATE cdek_imports SET status = 'done'/.test(sql)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      return { rows: [], rowCount: 1 };
    },
  });
  const result = await repo.finishCdekImport(5, 9, { stats: { rows_total: 1, rows_rejected: 0, orders_total: 1, period_from: null, period_to: null } });
  assert.deepEqual(result, { duplicate: true });
  assert.ok(find(queries, /DELETE FROM cdek_imports/), 'своя незавершённая строка снимается');
});

test('переигровка снимает защиту «только pending», обычный финиш — нет', async () => {
  const { repo, queries } = repoWith();
  const stats = { rows_total: 1, rows_rejected: 0, orders_total: 1, period_from: null, period_to: null };
  await repo.finishCdekImport(5, 9, { stats });
  await repo.finishCdekImport(5, 9, { stats }, { replay: true });
  const [first, second] = queries.filter((q) => /UPDATE cdek_imports SET status = 'done'/.test(q.sql));
  assert.match(first.sql, /channel_id = \$2 AND \(status = 'pending' OR \$13\)/);
  assert.equal(first.params[12], false);
  assert.equal(second.params[12], true);
});

test('упавший импорт не хранит файл — переигрывать нечего, а место он занимает', async () => {
  const { repo, queries } = repoWith();
  await repo.failCdekImport(5, 9, 'Это не .xlsx');
  assert.match(queries[0].sql, /file_bytes = NULL/);
  assert.match(queries[0].sql, /status = 'pending'/);
});

test('без базы репозиторий молчит, а не падает', async () => {
  const repo = createCdekRepo({
    pool: { query: async () => { throw new Error('не должно вызываться'); } },
    enabled: false,
    transaction: async () => { throw new Error('не должно вызываться'); },
    ensureExternalSource: async () => null,
  });
  assert.equal(await repo.getCdekSource(5), null);
  assert.equal(await repo.saveCdekSource(5, {}), false);
  assert.deepEqual(await repo.listCdekImports(5), []);
  assert.deepEqual(await repo.applyCdekImport({ channelId: 5, orders: [ORDER] }), { inserted: 0, updated: 0, deleted: 0 });
});

// ── Что считать выручкой: режимы + явный набор статусов ───────────────────────────────────────
// Набор едет ТЕМ ЖЕ параметром $7, что и прежние режимы (восьмой параметр в общем префиксе сдвинул
// бы нумерацию плейсхолдеров во всех читающих запросах сразу). Значит вся защита — здесь: белый
// список, порядок и дедуп. Порядок важен не для SQL, а для КЭША клиента: один и тот же выбор
// обязан давать одну строку, иначе `complete,delivery` и `delivery,complete` станут двумя ключами.
test('normalizeCdekInclude: режимы, набор статусов, мусор', () => {
  const { normalizeCdekInclude } = require('../server/repos/cdekRepo');

  for (const mode of ['revenue', 'completed', 'all']) {
    assert.equal(normalizeCdekInclude(mode), mode);
  }

  assert.equal(normalizeCdekInclude('status:complete'), 'status:complete');
  assert.equal(normalizeCdekInclude('status:delivery,complete'), 'status:complete,delivery', 'набор сортируется');
  assert.equal(normalizeCdekInclude('status:complete,complete'), 'status:complete', 'дубли схлопываются');
  // Набор берётся ИЗ КОДА, а не выписан литералом: статусы приходят с выгрузкой (в новой их стало
  // шесть), и тест, знающий их число наизусть, краснел бы на каждом пополнении вместо настоящей
  // регрессии — что и произошло, когда приехали assembled и confirmed.
  const { ORDER_STATUSES } = require('../server/repos/cdekRepo');
  assert.equal(
    normalizeCdekInclude(`status:${[...ORDER_STATUSES].reverse().join(',')}`),
    'all',
    'полный набор — это режим «все», а не длинный список',
  );

  // Мусор НЕ означает «ничего не считать»: ноль на месте выручки человек прочитал бы как
  // отсутствие продаж. Падаем на канон.
  for (const bad of ['status:bogus', 'status:', 'status:;DROP TABLE', '', undefined, null, 42, {}]) {
    assert.equal(normalizeCdekInclude(bad), 'revenue', `мусор ${JSON.stringify(bad)} → канон`);
  }
});

test('фильтр статусов доезжает до SQL седьмым параметром', async () => {
  const { repo, queries } = repoWith({ accessible: true });
  await repo.getCdekSummaryForActor(7, { uid: 1 }, {
    from: '2026-08-01',
    to: '2026-08-31',
    include: 'status:cancel,complete',
  });
  const withFilter = queries.filter((q) => q.params && q.params[6] != null);
  assert.ok(withFilter.length > 0, 'хотя бы один запрос окна должен уйти с include');
  for (const q of withFilter) {
    assert.equal(q.params[6], 'status:cancel,complete');
  }
});

/**
 * Плейсхолдеры и параметры обязаны сходиться ЧИСЛОМ — иначе Postgres падает на bind, а до него
 * ошибка ничем себя не выдаёт. Общий фрагмент `saleRows` берёт индексы АРГУМЕНТАМИ, и у трёх
 * читающих запросов хвосты параметров разные: сдвинешь один — молча уедет не тот слот, о чём
 * предупреждает комментарий в самом фрагменте. Тест закрывает ровно это, и без базы.
 */
test('читающие запросы: число плейсхолдеров совпадает с числом параметров', async () => {
  const { repo, queries } = repoWith({ accessible: true });
  const opts = {
    from: '2026-03-01', to: '2026-03-31', tz: 'Europe/Moscow', include: 'revenue',
    products: 'p1,p2', channels: ['own', 'ozon'], grain: 'day', dim: 'channel',
  };
  await repo.getCdekSummaryForActor(5, { uid: 1 }, opts);
  await repo.getCdekSeriesForActor(5, { uid: 1 }, opts);
  await repo.getCdekBreakdownForActor(5, { uid: 1 }, opts);
  await repo.getCdekSeriesBreakdownForActor(5, { uid: 1 }, opts);

  assert.equal(queries.length, 4, 'четыре чтения — четыре запроса');
  for (const { sql, params } of queries) {
    const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(highest, params.length,
      `запрос использует $${highest}, а параметров передано ${params.length}`);
  }
});

test('фильтр по каналу продаж доезжает до SQL последним параметром', async () => {
  const { repo, queries } = repoWith({ accessible: true });
  await repo.getCdekSummaryForActor(5, { uid: 1 }, {
    from: '2026-03-01', to: '2026-03-31', tz: 'Europe/Moscow', channels: ['ozon', 'own'],
  });
  const { sql, params } = queries[0];
  assert.match(sql, /COALESCE\(o\.channel, ''\) = ANY/, 'условие по каналу есть в запросе');
  assert.deepEqual(params[params.length - 1], ['ozon', 'own']);
});

test('без фильтра канал не сужается — параметр null, а не пустой массив', async () => {
  // Пустой массив дал бы `= ANY('{}')` — ноль строк, то есть «продаж нет» вместо «фильтра нет».
  const { repo, queries } = repoWith({ accessible: true });
  await repo.getCdekSummaryForActor(5, { uid: 1 }, { from: '2026-03-01', to: '2026-03-31' });
  assert.equal(queries[0].params[queries[0].params.length - 1], null);
});

// ── Лента заказов: фильтры НАБОРАМИ ────────────────────────────────────────────────────────────
// Лента жила своим языком: одиночный статус и одиночный канал, тогда как метрики того же склада
// давно фильтровались наборами. Здесь проверяется и форма запроса (массив, а не скаляр), и то,
// что «выбраны все» honestly значит «фильтра нет», и отказ на незнакомом ключе.

test('лента фильтруется НАБОРАМИ: массив в параметрах, ANY в условии', async () => {
  const { repo, queries } = repoWith({ accessible: true });
  await repo.getCdekOrdersForActor(5, { id: 1 }, { days: 30, status: 'cancel,return', channel: 'other' });
  const q = find(queries, /FROM cdek_orders/);
  assert.match(q.sql, /o\.status = ANY\(\$8\)/, 'статус сверяется с набором');
  assert.match(q.sql, /COALESCE\(o\.channel, ''\) = ANY\(\$9\)/, 'канал сверяется с набором');
  assert.deepEqual(q.params[7], ['cancel', 'return'], 'набор отсортирован и разобран');
  assert.deepEqual(q.params[8], ['other']);
});

test('выбраны ВСЕ значения — это «фильтра нет», а не длинный список', async () => {
  // Короче строка, устойчивее кэш — тот же приём, что у каналов метрик.
  const { repo, queries } = repoWith({ accessible: true });
  await repo.getCdekOrdersForActor(5, { id: 1 }, {
    days: 30,
    status: 'complete,delivery,assembled,confirmed,cancel,return',
  });
  const q = find(queries, /FROM cdek_orders/);
  assert.equal(q.params[7], null, 'полный набор статусов = фильтра нет');
});

test('незнакомый ключ — ОТКАЗ, а не пустая лента', async () => {
  // «Заказов не нашлось» неотличимо от «фильтр написан с опечаткой»: молчать здесь нельзя.
  const { repo, queries } = repoWith({ accessible: true });
  const out = await repo.getCdekOrdersForActor(5, { id: 1 }, { days: 30, status: 'complete,опечатка' });
  assert.equal(out.unknown, true);
  assert.equal(out.rows.length, 0);
  assert.equal(find(queries, /FROM cdek_orders/), undefined, 'до базы такой запрос не доходит');
});

test('плейсхолдеры ленты не разъезжаются с параметрами', async () => {
  // Сдвиг индекса $N до базы ничем себя не выдаёт — сверяем арность, как у чтений выше.
  const { repo, queries } = repoWith({ accessible: true });
  await repo.getCdekOrdersForActor(5, { id: 1 }, { days: 30, status: 'cancel', channel: 'own', q: 'A-1' });
  const q = find(queries, /FROM cdek_orders/);
  const maxPlaceholder = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(maxPlaceholder, q.params.length, 'максимальный $N равен длине params');
});
