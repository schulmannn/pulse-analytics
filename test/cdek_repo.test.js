'use strict';

// Тесты cdekRepo на фейковом пуле (паттерн ms_returns_repo.test.js): проверяется ФОРМА запросов —
// то, от чего зависит идемпотентность импорта. Здесь ловятся регрессы, которые в интеграционном
// тесте выглядели бы как «просто другие числа»: COALESCE вместо замены заказа, потерянное
// удаление исчезнувших позиций, идентичность источника по коду склада вместо канала.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCdekRepo } = require('../server/repos/cdekRepo');

function repoWith({ rowsFor = () => ({ rows: [], rowCount: 0 }) } = {}) {
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
  const result = await repo.finishCdekImport(9, { stats: { rows_total: 1, rows_rejected: 0, orders_total: 1, period_from: null, period_to: null } });
  assert.deepEqual(result, { duplicate: true });
  assert.ok(find(queries, /DELETE FROM cdek_imports/), 'своя незавершённая строка снимается');
});

test('переигровка снимает защиту «только pending», обычный финиш — нет', async () => {
  const { repo, queries } = repoWith();
  const stats = { rows_total: 1, rows_rejected: 0, orders_total: 1, period_from: null, period_to: null };
  await repo.finishCdekImport(9, { stats });
  await repo.finishCdekImport(9, { stats }, { replay: true });
  const [first, second] = queries.filter((q) => /UPDATE cdek_imports SET status = 'done'/.test(q.sql));
  assert.match(first.sql, /status = 'pending' OR \$12/);
  assert.equal(first.params[11], false);
  assert.equal(second.params[11], true);
});

test('упавший импорт не хранит файл — переигрывать нечего, а место он занимает', async () => {
  const { repo, queries } = repoWith();
  await repo.failCdekImport(9, 'Это не .xlsx');
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
