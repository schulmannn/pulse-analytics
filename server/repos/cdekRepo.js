'use strict';

const { SALES_CHANNELS, NON_REVENUE_STATUSES, ORDER_STATUSES } = require('../domain/cdekImport');

/* ── СДЭК Fulfillment: источник, импорты и архив заказов (миграция 038) ─────────────────────────
   Первый источник без API: наполняется ручной загрузкой Excel, поэтому здесь нет ни токена, ни
   крона — только приём файла и идемпотентная запись его содержимого.

   Идентичность источника — ПЕР-КАНАЛЬНАЯ (`ch:<channel_id>` в external_sources), а не код склада.
   Строка external_sources общая для всех воркспейсов: канонизируй мы склад по его коду, две
   независимые компании с одинаковым кодом склада схлопнулись бы в один источник — для публичного
   TG-канала это ровно то, что нужно, а для приватной выгрузки фулфилмента это утечка между
   тенантами. Код склада поэтому хранится атрибутом (и расхождение с файлом попадает в
   предупреждения импорта), но идентичности не задаёт.

   Каждый метод несёт channel_id — включая обновление строки импорта по её id: инвариант
   «любой tenant-write содержит channel_id» не делает исключения для «внутренних» вызовов,
   потому что именно так и появляется первый межтенантный доступ.

   Запись данных — одной транзакцией на импорт: заказ пере-записывается ЦЕЛИКОМ (в СДЭКе статус
   правится задним числом, и перевыгрузка с нахлёстом обязана донести правку), позиции, исчезнувшие
   из новой версии заказа, удаляются — иначе в базе останется фантомная строка, которую никакой
   последующий импорт уже не тронет. */

const IMPORT_COLS = `id, channel_id, uploaded_by, filename, file_sha256, status,
  rows_total, rows_inserted, rows_updated, rows_rejected, rows_deleted, orders_total,
  to_char(period_from, 'YYYY-MM-DD') AS period_from,
  to_char(period_to, 'YYYY-MM-DD') AS period_to,
  rejected, warnings, error,
  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
  to_char(finished_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS finished_at`;

// Заказов на транзакционный чанк. Держит размер JSON-параметра и unnest-массивов предсказуемым:
// годовая выгрузка склада владельца — 1100 заказов, то есть три чанка.
const CHUNK_ORDERS = 500;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Окно чтения в зоне ИСТОЧНИКА: from/to — календарные дни (YYYY-MM-DD) включительно, как у
 * МойСклада. В SQL это полуинтервал [начало from, начало to+1) — так последний день входит целиком
 * и без «23:59:59», которое теряет последнюю секунду суток. NULL по обеим границам = «Всё».
 */
const WINDOW_BOUNDS = `
  SELECT ($2::date)::timestamp AT TIME ZONE $6 AS cur_from,
         (($3::date) + 1)::timestamp AT TIME ZONE $6 AS cur_to,
         ($4::date)::timestamp AT TIME ZONE $6 AS prev_from,
         (($5::date) + 1)::timestamp AT TIME ZONE $6 AS prev_to`;

/** Принадлежность строки окну: 1 — текущее, 0 — предыдущее, NULL — вне обоих. */
const WINDOW_CASE = `
  CASE
    WHEN (b.cur_from IS NULL OR o.created_ts >= b.cur_from)
     AND (b.cur_to IS NULL OR o.created_ts < b.cur_to) THEN 1
    WHEN b.prev_from IS NOT NULL AND o.created_ts >= b.prev_from AND o.created_ts < b.prev_to THEN 0
  END`;

/**
 * Что считать выручкой. Владелец решил: отгруженное — уже проданное, поэтому в деньги входят и
 * `complete`, и `delivery`; исключаются только отменённые и возвращённые. `completed` — ручной
 * режим «только завершённые», `all` — вообще без фильтра статуса (нужен разбивке ПО статусам:
 * иначе она показала бы лишь те статусы, которые сама же и отобрала).
 */
/** Набор «не выручка» в виде SQL-литерала — собирается из домена ОДИН раз при загрузке модуля. */
const NON_REVENUE_SQL = `ARRAY[${[...NON_REVENUE_STATUSES].map((s2) => `'${s2}'`).join(', ')}]::text[]`;

const REVENUE_FILTER = `
  (CASE
     WHEN $7::text LIKE 'status:%'
       THEN o.status = ANY(string_to_array(substr($7::text, 8), ','))
     WHEN $7::text = 'all' THEN true
     WHEN $7::text = 'completed' THEN o.status = 'complete'
     ELSE o.status <> ALL(${NON_REVENUE_SQL})
   END)`;

/**
 * Строки продаж окна. Функция ОТ ИНДЕКСА плейсхолдера, а не константа: фильтр по товарам должен
 * стоять в общем фрагменте, но у каждого запроса свой хвост параметров (grain у ряда, dim у
 * разбивки). Двигать общий префикс `windowParams` ради восьмого параметра значило бы перенумеровать
 * плейсхолдеры сразу в четырёх запросах — а ошибка там тихая: параметр молча уедет не в тот слот.
 * Поэтому индекс приходит снаружи, а каждый вызывающий дописывает массив товаров последним.
 *
 * Фильтр режет СТРОКИ ПОЗИЦИЙ, а не заказы: тогда выручка — это сумма выбранных товаров, «Заказы»
 * — заказы, в которых они есть, а «Штук» — их штуки. Все три числа отвечают на один вопрос.
 */
const saleRows = (productsIdx, channelsIdx) => `
  FROM cdek_orders o
  JOIN cdek_order_items i ON i.channel_id = o.channel_id AND i.order_id = o.order_id
  CROSS JOIN b
 WHERE o.channel_id = $1 AND o.kind = 'sale'
   AND ($${productsIdx}::text[] IS NULL OR i.product_id = ANY($${productsIdx}))
   AND ($${channelsIdx}::text[] IS NULL OR COALESCE(o.channel, '') = ANY($${channelsIdx}))`;

/**
 * Каналы продаж, известные разбору выгрузки. Список ВЫВОДИТСЯ из карты импорта, а не переписан
 * рядом: появится новый маркетплейс — фильтр узнает о нём вместе с импортом, а не через полгода.
 * `other` в карте нет по построению (это ветка «всё остальное»), поэтому дописывается явно.
 */
const SALES_CHANNEL_KEYS = [...new Set([...Object.values(SALES_CHANNELS), 'other'])].sort();

/**
 * Набор каналов продаж для запроса; null — фильтра нет.
 *
 * Незнакомый ключ — ОШИБКА, а не повод молча вернуть ноль строк: «Wildberrys» с опечаткой дал бы
 * пустой график, неотличимый от «продаж не было». Возвращаем признак, роут отвечает отказом —
 * тот же приём, что у потолка товаров и у каналов МойСклада.
 */
function normalizeCdekChannels(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  const picked = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort();
  if (picked.length === 0) return null;
  if (picked.some((key) => !SALES_CHANNEL_KEYS.includes(key))) return { unknown: true };
  // Выбраны все — это «фильтра нет»: короче строка, устойчивее кэш (тот же приём у статусов).
  return picked.length === SALES_CHANNEL_KEYS.length ? null : picked;
}

/** Ограничение набора товаров: столько влезает в осмысленный выбор, дальше это уже «все». */
const PRODUCT_FILTER_MAX = 50;

/**
 * Массив товаров для параметра запроса; null — фильтра нет (а не «ноль товаров»).
 *
 * Перебор потолка — ОШИБКА, а не повод молча срезать хвост. Раньше 51-й товар просто исчезал:
 * выручка считалась по пятидесяти, а карточка над ней писала «Только выбранные товары: 51», и
 * узнать о подмене было неоткуда — ответ применённый список не возвращает. Тот же вопрос в
 * МойСкладе решён отказом («Можно выбрать не более 20 каналов»), и здесь теперь так же: неверное
 * число честнее подменённого.
 */
function normalizeCdekProducts(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  const picked = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort();
  if (picked.length > PRODUCT_FILTER_MAX) return { tooMany: true };
  return picked.length > 0 ? picked : null;
}

const INCLUDE_MODES = new Set(['revenue', 'completed', 'all']);
/** Статусы заказа, известные разбору выгрузки. Произвольный набор строится ТОЛЬКО из них. */
// Список статусов — из домена, а не переписан рядом: разойдись они, фильтр молча перестал бы
// принимать статус, который импорт кладёт в базу.

/**
 * Нормализация «что считать выручкой». Кроме трёх прежних режимов принимает явный набор статусов
 * `status:complete,delivery` (запрос владельца — считать выручку по выбранным статусам).
 *
 * Набор едет ТЕМ ЖЕ параметром $7, а не новым: `windowParams` отдаёт ровно $1..$7, и каждый
 * читающий запрос дописывает свои плейсхолдеры следом — восьмой параметр в префиксе сдвинул бы
 * нумерацию во всех запросах сразу. Здесь же меняется одно место.
 *
 * Значения из набора всегда из белого списка, отсортированы и без дублей: иначе один и тот же
 * выбор давал бы разные строки и, следовательно, разные ключи кэша на клиенте.
 */
function normalizeCdekInclude(raw) {
  if (typeof raw !== 'string') return 'revenue';
  if (INCLUDE_MODES.has(raw)) return raw;
  if (!raw.startsWith('status:')) return 'revenue';
  const picked = [...new Set(raw.slice(7).split(',').map((s) => s.trim()))]
    .filter((s) => ORDER_STATUSES.includes(s))
    .sort();
  // Пустой или целиком мусорный набор — это не «ничего не считать», а «выбора нет»: падаем на
  // канонический режим, а не показываем ноль, который человек прочитал бы как отсутствие продаж.
  if (picked.length === 0) return 'revenue';
  // Набор, совпавший со всеми статусами, — это режим «все»: короче строка, устойчивее кэш.
  return picked.length === ORDER_STATUSES.length ? 'all' : `status:${picked.join(',')}`;
}
const BREAKDOWN_DIMS = new Set(['channel', 'status', 'product', 'carrier']);
// Потолок групп в разбивке: страховка от неожиданно широкого измерения (ассортимент склада
// владельца — 54 позиции). Обрезанное честно помечается флагом, а не исчезает молча.
const BREAKDOWN_MAX_GROUPS = 2000;
// Потолок дней в календаре покрытия — два года с хвостом; больше не влезает ни в один экран.
const COVERAGE_MAX_DAYS = 800;
// Потолок строк ленты заказов. Таблица виртуализована, но ответ всё равно не должен раздуваться:
// годовая выгрузка склада — 1100 заказов, тысяча покрывает окно с запасом.
const ORDERS_MAX_ROWS = 1000;

function createCdekRepo({ pool, enabled, transaction, ensureExternalSource, getAccessibleChannel }) {
  const allowed = (channelId, actor) =>
    (getAccessibleChannel ? getAccessibleChannel(channelId, actor) : Promise.resolve(null));

  /** Параметры окна в порядке $1..$7 — общий префикс всех читающих запросов. */
  const windowParams = (channelId, { from = null, to = null, prevFrom = null, prevTo = null, tz = 'Europe/Moscow', include = 'revenue' }) =>
    [channelId, from, to, prevFrom, prevTo, tz, normalizeCdekInclude(include)];

  // ── Источник ────────────────────────────────────────────────────────────────────────────────

  async function getCdekSource(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT channel_id, warehouse_code, tz, source_id,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
         FROM cdek_sources WHERE channel_id = $1`,
      [channelId]);
    return rows[0] || null;
  }

  // Канонический source + строка источника + штамп канала — одной транзакцией, зеркально
  // saveMsAccount: падение между записями не должно оставить источник без source-связки.
  async function saveCdekSource(channelId, { warehouse_code = null, tz = 'Europe/Moscow', title = null } = {}) {
    if (!enabled || !channelId) return false;
    return transaction(async (client) => {
      const srcId = await ensureExternalSource('cdek', `ch:${channelId}`, { title }, client);
      await client.query(
        `INSERT INTO cdek_sources (channel_id, warehouse_code, tz, source_id, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (channel_id) DO UPDATE SET
           warehouse_code = COALESCE(cdek_sources.warehouse_code, EXCLUDED.warehouse_code),
           tz = EXCLUDED.tz,
           source_id = COALESCE(cdek_sources.source_id, EXCLUDED.source_id),
           updated_at = now()`,
        [channelId, warehouse_code, tz, srcId]);
      await client.query(
        `UPDATE channels SET source_id = $2
          WHERE id = $1 AND source_id IS NULL AND tg_channel_id IS NULL AND source = 'cdek'`,
        [channelId, srcId]);
      return true;
    });
  }

  // Код склада проставляется первым импортом, который его увидел, и дальше не переписывается:
  // источник, сменивший склад, — это другой источник, и молча переезжать он не должен.
  async function setCdekWarehouse(channelId, warehouseCode) {
    if (!enabled || !channelId || !warehouseCode) return false;
    const { rowCount } = await pool.query(
      `UPDATE cdek_sources SET warehouse_code = $2, updated_at = now()
        WHERE channel_id = $1 AND warehouse_code IS NULL`,
      [channelId, String(warehouseCode)]);
    return rowCount > 0;
  }

  // ── Импорты ─────────────────────────────────────────────────────────────────────────────────

  /** Уже успешно загруженный файл с тем же содержимым (sha256) — повторная загрузка = no-op. */
  async function findCdekImportByHash(channelId, sha256) {
    if (!enabled || !channelId || !sha256) return null;
    const { rows } = await pool.query(
      `SELECT ${IMPORT_COLS} FROM cdek_imports
        WHERE channel_id = $1 AND file_sha256 = $2 AND status = 'done' LIMIT 1`,
      [channelId, sha256]);
    return rows[0] || null;
  }

  async function startCdekImport({ channel_id, uploaded_by = null, filename, file_sha256, file_bytes = null }) {
    if (!enabled || !channel_id) return null;
    const { rows } = await pool.query(
      `INSERT INTO cdek_imports (channel_id, uploaded_by, filename, file_sha256, file_bytes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [channel_id, uploaded_by, String(filename || 'файл'), file_sha256, file_bytes]);
    return rows[0] ? rows[0].id : null;
  }

  /**
   * Завершение импорта. Уникальный индекс живёт только на успешных строках, поэтому гонка двух
   * одинаковых файлов вскрывается ЗДЕСЬ: 23505 означает, что параллельная загрузка того же файла
   * успела финишировать первой. Данные от этого не страдают (запись идемпотентна) — снимаем свою
   * pending-строку и честно отвечаем «дубль», а не плодим второй отчёт о том же файле.
   */
  async function finishCdekImport(channelId, id, { stats, rejected = [], warnings = [], counts = {} }, { replay = false } = {}) {
    if (!enabled || !channelId || !id) return null;
    try {
      const { rows } = await pool.query(
        `UPDATE cdek_imports SET status = 'done', finished_at = now(), error = NULL,
                rows_total = $3, rows_inserted = $4, rows_updated = $5, rows_rejected = $6,
                rows_deleted = $7, orders_total = $8, period_from = $9, period_to = $10,
                rejected = $11::jsonb, warnings = $12::jsonb
          WHERE id = $1 AND channel_id = $2 AND (status = 'pending' OR $13)
          RETURNING ${IMPORT_COLS}`,
        [id, channelId, stats.rows_total, counts.inserted || 0, counts.updated || 0, stats.rows_rejected,
          counts.deleted || 0, stats.orders_total, stats.period_from, stats.period_to,
          JSON.stringify(rejected), JSON.stringify(warnings), replay]);
      return rows[0] || null;
    } catch (e) {
      if (e && e.code === '23505') {
        await pool.query(
          'DELETE FROM cdek_imports WHERE id = $1 AND channel_id = $2 AND status = $3',
          [id, channelId, 'pending']);
        return { duplicate: true };
      }
      throw e;
    }
  }

  async function failCdekImport(channelId, id, message) {
    if (!enabled || !channelId || !id) return false;
    // Сырой файл упавшего импорта не нужен: переигрывать нечего, а место он занимает.
    const { rowCount } = await pool.query(
      `UPDATE cdek_imports SET status = 'error', error = $3, finished_at = now(), file_bytes = NULL
        WHERE id = $1 AND channel_id = $2 AND status = 'pending'`,
      [id, channelId, String(message || 'ошибка импорта').slice(0, 500)]);
    return rowCount > 0;
  }

  async function listCdekImports(channelId, limit = 50) {
    if (!enabled || !channelId) return [];
    const { rows } = await pool.query(
      `SELECT ${IMPORT_COLS}, file_bytes IS NOT NULL AS has_file FROM cdek_imports
        WHERE channel_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [channelId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]);
    return rows;
  }

  async function getCdekImport(channelId, id) {
    if (!enabled || !channelId || !id) return null;
    const { rows } = await pool.query(
      `SELECT ${IMPORT_COLS}, file_bytes IS NOT NULL AS has_file FROM cdek_imports
        WHERE channel_id = $1 AND id = $2`,
      [channelId, id]);
    return rows[0] || null;
  }

  /** Сырой файл для переигровки правил классификации. null = файл не сохранён (упавший импорт). */
  async function getCdekImportFile(channelId, id) {
    if (!enabled || !channelId || !id) return null;
    const { rows } = await pool.query(
      'SELECT filename, file_bytes FROM cdek_imports WHERE channel_id = $1 AND id = $2',
      [channelId, id]);
    return rows[0] && rows[0].file_bytes ? rows[0] : null;
  }

  // ── Запись содержимого файла ────────────────────────────────────────────────────────────────

  /**
   * Заказы, позиции и справочник товаров одной транзакцией на чанк.
   * inserted/updated считаются по ПОЗИЦИЯМ (строкам файла — тому, что пользователь видит в
   * Excel) через `xmax = 0`: в upsert'е это единственный честный способ отличить вставку от
   * обновления, не делая предварительного SELECT.
   */
  async function applyCdekImport({ channelId, importId, tz = 'Europe/Moscow', orders = [], products = [] }) {
    if (!enabled || !channelId) return { inserted: 0, updated: 0, deleted: 0 };
    let inserted = 0;
    let updated = 0;
    let deleted = 0;

    for (const batch of chunk(orders, CHUNK_ORDERS)) {
      const orderIds = [];
      const productIds = [];
      const prices = [];
      const qtys = [];
      const reserved = [];
      for (const order of batch) {
        for (const item of order.items) {
          orderIds.push(order.order_id);
          productIds.push(item.product_id);
          prices.push(item.unit_price_kopecks);
          qtys.push(item.qty);
          reserved.push(item.qty_reserved === undefined ? null : item.qty_reserved);
        }
      }
      // Поля заказа перечислены явно: в jsonb уезжает ровно то, что читает SQL ниже, и лишнее
      // поле парсера не может незаметно просочиться в запись.
      const payload = JSON.stringify(batch.map((o) => ({
        order_id: o.order_id,
        created: o.created,
        status: o.status,
        carrier: o.carrier ?? null,
        channel: o.channel ?? null,
        external_order_id: o.external_order_id ?? null,
        track_number: o.track_number ?? null,
        warehouse_code: o.warehouse_code ?? null,
        comment: o.comment ?? null,
        kind: o.kind,
      })));

      // Чанки идут последовательно намеренно: параллельные транзакции по одним и тем же ключам
      // заказов дали бы взаимные блокировки.
      await transaction(async (client) => {
        await client.query(
          `INSERT INTO cdek_orders (channel_id, order_id, created_ts, status, carrier, channel,
                                    external_order_id, track_number, warehouse_code, comment, kind,
                                    import_id, updated_at)
           SELECT $1, o->>'order_id', (o->>'created')::timestamp AT TIME ZONE $3,
                  o->>'status', o->>'carrier', o->>'channel', o->>'external_order_id',
                  o->>'track_number', o->>'warehouse_code', o->>'comment', o->>'kind', $4, now()
             FROM jsonb_array_elements($2::jsonb) AS o
           ON CONFLICT (channel_id, order_id) DO UPDATE SET
             created_ts = EXCLUDED.created_ts, status = EXCLUDED.status, carrier = EXCLUDED.carrier,
             channel = EXCLUDED.channel, external_order_id = EXCLUDED.external_order_id,
             track_number = EXCLUDED.track_number, warehouse_code = EXCLUDED.warehouse_code,
             comment = EXCLUDED.comment, kind = EXCLUDED.kind,
             import_id = EXCLUDED.import_id, updated_at = now()`,
          [channelId, payload, tz, importId]);

        // Позиция, пропавшая из новой версии заказа, удаляется — иначе она навсегда останется в
        // базе и будет считаться в выручке заказа, которого в ней уже нет.
        const gone = await client.query(
          `DELETE FROM cdek_order_items i
            WHERE i.channel_id = $1 AND i.order_id = ANY($2::text[])
              AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(o, p)
                               WHERE k.o = i.order_id AND k.p = i.product_id)`,
          [channelId, orderIds, productIds]);
        deleted += gone.rowCount || 0;

        const items = await client.query(
          `INSERT INTO cdek_order_items (channel_id, order_id, product_id, unit_price_kopecks,
                                         qty, qty_reserved, import_id)
           SELECT $1, k.o, k.p, k.price, k.q, k.qr, $7
             FROM unnest($2::text[], $3::text[], $4::bigint[], $5::int[], $6::int[])
                  AS k(o, p, price, q, qr)
           ON CONFLICT (channel_id, order_id, product_id) DO UPDATE SET
             unit_price_kopecks = EXCLUDED.unit_price_kopecks, qty = EXCLUDED.qty,
             qty_reserved = EXCLUDED.qty_reserved, import_id = EXCLUDED.import_id
           RETURNING (xmax = 0) AS inserted`,
          [channelId, orderIds, productIds, prices, qtys, reserved, importId]);
        for (const row of items.rows) {
          if (row.inserted) inserted++; else updated++;
        }
      });
    }

    for (const batch of chunk(products, CHUNK_ORDERS)) {
      await pool.query(
        `INSERT INTO cdek_products (channel_id, product_id, title, article, sku, barcodes,
                                    external_id, last_seen)
         SELECT $1, p->>'product_id', p->>'title', p->>'article', p->>'sku',
                COALESCE(ARRAY(SELECT jsonb_array_elements_text(p->'barcodes')), '{}'::text[]),
                p->>'external_id', now()
           FROM jsonb_array_elements($2::jsonb) AS p
         ON CONFLICT (channel_id, product_id) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, cdek_products.title),
           article = COALESCE(EXCLUDED.article, cdek_products.article),
           sku = COALESCE(EXCLUDED.sku, cdek_products.sku),
           barcodes = CASE WHEN EXCLUDED.barcodes = '{}'::text[]
                           THEN cdek_products.barcodes ELSE EXCLUDED.barcodes END,
           external_id = COALESCE(EXCLUDED.external_id, cdek_products.external_id),
           last_seen = now()`,
        [channelId, JSON.stringify(batch)]);
    }

    return { inserted, updated, deleted };
  }

  // ── Чтение архива ───────────────────────────────────────────────────────────────────────────
  // Все ридеры — ForActor: доступ проверяется ownership-чеком канала (getAccessibleChannel), даже
  // если роут уже резолвил канал сам. Голого un-gated ридера в публичном API нет (канон
  // analyticsRepo). Суммы наружу идут В КОПЕЙКАХ — в рубли переводит граница API.

  /**
   * Итоги окна и равного предыдущего одним запросом. Один запрос вместо двух — не про скорость:
   * два отдельных чтения текущего и прошлого окна разъезжаются на границе суток и дают дельту,
   * посчитанную по разным данным.
   */
  async function getCdekSummaryForActor(channelId, actor, opts = {}) {
    if (!enabled || !(await allowed(channelId, actor))) return null;
    const { rows } = await pool.query(
      `WITH b AS (${WINDOW_BOUNDS}),
       r AS (
         SELECT o.order_id, o.status, i.amount_kopecks, i.qty, ${WINDOW_CASE} AS win,
                ${REVENUE_FILTER} AS counts
         ${saleRows(8, 9)}
       )
       SELECT win,
              COALESCE(sum(amount_kopecks) FILTER (WHERE counts), 0) AS revenue_kopecks,
              count(DISTINCT order_id) FILTER (WHERE counts) AS orders,
              COALESCE(sum(qty) FILTER (WHERE counts), 0) AS items,
              count(DISTINCT order_id) AS orders_all,
              count(DISTINCT order_id) FILTER (WHERE status = 'cancel') AS orders_cancelled,
              count(DISTINCT order_id) FILTER (WHERE status = 'return') AS orders_returned
         FROM r WHERE win IS NOT NULL GROUP BY win`,
      [...windowParams(channelId, opts), normalizeCdekProducts(opts.products), opts.channels ?? null]);
    const pick = (win) => rows.find((x) => Number(x.win) === win) || null;
    return { current: pick(1), previous: pick(0) };
  }

  /**
   * Дневной/недельный/месячный ряд текущего и предыдущего окна. Пустые корзины НЕ достраиваются:
   * плотную сетку рисует фронт (densifyDayPoints у МойСклада) — он один знает, где «нет заказов»
   * это ноль, а где данных просто нет.
   */
  async function getCdekSeriesForActor(channelId, actor, opts = {}) {
    if (!enabled || !(await allowed(channelId, actor))) return { current: [], previous: [] };
    const grain = ['day', 'week', 'month'].includes(opts.grain) ? opts.grain : 'day';
    const { rows } = await pool.query(
      `WITH b AS (${WINDOW_BOUNDS}),
       r AS (
         SELECT o.order_id, i.amount_kopecks, i.qty, ${WINDOW_CASE} AS win,
                to_char(date_trunc($8, o.created_ts AT TIME ZONE $6), 'YYYY-MM-DD') AS day
         ${saleRows(9, 10)} AND ${REVENUE_FILTER}
       )
       SELECT win, day,
              COALESCE(sum(amount_kopecks), 0) AS revenue_kopecks,
              count(DISTINCT order_id) AS orders,
              COALESCE(sum(qty), 0) AS items
         FROM r WHERE win IS NOT NULL GROUP BY win, day ORDER BY day`,
      [...windowParams(channelId, opts), grain, normalizeCdekProducts(opts.products), opts.channels ?? null]);
    return {
      grain,
      current: rows.filter((r) => Number(r.win) === 1),
      previous: rows.filter((r) => Number(r.win) === 0),
    };
  }

  /**
   * Разрез окна по измерению с величинами предыдущего окна в тех же строках — иначе «вклад в
   * изменение» и базовая колонка рангов собирались бы из двух ответов, которые могли приехать по
   * разным границам.
   */
  async function getCdekBreakdownForActor(channelId, actor, opts = {}) {
    if (!enabled || !(await allowed(channelId, actor))) return [];
    const dim = BREAKDOWN_DIMS.has(opts.dim) ? opts.dim : 'channel';
    const { rows } = await pool.query(
      `WITH b AS (${WINDOW_BOUNDS}),
       r AS (
         SELECT o.order_id, i.product_id, i.amount_kopecks, i.qty, i.unit_price_kopecks,
                ${WINDOW_CASE} AS win,
                CASE $8::text
                  WHEN 'status' THEN o.status
                  WHEN 'product' THEN i.product_id
                  WHEN 'carrier' THEN COALESCE(o.carrier, '')
                  ELSE COALESCE(o.channel, '')
                END AS key
         ${saleRows(9, 10)} AND ${REVENUE_FILTER}
       )
       SELECT r.key,
              p.title, p.article, p.sku,
              COALESCE(sum(r.amount_kopecks) FILTER (WHERE r.win = 1), 0) AS revenue_kopecks,
              count(DISTINCT r.order_id) FILTER (WHERE r.win = 1) AS orders,
              COALESCE(sum(r.qty) FILTER (WHERE r.win = 1), 0) AS items,
              COALESCE(sum(r.amount_kopecks) FILTER (WHERE r.win = 0), 0) AS prev_revenue_kopecks,
              count(DISTINCT r.order_id) FILTER (WHERE r.win = 0) AS prev_orders,
              -- Разброс ЦЕНЫ ЗА ШТУКУ. У 48 из 54 товаров склада она плавает (маркетплейсы режут
              -- скидку), и средняя по окну это скрывает: «2 400 ₽» одинаково выглядит и у товара с
              -- фиксированной ценой, и у товара, который продавался от 1 818 до 3 750.
              min(r.unit_price_kopecks) FILTER (WHERE r.win = 1) AS price_min_kopecks,
              max(r.unit_price_kopecks) FILTER (WHERE r.win = 1) AS price_max_kopecks,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY r.unit_price_kopecks)
                FILTER (WHERE r.win = 1) AS price_median_kopecks
         FROM r
         LEFT JOIN cdek_products p
           ON $8 = 'product' AND p.channel_id = $1 AND p.product_id = r.key
        WHERE r.win IS NOT NULL
        GROUP BY r.key, p.title, p.article, p.sku
        ORDER BY revenue_kopecks DESC, r.key
        LIMIT ${BREAKDOWN_MAX_GROUPS + 1}`,
      [...windowParams(channelId, opts), dim, normalizeCdekProducts(opts.products), opts.channels ?? null]);
    return rows;
  }

  /**
   * Покрытие по дням: выручка дня рядом с признаком «этот день вообще залит выгрузкой».
   * Различать обязательно — без него 61 день года без заказов читается как провал продаж, хотя
   * это дыра в загрузке.
   */
  async function getCdekCoverageForActor(channelId, actor, { from, to, tz = 'Europe/Moscow', include = 'revenue' } = {}) {
    if (!enabled || !from || !to || !(await allowed(channelId, actor))) return [];
    const { rows } = await pool.query(
      `WITH days AS (
         SELECT d::date AS day FROM generate_series($2::date, $3::date, interval '1 day') d
          LIMIT ${COVERAGE_MAX_DAYS}
       ),
       agg AS (
         SELECT (o.created_ts AT TIME ZONE $4)::date AS day,
                COALESCE(sum(i.amount_kopecks), 0) AS revenue_kopecks,
                count(DISTINCT o.order_id) AS orders
           FROM cdek_orders o
           JOIN cdek_order_items i ON i.channel_id = o.channel_id AND i.order_id = o.order_id
          WHERE o.channel_id = $1 AND o.kind = 'sale'
            AND (CASE $5::text
                   WHEN 'all' THEN true
                   WHEN 'completed' THEN o.status = 'complete'
                   ELSE o.status <> ALL(${NON_REVENUE_SQL})
                 END)
          GROUP BY 1
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE(agg.revenue_kopecks, 0) AS revenue_kopecks,
              COALESCE(agg.orders, 0) AS orders,
              EXISTS (SELECT 1 FROM cdek_imports im
                       WHERE im.channel_id = $1 AND im.status = 'done'
                         AND im.period_from IS NOT NULL
                         AND days.day BETWEEN im.period_from AND im.period_to) AS covered
         FROM days LEFT JOIN agg ON agg.day = days.day
        ORDER BY days.day`,
      [channelId, from, to, tz, INCLUDE_MODES.has(include) ? include : 'revenue']);
    return rows;
  }

  /**
   * Ритм заказов: день недели × час в зоне ИСТОЧНИКА. Считается по ЗАКАЗАМ, а не по строкам
   * выгрузки: многострочный заказ оформлен один раз и один раз должен попасть в клетку.
   */
  async function getCdekHourlyForActor(channelId, actor, opts = {}) {
    if (!enabled || !(await allowed(channelId, actor))) return [];
    const { rows } = await pool.query(
      `WITH b AS (${WINDOW_BOUNDS}),
       r AS (
         SELECT DISTINCT o.order_id,
                -- ISODOW: 1 = понедельник, как в шапке карты.
                EXTRACT(ISODOW FROM o.created_ts AT TIME ZONE $6)::int AS weekday,
                EXTRACT(HOUR FROM o.created_ts AT TIME ZONE $6)::int AS hour
           FROM cdek_orders o CROSS JOIN b
          WHERE o.channel_id = $1 AND o.kind = 'sale'
            AND ${REVENUE_FILTER}
            AND (b.cur_from IS NULL OR o.created_ts >= b.cur_from)
            AND (b.cur_to IS NULL OR o.created_ts < b.cur_to)
       )
       SELECT weekday, hour, count(*)::int AS orders FROM r GROUP BY weekday, hour`,
      windowParams(channelId, opts));
    return rows;
  }

  /**
   * Лента заказов окна с фильтрами и поиском. Поиск идёт по номеру заказа, внешнему номеру
   * маркетплейса и трек-номеру — именно их приносит человек, когда ищет конкретную посылку.
   * Пагинация keyset'ом не нужна: окно ограничено, а лимит держит ответ в разумных рамках.
   */
  async function getCdekOrdersForActor(channelId, actor, opts = {}) {
    if (!enabled || !(await allowed(channelId, actor))) return { rows: [], total: 0 };
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), ORDERS_MAX_ROWS);
    const status = typeof opts.status === 'string' && opts.status ? opts.status : null;
    const channel = typeof opts.channel === 'string' && opts.channel ? opts.channel : null;
    const q = typeof opts.q === 'string' && opts.q.trim() ? opts.q.trim().slice(0, 64) : null;
    const params = [...windowParams(channelId, opts), status, channel, q, limit];
    const { rows } = await pool.query(
      `WITH b AS (${WINDOW_BOUNDS}),
       o AS (
         SELECT o.*, ${WINDOW_CASE} AS win
           FROM cdek_orders o CROSS JOIN b
          WHERE o.channel_id = $1 AND o.kind = 'sale' AND ${REVENUE_FILTER}
            AND ($8::text IS NULL OR o.status = $8)
            AND ($9::text IS NULL OR COALESCE(o.channel, '') = $9)
            AND ($10::text IS NULL OR o.order_id ILIKE '%' || $10 || '%'
                 OR COALESCE(o.external_order_id, '') ILIKE '%' || $10 || '%'
                 OR COALESCE(o.track_number, '') ILIKE '%' || $10 || '%')
       ),
       w AS (SELECT * FROM o WHERE win = 1)
       SELECT w.order_id,
              to_char(w.created_ts AT TIME ZONE $6, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
              w.status, w.channel, w.carrier, w.external_order_id, w.track_number, w.comment,
              COALESCE(sum(i.amount_kopecks), 0) AS amount_kopecks,
              COALESCE(sum(i.qty), 0) AS items,
              count(i.*)::int AS positions,
              count(*) OVER ()::int AS total
         FROM w LEFT JOIN cdek_order_items i
           ON i.channel_id = $1 AND i.order_id = w.order_id
        GROUP BY w.order_id, w.created_ts, w.status, w.channel, w.carrier,
                 w.external_order_id, w.track_number, w.comment
        ORDER BY w.created_ts DESC
        LIMIT $11`,
      params);
    return { rows, total: rows[0] ? Number(rows[0].total) : 0 };
  }

  /**
   * Ряд ТЕКУЩЕГО окна, разложенный по измерению: одна серия на значение разреза.
   *
   * Предыдущее окно здесь не считается намеренно. Разбивка отвечает на вопрос «из чего сложилось»,
   * и вторая полупрозрачная копия каждой из шести серий превратила бы полотно в частокол — тот же
   * довод, по которому число серий ограничено сверху (см. MAX_BREAKDOWN_SERIES во фронте).
   *
   * Порядок — по убыванию выручки окна: серии режутся по лимиту читаемости, и отрезать надо хвост,
   * а не случайные разрезы. Пустые корзины не достраиваются, это работа фронта (как и у ряда).
   */
  async function getCdekSeriesBreakdownForActor(channelId, actor, opts = {}) {
    if (!enabled || !(await allowed(channelId, actor))) return { grain: 'day', groups: [] };
    const grain = ['day', 'week', 'month'].includes(opts.grain) ? opts.grain : 'day';
    const dim = BREAKDOWN_DIMS.has(opts.dim) ? opts.dim : 'channel';
    const { rows } = await pool.query(
      `WITH b AS (${WINDOW_BOUNDS}),
       r AS (
         SELECT o.order_id, i.product_id, i.amount_kopecks, i.qty, ${WINDOW_CASE} AS win,
                to_char(date_trunc($8, o.created_ts AT TIME ZONE $6), 'YYYY-MM-DD') AS day,
                CASE $9::text
                  WHEN 'status' THEN o.status
                  WHEN 'product' THEN i.product_id
                  WHEN 'carrier' THEN COALESCE(o.carrier, '')
                  ELSE COALESCE(o.channel, '')
                END AS key
         ${saleRows(10, 11)} AND ${REVENUE_FILTER}
       ),
       w AS (SELECT * FROM r WHERE win = 1),
       totals AS (
         SELECT key, sum(amount_kopecks) AS total FROM w GROUP BY key
       )
       SELECT w.key, w.day,
              COALESCE(sum(w.amount_kopecks), 0) AS revenue_kopecks,
              count(DISTINCT w.order_id) AS orders,
              COALESCE(sum(w.qty), 0) AS items,
              max(t.total) AS key_total
         FROM w JOIN totals t ON t.key = w.key
        GROUP BY w.key, w.day
        ORDER BY max(t.total) DESC, w.key, w.day`,
      [...windowParams(channelId, opts), grain, dim,
       normalizeCdekProducts(opts.products), opts.channels ?? null]);

    const byKey = new Map();
    for (const row of rows) {
      const key = row.key == null || row.key === '' ? null : row.key;
      const bucket = byKey.get(key) ?? { key, points: [] };
      bucket.points.push(row);
      byKey.set(key, bucket);
    }
    return { grain, dim, groups: [...byKey.values()] };
  }

  /** Границы архива: чем подписать «Всё» и от чего отсчитывать календарь покрытия. */
  async function getCdekBoundsForActor(channelId, actor) {
    if (!enabled || !(await allowed(channelId, actor))) return null;
    const { rows } = await pool.query(
      `SELECT to_char(min(o.created_ts AT TIME ZONE s.tz)::date, 'YYYY-MM-DD') AS first_day,
              to_char(max(o.created_ts AT TIME ZONE s.tz)::date, 'YYYY-MM-DD') AS last_day,
              count(*)::int AS orders
         FROM cdek_orders o JOIN cdek_sources s ON s.channel_id = o.channel_id
        WHERE o.channel_id = $1`,
      [channelId]);
    return rows[0] || null;
  }

  /** Код склада, чаще всего встречающийся в архиве — витринная подпись источника. */
  async function getCdekWarehouseFromOrders(channelId) {
    if (!enabled || !channelId) return null;
    const { rows } = await pool.query(
      `SELECT warehouse_code FROM cdek_orders
        WHERE channel_id = $1 AND warehouse_code IS NOT NULL
        GROUP BY warehouse_code ORDER BY count(*) DESC LIMIT 1`,
      [channelId]);
    return rows[0] ? rows[0].warehouse_code : null;
  }

  return {
    getCdekSource,
    saveCdekSource,
    setCdekWarehouse,
    findCdekImportByHash,
    startCdekImport,
    finishCdekImport,
    failCdekImport,
    listCdekImports,
    getCdekImport,
    getCdekImportFile,
    applyCdekImport,
    getCdekWarehouseFromOrders,
    getCdekSummaryForActor,
    getCdekSeriesForActor,
    getCdekSeriesBreakdownForActor,
    getCdekBreakdownForActor,
    getCdekCoverageForActor,
    getCdekBoundsForActor,
    getCdekHourlyForActor,
    getCdekOrdersForActor,
    CDEK_BREAKDOWN_MAX_GROUPS: BREAKDOWN_MAX_GROUPS,
    CDEK_COVERAGE_MAX_DAYS: COVERAGE_MAX_DAYS,
    CDEK_ORDERS_MAX_ROWS: ORDERS_MAX_ROWS,
  };
}

module.exports = {
  createCdekRepo,
  normalizeCdekInclude,
  normalizeCdekProducts,
  normalizeCdekChannels,
  ORDER_STATUSES,
  SALES_CHANNEL_KEYS,
  PRODUCT_FILTER_MAX,
};
