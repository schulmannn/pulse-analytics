'use strict';

/**
 * Разбор выгрузки заказов СДЭК Fulfillment: плоские строки листа → заказы, позиции и справочник
 * товаров. Чистый модуль (никакой БД и HTTP) — потому что вся содержательная часть импорта
 * именно здесь, и она обязана быть проверяема на настоящем файле без стенда.
 *
 * ГЛАВНОЕ О ФОРМАТЕ. Выгрузка ДЕНОРМАЛИЗОВАНА: строка = товар в заказе, поля заказа
 * повторяются. В эталонном файле 1126 строк на 1100 заказов (24 заказа по 2–3 позиции), то есть
 * «заказы = число строк» завышает на 2.4%.
 *
 * «Стоимость товара» — ЦЕНА ЗА ШТУКУ. Доказательство в самих данных: товар BG-GR7T встречается
 * с «Количество» 5 и 7 и в обоих случаях несёт «Стоимость товара» 3750. Проверить это по 99%
 * строк невозможно — там количество равно 1, и обе трактовки совпадают.
 *
 * НЕ ВСЕ СТРОКИ — ПРОДАЖИ. В выгрузке живут складские движения («Корректировка остатков»,
 * «ПЕРЕМЕЩЕНИЕ НА БРАК», «Самовывоз брака», SKU с суффиксом _BRAK). Их 7 из 1126, но они
 * завышают наивную выручку на 176 тыс ₽; вместе с отменами — на 12.2%. Поэтому строки
 * классифицируются здесь, а не фильтруются молча при чтении.
 */

/** Колонки выгрузки: внутреннее имя → заголовок в файле. Схема статическая (решение владельца). */
const COLUMN_TITLES = {
  order_id: 'ID',
  created: 'Создан',
  external_order_id: 'Внешний ID',
  track_number: 'Трек-номер',
  status: 'Статус',
  comment: 'Комментарий',
  product_id: 'ID товара',
  product_title: 'Название товара',
  product_external_id: 'Внешний ID товара',
  item_status: 'Статус товара',
  article: 'Артикул',
  sku: 'SKU товара',
  barcodes: 'Штрих-коды',
  unit_price: 'Стоимость товара',
  qty: 'Количество',
  qty_reserved: 'Зарезервированное количество',
  warehouse: 'Склад',
  carrier: 'Служба доставки',
};

/** Без этих колонок факта нет — импорт отвергается целиком с внятным перечнем недостающих. */
const REQUIRED_COLUMNS = ['order_id', 'created', 'status', 'product_id', 'unit_price', 'qty'];

/**
 * «Служба доставки» в выгрузке — это на самом деле КАНАЛ ПРОДАЖ: у Cdek есть свой трек-номер
 * (собственная доставка), у остальных — только внешний номер заказа маркетплейса. Нормализуем в
 * стабильный ключ; человеческие подписи живут во фронте, чтобы переименование витрины не
 * требовало переигрывать импорты.
 */
const SALES_CHANNELS = {
  cdek: 'own',
  'wb fbs': 'wildberries',
  'ym fbs': 'yandex_market',
  'ozon fbs': 'ozon',
};

/** Статусы, которые точно встречаются. Незнакомый статус НЕ роняет импорт — попадает в warnings. */
const KNOWN_STATUSES = new Set(['complete', 'delivery', 'cancel', 'return']);

/** Статусы, исключаемые из выручки. Отмен в эталонном файле 60, возврат 1 — это 7.2% суммы. */
const NON_REVENUE_STATUSES = new Set(['cancel', 'return']);

/**
 * Складское движение, а не продажа. Правило намеренно узкое — по комментарию и по SKU. Нулевую
 * цену в него НЕ включаем: бесплатная замена или подарок покупателю — всё ещё заказ, и списывать
 * его в складские движения было бы догадкой, а не фактом.
 */
const STOCK_MOVE_COMMENT = /корректиров|перемещен|брак|списан|инвентар/i;
const STOCK_MOVE_SKU = /_BRAK$/i;

/** Значения, которыми выгрузка обозначает пустоту. «None» — 1947 ячеек: шаблон печатает его
    вместо пустой строки, и без этого списка он стал бы полноправной категорией. */
const NULL_TOKENS = new Set(['', '-', '—', 'none', 'null', 'nan', 'н/д', 'нет']);

const MAX_REJECTED_KEPT = 1000;
const MAX_WARNINGS_KEPT = 50;

/** Заголовки сравниваем без регистра, неразрывных пробелов и хвостовых пробелов. */
function normalizeHeader(v) {
  return String(v == null ? '' : v).replace(/ /g, ' ').trim().toLowerCase();
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).replace(/ /g, ' ').trim();
  return NULL_TOKENS.has(s.toLowerCase()) ? null : s;
}

/** Число из ячейки: и настоящее число, и «3 750,00 ₽» с запятой, пробелами и валютой. */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = cleanText(v);
  if (s === null) return null;
  const cleaned = s.replace(/ /g, '').replace(/\s/g, '').replace(/[^\d,.\-+eE]/g, '').replace(',', '.');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Рубли → копейки. Округление обязательно: 2929.5 * 100 в double даёт 292950.00000000006. */
function toKopecks(v) {
  const n = toNumber(v);
  return n === null ? null : Math.round(n * 100);
}

function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.round(n);
}

/**
 * Дата из ячейки → НАИВНАЯ строка «YYYY-MM-DD HH:MM:SS». В зону она переводится уже в SQL
 * (AT TIME ZONE часового пояса источника) — так перевод часов отрабатывает по правилам зоны,
 * а не по смещению, посчитанному в момент импорта.
 */
function parseNaiveDate(v) {
  const s = cleanText(v);
  if (s === null) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const dotted = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!dotted) return null;
    m = [dotted[0], dotted[3], dotted[2], dotted[1], dotted[4], dotted[5], dotted[6]];
  }
  const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(se);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}:${p(second)}`;
}

/** «S/I/PO34527292*, 2047711458704» → два штрих-кода: поле многозначное и не всегда числовое. */
function splitBarcodes(v) {
  const s = cleanText(v);
  if (s === null) return [];
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
}

function normalizeChannel(carrier) {
  if (!carrier) return null;
  return SALES_CHANNELS[carrier.trim().toLowerCase()] || 'other';
}

function classifyKind({ comment, sku }) {
  if (comment && STOCK_MOVE_COMMENT.test(comment)) return 'stock_move';
  if (sku && STOCK_MOVE_SKU.test(sku)) return 'stock_move';
  return 'sale';
}

/**
 * Строка заголовков: ищем среди первых строк ту, где узнаётся хотя бы четыре известных названия.
 * Выгрузка может однажды приехать с шапкой-преамбулой — тогда слепое «первая строка = заголовок»
 * отвергло бы весь файл, а поиск найдёт настоящую шапку.
 */
function findHeaderRow(rows, scanLimit = 10) {
  const titles = new Set(Object.values(COLUMN_TITLES).map(normalizeHeader));
  let best = -1;
  let bestHits = 0;
  for (let i = 0; i < Math.min(rows.length, scanLimit); i++) {
    const hits = (rows[i] || []).filter((c) => titles.has(normalizeHeader(c))).length;
    if (hits > bestHits) { bestHits = hits; best = i; }
  }
  return bestHits >= 4 ? best : -1;
}

function mapColumns(headerRow) {
  const byTitle = new Map();
  (headerRow || []).forEach((cell, i) => {
    const key = normalizeHeader(cell);
    if (key && !byTitle.has(key)) byTitle.set(key, i);
  });
  const index = {};
  for (const [field, title] of Object.entries(COLUMN_TITLES)) {
    const at = byTitle.get(normalizeHeader(title));
    if (at !== undefined) index[field] = at;
  }
  return index;
}

class CdekParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdekParseError';
    this.userMessage = message;
  }
}

/**
 * Плоские строки листа → { orders, products, rejected, warnings, stats }.
 * Заказ собирается из всех своих строк; при противоречии между строками одного заказа по дате
 * или статусу заказ отвергается ЦЕЛИКОМ. Половина заказа в базе хуже его отсутствия: она молча
 * искажает и выручку, и средний чек, а отсутствие видно в отчёте импорта.
 */
function parseCdekSheet(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new CdekParseError('В файле нет строк с данными');
  const headerAt = findHeaderRow(rows);
  if (headerAt < 0) throw new CdekParseError('Не найдена строка заголовков выгрузки СДЭК');
  const col = mapColumns(rows[headerAt]);
  const missing = REQUIRED_COLUMNS.filter((f) => col[f] === undefined).map((f) => COLUMN_TITLES[f]);
  if (missing.length) throw new CdekParseError(`В файле нет обязательных колонок: ${missing.join(', ')}`);

  const at = (row, field) => (col[field] === undefined ? null : (row[col[field]] ?? null));
  const orders = new Map();
  const products = new Map();
  const rejected = [];
  const warnings = new Map();
  const unknownStatuses = new Set();
  const unknownCarriers = new Set();
  let rowsTotal = 0;
  let rowsRejected = 0;

  const warn = (text) => { if (!warnings.has(text)) warnings.set(text, warnings.size); };
  const reject = (fileRow, orderId, reason) => {
    rowsRejected++;
    if (rejected.length < MAX_REJECTED_KEPT) rejected.push({ row: fileRow, order_id: orderId || null, reason });
  };

  for (let i = headerAt + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const fileRow = i + 1; // 1-based, как в самом Excel
    if (row.every((c) => c == null || c === '')) continue;
    rowsTotal++;

    const orderId = cleanText(at(row, 'order_id'));
    const productId = cleanText(at(row, 'product_id'));
    const created = parseNaiveDate(at(row, 'created'));
    const status = (cleanText(at(row, 'status')) || '').toLowerCase() || null;
    const qty = toInt(at(row, 'qty'));
    const price = toKopecks(at(row, 'unit_price'));

    if (!orderId) { reject(fileRow, null, 'нет номера заказа'); continue; }
    if (!created) { reject(fileRow, orderId, 'неразборчивая дата создания'); continue; }
    if (!status) { reject(fileRow, orderId, 'нет статуса'); continue; }
    if (!productId) { reject(fileRow, orderId, 'нет товара'); continue; }
    if (qty === null || qty < 0) { reject(fileRow, orderId, 'неверное количество'); continue; }
    if (price === null || price < 0) { reject(fileRow, orderId, 'неверная стоимость товара'); continue; }

    if (!KNOWN_STATUSES.has(status)) unknownStatuses.add(status);
    const carrier = cleanText(at(row, 'carrier'));
    const channel = normalizeChannel(carrier);
    if (channel === 'other') unknownCarriers.add(carrier);
    const itemStatus = cleanText(at(row, 'item_status'));
    if (itemStatus && itemStatus.toLowerCase() !== 'normal') warn(`Встретился статус товара «${itemStatus}»`);

    const sku = cleanText(at(row, 'sku'));
    const comment = cleanText(at(row, 'comment'));

    let order = orders.get(orderId);
    if (!order) {
      order = {
        order_id: orderId,
        created,
        status,
        carrier,
        channel,
        external_order_id: cleanText(at(row, 'external_order_id')),
        track_number: cleanText(at(row, 'track_number')),
        warehouse_code: cleanText(at(row, 'warehouse')),
        comment,
        kind: classifyKind({ comment, sku }),
        items: new Map(),
        rows: [fileRow],
        conflict: null,
      };
      orders.set(orderId, order);
    } else {
      order.rows.push(fileRow);
      // Дата и статус ОПРЕДЕЛЯЮТ факт: их расхождение внутри одного номера означает, что наше
      // допущение «строки одного ID — один заказ» для этой строки неверно. Гадать нельзя.
      if (order.created !== created) order.conflict = 'строки заказа расходятся по дате создания';
      else if (order.status !== status) order.conflict = 'строки заказа расходятся по статусу';
      // Остальные поля заказа добираем первым непустым — расхождение здесь косметическое.
      order.carrier = order.carrier || carrier;
      order.channel = order.channel || channel;
      order.external_order_id = order.external_order_id || cleanText(at(row, 'external_order_id'));
      order.track_number = order.track_number || cleanText(at(row, 'track_number'));
      order.warehouse_code = order.warehouse_code || cleanText(at(row, 'warehouse'));
      order.comment = order.comment || comment;
      if (order.kind === 'sale' && classifyKind({ comment, sku }) === 'stock_move') order.kind = 'stock_move';
    }

    if (order.items.has(productId)) {
      order.conflict = 'один товар дважды в заказе';
    } else {
      order.items.set(productId, {
        product_id: productId,
        unit_price_kopecks: price,
        qty,
        qty_reserved: toInt(at(row, 'qty_reserved')),
      });
    }

    const product = products.get(productId) || { product_id: productId };
    product.title = cleanText(at(row, 'product_title')) || product.title || null;
    product.article = cleanText(at(row, 'article')) || product.article || null;
    product.sku = sku || product.sku || null;
    product.external_id = cleanText(at(row, 'product_external_id')) || product.external_id || null;
    const barcodes = splitBarcodes(at(row, 'barcodes'));
    if (barcodes.length) product.barcodes = barcodes;
    products.set(productId, product);
  }

  const accepted = [];
  const usedProducts = new Set();
  let periodFrom = null;
  let periodTo = null;
  let sales = 0;
  let stockMoves = 0;
  for (const order of orders.values()) {
    if (order.conflict) {
      for (const fileRow of order.rows) reject(fileRow, order.order_id, order.conflict);
      continue;
    }
    const day = order.created.slice(0, 10);
    if (!periodFrom || day < periodFrom) periodFrom = day;
    if (!periodTo || day > periodTo) periodTo = day;
    if (order.kind === 'sale') sales++; else stockMoves++;
    const { items, rows: _rows, conflict: _conflict, ...fields } = order;
    for (const productId of items.keys()) usedProducts.add(productId);
    accepted.push({ ...fields, items: [...items.values()] });
  }

  if (unknownStatuses.size) warn(`Незнакомые статусы заказов: ${[...unknownStatuses].join(', ')}`);
  if (unknownCarriers.size) warn(`Незнакомые службы доставки: ${[...unknownCarriers].join(', ')}`);

  const rowsAccepted = accepted.reduce((sum, o) => sum + o.items.length, 0);
  return {
    orders: accepted,
    // Товары только из ПРИНЯТЫХ заказов: справочник не должен пополняться позициями,
    // которые сами в базу не попали (отвергнутый заказ не создаёт товар).
    products: [...products.values()].filter((p) => usedProducts.has(p.product_id)),
    rejected,
    rejected_truncated: rowsRejected > rejected.length,
    warnings: [...warnings.keys()].slice(0, MAX_WARNINGS_KEPT),
    stats: {
      rows_total: rowsTotal,
      rows_accepted: rowsAccepted,
      rows_rejected: rowsRejected,
      orders_total: accepted.length,
      orders_sale: sales,
      orders_stock_move: stockMoves,
      period_from: periodFrom,
      period_to: periodTo,
    },
  };
}

module.exports = {
  parseCdekSheet,
  CdekParseError,
  COLUMN_TITLES,
  REQUIRED_COLUMNS,
  SALES_CHANNELS,
  KNOWN_STATUSES,
  NON_REVENUE_STATUSES,
  classifyKind,
  normalizeChannel,
  parseNaiveDate,
  toKopecks,
  toNumber,
  cleanText,
  splitBarcodes,
};
