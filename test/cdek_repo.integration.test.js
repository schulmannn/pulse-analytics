'use strict';

// Integration-тесты импорта СДЭК на РЕАЛЬНОМ Postgres. Здесь проверяется то, что фейковый пул
// проверить не может: идемпотентность перезагрузки, замена заказа целиком, удаление исчезнувших
// позиций, вычисляемая сумма строки и перевод наивного времени в зону источника.
// Без TEST_DATABASE_URL всё SKIP. Гоняется в CI (postgres) и локально:
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/pulse PGSSL=disable npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('./testDatabase');

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'TEST_DATABASE_URL not set (integration suite runs on the local stand)';

let db = null;
let pool = null;
const nonce = `cdek${Date.now().toString(36)}${process.pid}`;
let seq = 0;
const mail = () => `cdek.${seq++}.${nonce}@it.local`;

test.before(async () => {
  if (!TEST_DB) return;
  db = createTestDatabase(TEST_DB);
  await db.migrate();
  const pg = require('pg');
  pool = new pg.Pool({ connectionString: TEST_DB, max: 2, ssl: false });
});

test.after(async () => {
  if (pool) await pool.end();
  if (db) await db.close();
});

/** Свежий источник СДЭК со своим владельцем — тесты не должны видеть архив друг друга. */
async function makeSource(tz = 'Europe/Moscow') {
  const user = await db.createUser({ email: mail(), pass_hash: 'x', role: 'user', status: 'active' });
  const channel = await db.createCdekChannel({ owner_uid: user.id, name: 'Склад' });
  await db.saveCdekSource(channel.id, { tz, title: 'Склад' });
  const importId = await db.startCdekImport({
    channel_id: channel.id, uploaded_by: user.id, filename: 'выгрузка.xlsx',
    file_sha256: `${nonce}${seq++}`, file_bytes: Buffer.from('файл'),
  });
  return { user, channelId: channel.id, importId };
}

const order = (over = {}) => ({
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
  items: [{ product_id: 'p1', unit_price_kopecks: 375000, qty: 1, qty_reserved: 1 }],
  ...over,
});

const itemsOf = async (channelId) => (await pool.query(
  `SELECT product_id, unit_price_kopecks, qty, amount_kopecks FROM cdek_order_items
    WHERE channel_id = $1 ORDER BY product_id`, [channelId])).rows;

test('импорт кладёт заказ, позиции и товары; сумма строки вычисляется базой', { skip }, async () => {
  const { channelId, importId } = await makeSource();
  const counts = await db.applyCdekImport({
    channelId,
    importId,
    tz: 'Europe/Moscow',
    orders: [order({ items: [
      { product_id: 'p1', unit_price_kopecks: 375000, qty: 5, qty_reserved: 5 },
      { product_id: 'p2', unit_price_kopecks: 285000, qty: 1, qty_reserved: null },
    ] })],
    products: [
      { product_id: 'p1', title: 'Мини-сумка', article: 'BG-GR7T', sku: 'BG-GR7T', barcodes: ['2044834576773'], external_id: null },
      { product_id: 'p2', title: 'Чехол', article: 'CS-O14', sku: 'CS-O14', barcodes: [], external_id: 'ext-2' },
    ],
  });
  assert.deepEqual(counts, { inserted: 2, updated: 0, deleted: 0 });

  const items = await itemsOf(channelId);
  assert.equal(items.length, 2);
  // Цена — за штуку; сумму строки считает генерируемая колонка, а не вызывающий код.
  assert.equal(Number(items[0].amount_kopecks), 375000 * 5);
  assert.equal(Number(items[1].amount_kopecks), 285000);

  const products = (await pool.query(
    'SELECT product_id, title, barcodes FROM cdek_products WHERE channel_id = $1 ORDER BY product_id',
    [channelId])).rows;
  assert.equal(products.length, 2);
  assert.deepEqual(products[0].barcodes, ['2044834576773']);
});

test('наивное время файла ложится в зону источника, а не в зону сервера', { skip }, async () => {
  const { channelId, importId } = await makeSource('Asia/Yekaterinburg');
  await db.applyCdekImport({ channelId, importId, tz: 'Asia/Yekaterinburg', orders: [order()] });
  const { rows } = await pool.query(
    `SELECT to_char(created_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS utc
       FROM cdek_orders WHERE channel_id = $1`, [channelId]);
  // Екатеринбург летом — UTC+5, поэтому 08:01:51 местного времени это 03:01:51 UTC.
  assert.equal(rows[0].utc, '2025-09-05 03:01:51');
});

test('повторная загрузка того же содержимого ничего не дублирует', { skip }, async () => {
  const { channelId, importId } = await makeSource();
  await db.applyCdekImport({ channelId, importId, orders: [order()] });
  const again = await db.applyCdekImport({ channelId, importId, orders: [order()] });

  assert.deepEqual(again, { inserted: 0, updated: 1, deleted: 0 }, 'вторая загрузка только обновляет');
  const { rows } = await pool.query(
    'SELECT count(*)::int AS orders FROM cdek_orders WHERE channel_id = $1', [channelId]);
  assert.equal(rows[0].orders, 1);
  assert.equal((await itemsOf(channelId)).length, 1);
});

test('правка задним числом доносится целиком: статус меняется, а не сохраняется первый', { skip }, async () => {
  // В СДЭКе заказ живёт: delivery → complete. Если бы upsert доливал COALESCE'ом, архив навсегда
  // застрял бы на первом увиденном статусе.
  const { channelId, importId } = await makeSource();
  await db.applyCdekImport({ channelId, importId, orders: [order({ status: 'delivery', track_number: null })] });
  await db.applyCdekImport({ channelId, importId, orders: [order({ status: 'complete', track_number: '10157204962' })] });

  const { rows } = await pool.query(
    'SELECT status, track_number FROM cdek_orders WHERE channel_id = $1', [channelId]);
  assert.equal(rows[0].status, 'complete');
  assert.equal(rows[0].track_number, '10157204962');
});

test('позиция, исчезнувшая из новой версии заказа, удаляется вместе со своей суммой', { skip }, async () => {
  const { channelId, importId } = await makeSource();
  await db.applyCdekImport({ channelId, importId, orders: [order({ items: [
    { product_id: 'p1', unit_price_kopecks: 100000, qty: 1, qty_reserved: 1 },
    { product_id: 'p2', unit_price_kopecks: 200000, qty: 1, qty_reserved: 1 },
  ] })] });

  const counts = await db.applyCdekImport({ channelId, importId, orders: [order({ items: [
    { product_id: 'p1', unit_price_kopecks: 100000, qty: 1, qty_reserved: 1 },
    { product_id: 'p3', unit_price_kopecks: 300000, qty: 1, qty_reserved: 1 },
  ] })] });

  assert.equal(counts.deleted, 1, 'p2 исчез из заказа');
  assert.equal(counts.inserted, 1, 'p3 добавился');
  const items = await itemsOf(channelId);
  assert.deepEqual(items.map((i) => i.product_id), ['p1', 'p3']);
  const total = items.reduce((s, i) => s + Number(i.amount_kopecks), 0);
  assert.equal(total, 400000, 'сумма заказа не тащит за собой удалённую позицию');
});

test('удаление позиций не задевает соседние заказы того же файла', { skip }, async () => {
  const { channelId, importId } = await makeSource();
  await db.applyCdekImport({ channelId, importId, orders: [
    order({ order_id: 'A', items: [{ product_id: 'p1', unit_price_kopecks: 100, qty: 1, qty_reserved: 1 }] }),
    order({ order_id: 'B', items: [{ product_id: 'p1', unit_price_kopecks: 200, qty: 1, qty_reserved: 1 }] }),
  ] });
  // Второй проход несёт только заказ A — заказ B в этом файле не упомянут и трогаться не должен.
  await db.applyCdekImport({ channelId, importId, orders: [
    order({ order_id: 'A', items: [{ product_id: 'p2', unit_price_kopecks: 100, qty: 1, qty_reserved: 1 }] }),
  ] });

  const rows = (await pool.query(
    `SELECT order_id, product_id FROM cdek_order_items WHERE channel_id = $1 ORDER BY order_id, product_id`,
    [channelId])).rows;
  assert.deepEqual(rows, [{ order_id: 'A', product_id: 'p2' }, { order_id: 'B', product_id: 'p1' }]);
});

test('удаление источника уносит его архив и не оставляет сирот', { skip }, async () => {
  const { channelId, importId, user } = await makeSource();
  await db.applyCdekImport({ channelId, importId, orders: [order()], products: [{ product_id: 'p1', title: 'T', barcodes: [] }] });
  await db.deleteChannel(channelId, user.id);

  for (const table of ['cdek_orders', 'cdek_order_items', 'cdek_products', 'cdek_imports', 'cdek_sources']) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE channel_id = $1`, [channelId]);
    assert.equal(rows[0].n, 0, `${table} должен уйти вместе с каналом`);
  }
});

test('успешный импорт того же файла второй раз не заводится: уникальность по sha256', { skip }, async () => {
  const { channelId, user } = await makeSource();
  const sha = `${nonce}-same`;
  const stats = { rows_total: 1, rows_rejected: 0, orders_total: 1, period_from: '2025-09-05', period_to: '2025-09-05' };
  const first = await db.startCdekImport({ channel_id: channelId, uploaded_by: user.id, filename: 'a.xlsx', file_sha256: sha });
  assert.ok(await db.finishCdekImport(channelId, first, { stats }));

  const found = await db.findCdekImportByHash(channelId, sha);
  assert.equal(found.id, first);
  assert.equal(found.rows_total, 1);

  // Гонка: вторая загрузка того же файла успела стартовать до финиша первой.
  const second = await db.startCdekImport({ channel_id: channelId, uploaded_by: user.id, filename: 'a.xlsx', file_sha256: sha });
  assert.deepEqual(await db.finishCdekImport(channelId, second, { stats }), { duplicate: true });
  assert.equal(await db.getCdekImport(channelId, second), null, 'вторая pending-строка снята, а не осталась висеть');
  assert.equal((await db.listCdekImports(channelId)).filter((i) => i.status === 'done').length, 1);
});

test('упавший импорт не мешает повторной загрузке того же файла', { skip }, async () => {
  const { channelId, user } = await makeSource();
  const sha = `${nonce}-retry`;
  const failed = await db.startCdekImport({ channel_id: channelId, uploaded_by: user.id, filename: 'a.xlsx', file_sha256: sha, file_bytes: Buffer.from('x') });
  await db.failCdekImport(channelId, failed, 'Это не .xlsx');
  assert.equal(await db.findCdekImportByHash(channelId, sha), null, 'упавший не считается загруженным');
  assert.equal(await db.getCdekImportFile(channelId, failed), null, 'файл упавшего импорта не хранится');

  const retry = await db.startCdekImport({ channel_id: channelId, uploaded_by: user.id, filename: 'a.xlsx', file_sha256: sha });
  const done = await db.finishCdekImport(channelId, retry, {
    stats: { rows_total: 1, rows_rejected: 0, orders_total: 1, period_from: null, period_to: null },
  });
  assert.equal(done.status, 'done');
});

test('источник получает каноническую идентичность вида ch:<id>, а не код склада', { skip }, async () => {
  const { channelId } = await makeSource();
  await db.setCdekWarehouse(channelId, '19821');
  const source = await db.getCdekSource(channelId);
  assert.equal(source.warehouse_code, '19821');

  const { rows } = await pool.query(
    `SELECT s.network, s.external_id, c.source_id IS NOT NULL AS stamped
       FROM external_sources s JOIN channels c ON c.source_id = s.id WHERE c.id = $1`, [channelId]);
  assert.equal(rows[0].network, 'cdek');
  assert.equal(rows[0].external_id, `ch:${channelId}`);
  assert.equal(rows[0].stamped, true);
});

test('код склада не переезжает на другой молча', { skip }, async () => {
  const { channelId } = await makeSource();
  await db.setCdekWarehouse(channelId, '19821');
  await db.setCdekWarehouse(channelId, '77777');
  assert.equal((await db.getCdekSource(channelId)).warehouse_code, '19821');
});

test('отчёт импорта сохраняет отвергнутые строки и предупреждения', { skip }, async () => {
  const { channelId, user } = await makeSource();
  const id = await db.startCdekImport({ channel_id: channelId, uploaded_by: user.id, filename: 'a.xlsx', file_sha256: `${nonce}-rep` });
  const saved = await db.finishCdekImport(channelId, id, {
    stats: { rows_total: 10, rows_rejected: 2, orders_total: 7, period_from: '2025-09-01', period_to: '2025-09-30' },
    rejected: [{ row: 12, order_id: '1', reason: 'нет товара' }],
    warnings: ['Незнакомые статусы заказов: packing'],
    counts: { inserted: 6, updated: 2, deleted: 1 },
  });
  assert.equal(saved.rows_inserted, 6);
  assert.equal(saved.rows_deleted, 1);
  assert.equal(saved.period_from, '2025-09-01');
  assert.deepEqual(saved.rejected, [{ row: 12, order_id: '1', reason: 'нет товара' }]);
  assert.deepEqual(saved.warnings, ['Незнакомые статусы заказов: packing']);
});
