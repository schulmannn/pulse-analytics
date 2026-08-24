'use strict';

// Тесты разбора выгрузки СДЭК (server/domain/cdekImport) — содержательное ядро импорта.
// Проверяются ровно те места, где выгрузка обманчива: денормализация (строк больше, чем заказов),
// цена за штуку против суммы строки, складские движения вперемешку с продажами, литерал «None»
// вместо пустоты. Каждый из этих случаев по отдельности выглядит безобидно и молча искажает
// выручку — вместе они дают 12.2% на годовом файле.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCdekSheet, CdekParseError } = require('../server/domain/cdekImport');
const { CDEK_HEADER, cdekRow } = require('./cdekFixtures');

const sheet = (...rows) => [CDEK_HEADER, ...rows];
const orderOf = (result, id) => result.orders.find((o) => o.order_id === String(id));

test('денормализация: три строки — два заказа, позиции собраны под своими заказами', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', price: 2850 }),
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p2', price: 3750 }),
    cdekRow({ id: 2, created: '2026-01-11 12:00:00', productId: 'p1', price: 2850 }),
  ));
  assert.equal(r.stats.rows_total, 3);
  assert.equal(r.stats.orders_total, 2, 'заказов меньше, чем строк — иначе счёт заказов завышен');
  assert.equal(orderOf(r, 1).items.length, 2);
  assert.equal(orderOf(r, 2).items.length, 1);
  assert.equal(r.stats.rows_rejected, 0);
});

test('«Стоимость товара» сохраняется как цена ЗА ШТУКУ, а не как сумма строки', () => {
  // Доказательство в самих данных: один товар при количестве 5 и 7 несёт ту же стоимость 3750.
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', price: 3750, qty: 5 }),
    cdekRow({ id: 2, created: '2026-01-10 10:05:00', productId: 'p1', price: 3750, qty: 7 }),
  ));
  assert.equal(orderOf(r, 1).items[0].unit_price_kopecks, 375000);
  assert.equal(orderOf(r, 1).items[0].qty, 5);
  assert.equal(orderOf(r, 2).items[0].unit_price_kopecks, 375000);
});

test('складские движения отделяются от продаж по комментарию и по SKU', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', comment: 'Корректировка остатков' }),
    cdekRow({ id: 2, created: '2026-01-10 11:00:00', productId: 'p2', comment: 'ПЕРЕМЕЩЕНИЕ НА БРАК' }),
    cdekRow({ id: 3, created: '2026-01-10 12:00:00', productId: 'p3', sku: 'BP-01-16-OR_BRAK', price: 0 }),
    cdekRow({ id: 4, created: '2026-01-10 13:00:00', productId: 'p4', comment: 'Заказ ЯМ принят на МП' }),
  ));
  assert.equal(orderOf(r, 1).kind, 'stock_move');
  assert.equal(orderOf(r, 2).kind, 'stock_move');
  assert.equal(orderOf(r, 3).kind, 'stock_move');
  assert.equal(orderOf(r, 4).kind, 'sale');
  assert.equal(r.stats.orders_sale, 1);
  assert.equal(r.stats.orders_stock_move, 3);
});

test('отменённый заказ остаётся продажей по типу — это несостоявшаяся продажа, не движение склада', () => {
  // Разделение важно: отмены нужны для «доли отмен», а складские движения не должны попадать ни
  // в выручку, ни в знаменатель этой доли.
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', status: 'cancel', carrier: 'YM FBS' }),
  ));
  assert.equal(orderOf(r, 1).kind, 'sale');
  assert.equal(orderOf(r, 1).status, 'cancel');
});

test('литерал «None» и прочерк читаются как пустота, а не как категория', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({
      id: 1, created: '2026-01-10 10:00:00', productId: 'p1',
      externalId: 'None', track: '—', comment: 'Принят на МП None', carrier: 'None',
    }),
  ));
  const order = orderOf(r, 1);
  assert.equal(order.external_order_id, null);
  assert.equal(order.track_number, null);
  assert.equal(order.carrier, null, 'служба доставки «None» — это отсутствие службы');
  assert.equal(order.channel, null);
  assert.equal(order.comment, 'Принят на МП None', 'внутри текста None остаётся текстом');
});

test('деньги: пробелы, запятая и символ валюты не мешают перевести в копейки', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', price: '3 750,00 ₽' }),
    cdekRow({ id: 2, created: '2026-01-10 10:00:00', productId: 'p1', price: 2929.5 }),
  ));
  assert.equal(orderOf(r, 1).items[0].unit_price_kopecks, 375000);
  assert.equal(orderOf(r, 2).items[0].unit_price_kopecks, 292950, 'без округления double дал бы 292950.00000000006');
});

test('даты: ISO и российский формат приводятся к одной наивной строке', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2025-07-31 15:39:48', productId: 'p1' }),
    cdekRow({ id: 2, created: '31.07.2025 15:39', productId: 'p1' }),
    cdekRow({ id: 3, created: '2025-07-31', productId: 'p1' }),
  ));
  assert.equal(orderOf(r, 1).created, '2025-07-31 15:39:48');
  assert.equal(orderOf(r, 2).created, '2025-07-31 15:39:00');
  assert.equal(orderOf(r, 3).created, '2025-07-31 00:00:00');
});

test('служба доставки нормализуется в канал продаж, незнакомая — в other с предупреждением', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', carrier: 'Cdek' }),
    cdekRow({ id: 2, created: '2026-01-10 10:00:00', productId: 'p1', carrier: 'WB FBS' }),
    cdekRow({ id: 3, created: '2026-01-10 10:00:00', productId: 'p1', carrier: 'YM FBS' }),
    cdekRow({ id: 4, created: '2026-01-10 10:00:00', productId: 'p1', carrier: 'OZON FBS' }),
    cdekRow({ id: 5, created: '2026-01-10 10:00:00', productId: 'p1', carrier: 'Почта России' }),
  ));
  assert.equal(orderOf(r, 1).channel, 'own');
  assert.equal(orderOf(r, 2).channel, 'wildberries');
  assert.equal(orderOf(r, 3).channel, 'yandex_market');
  assert.equal(orderOf(r, 4).channel, 'ozon');
  assert.equal(orderOf(r, 5).channel, 'other');
  assert.ok(r.warnings.some((w) => /Почта России/.test(w)), 'незнакомый канал виден в отчёте');
  assert.equal(r.stats.rows_rejected, 0, 'но импорт из-за него не падает');
});

test('незнакомый статус принимается и попадает в предупреждения', () => {
  // Новый статус в СДЭКе не должен ронять импорт: данные важнее нашего перечня.
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', status: 'packing' }),
  ));
  assert.equal(orderOf(r, 1).status, 'packing');
  assert.ok(r.warnings.some((w) => /packing/.test(w)));
});

test('строки без обязательных значений отвергаются поимённо', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: null, created: '2026-01-10 10:00:00', productId: 'p1' }),
    cdekRow({ id: 2, created: 'позавчера', productId: 'p1' }),
    cdekRow({ id: 3, created: '2026-01-10 10:00:00', productId: null }),
    cdekRow({ id: 4, created: '2026-01-10 10:00:00', productId: 'p1', qty: 'много' }),
    cdekRow({ id: 5, created: '2026-01-10 10:00:00', productId: 'p1', price: -100 }),
    cdekRow({ id: 6, created: '2026-01-10 10:00:00', productId: 'p1' }),
  ));
  assert.equal(r.stats.orders_total, 1, 'принят только последний заказ');
  assert.equal(r.stats.rows_rejected, 5);
  assert.deepEqual(r.rejected.map((x) => x.reason), [
    'нет номера заказа',
    'неразборчивая дата создания',
    'нет товара',
    'неверное количество',
    'неверная стоимость товара',
  ]);
  assert.equal(r.rejected[0].row, 2, 'номер строки — как в самом Excel, с учётом шапки');
});

test('дубль позиции отвергает ВЕСЬ заказ, а не одну строку', () => {
  // Половина заказа в базе хуже его отсутствия: она молча искажает и выручку, и средний чек,
  // а отсутствие видно в отчёте импорта.
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', price: 1000 }),
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', price: 2000 }),
    cdekRow({ id: 2, created: '2026-01-10 11:00:00', productId: 'p1' }),
  ));
  assert.equal(r.stats.orders_total, 1);
  assert.equal(orderOf(r, 1), undefined);
  assert.equal(r.stats.rows_rejected, 2, 'обе строки заказа отвергнуты');
  assert.deepEqual([...new Set(r.rejected.map((x) => x.reason))], ['один товар дважды в заказе']);
});

test('расхождение даты или статуса между строками одного заказа отвергает заказ', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1' }),
    cdekRow({ id: 1, created: '2026-01-11 10:00:00', productId: 'p2' }),
    cdekRow({ id: 2, created: '2026-01-10 10:00:00', productId: 'p1', status: 'complete' }),
    cdekRow({ id: 2, created: '2026-01-10 10:00:00', productId: 'p2', status: 'cancel' }),
  ));
  assert.equal(r.stats.orders_total, 0);
  assert.deepEqual([...new Set(r.rejected.map((x) => x.reason))], [
    'строки заказа расходятся по дате создания',
    'строки заказа расходятся по статусу',
  ]);
});

test('поля заказа добираются первым непустым по строкам заказа', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', track: null, externalId: null }),
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p2', track: '10145274548', externalId: '369248' }),
  ));
  assert.equal(orderOf(r, 1).track_number, '10145274548');
  assert.equal(orderOf(r, 1).external_order_id, '369248');
});

test('период импорта — размах дат принятых заказов', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-03-05 10:00:00', productId: 'p1' }),
    cdekRow({ id: 2, created: '2025-07-31 15:39:48', productId: 'p1' }),
    cdekRow({ id: 3, created: '2026-07-30 17:09:09', productId: 'p1' }),
  ));
  assert.equal(r.stats.period_from, '2025-07-31');
  assert.equal(r.stats.period_to, '2026-07-30');
});

test('справочник товаров: штрих-коды списком, только по принятым заказам', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({
      id: 1, created: '2026-01-10 10:00:00', productId: 'p1', title: 'Чехол', article: 'CS-O14',
      sku: 'CS-O14', barcodes: 'S/I/PO34527292*, 2047711458704',
    }),
    // Заказ-дубль отвергается целиком — его товар в справочник попасть не должен.
    cdekRow({ id: 2, created: '2026-01-10 11:00:00', productId: 'p9', title: 'Отвергнутый' }),
    cdekRow({ id: 2, created: '2026-01-10 11:00:00', productId: 'p9', title: 'Отвергнутый' }),
  ));
  assert.equal(r.products.length, 1);
  assert.deepEqual(r.products[0].barcodes, ['S/I/PO34527292*', '2047711458704']);
  assert.equal(r.products[0].article, 'CS-O14');
});

test('шапка ищется, а не предполагается в первой строке', () => {
  const r = parseCdekSheet([
    ['Выгрузка заказов за период'],
    [],
    CDEK_HEADER,
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1' }),
  ]);
  assert.equal(r.stats.orders_total, 1);
  assert.equal(r.stats.rows_total, 1);
});

test('чужой файл отвергается с перечнем недостающих колонок', () => {
  assert.throws(
    () => parseCdekSheet([['Дата', 'Сумма', 'Клиент'], ['2026-01-10', 100, 'Иванов']]),
    (e) => {
      assert.ok(e instanceof CdekParseError);
      assert.match(e.userMessage, /Не найдена строка заголовков/);
      return true;
    },
  );
  const nearlyRight = CDEK_HEADER.filter((h) => h !== 'Стоимость товара' && h !== 'Количество');
  assert.throws(
    () => parseCdekSheet([nearlyRight, nearlyRight.map(() => 'x')]),
    /нет обязательных колонок: Стоимость товара, Количество/,
  );
});

test('пустые строки в конце листа не считаются данными', () => {
  const r = parseCdekSheet(sheet(
    cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1' }),
    [null, null, null],
    [],
  ));
  assert.equal(r.stats.rows_total, 1);
  assert.equal(r.stats.rows_rejected, 0);
});
