'use strict';

/* ── СДЭК Fulfillment: источник, импорты и архив заказов (миграция 038) ─────────────────────────
   Первый источник без API: наполняется ручной загрузкой Excel, поэтому здесь нет ни токена, ни
   крона — только приём файла и идемпотентная запись его содержимого.

   Идентичность источника — ПЕР-КАНАЛЬНАЯ (`ch:<channel_id>` в external_sources), а не код склада.
   Строка external_sources общая для всех воркспейсов: канонизируй мы склад по его коду, две
   независимые компании с одинаковым кодом склада схлопнулись бы в один источник — для публичного
   TG-канала это ровно то, что нужно, а для приватной выгрузки фулфилмента это утечка между
   тенантами. Код склада поэтому хранится атрибутом (и расхождение с файлом попадает в
   предупреждения импорта), но идентичности не задаёт.

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

function createCdekRepo({ pool, enabled, transaction, ensureExternalSource }) {
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
  async function finishCdekImport(id, { stats, rejected = [], warnings = [], counts = {} }, { replay = false } = {}) {
    if (!enabled || !id) return null;
    try {
      const { rows } = await pool.query(
        `UPDATE cdek_imports SET status = 'done', finished_at = now(), error = NULL,
                rows_total = $2, rows_inserted = $3, rows_updated = $4, rows_rejected = $5,
                rows_deleted = $6, orders_total = $7, period_from = $8, period_to = $9,
                rejected = $10::jsonb, warnings = $11::jsonb
          WHERE id = $1 AND (status = 'pending' OR $12) RETURNING ${IMPORT_COLS}`,
        [id, stats.rows_total, counts.inserted || 0, counts.updated || 0, stats.rows_rejected,
          counts.deleted || 0, stats.orders_total, stats.period_from, stats.period_to,
          JSON.stringify(rejected), JSON.stringify(warnings), replay]);
      return rows[0] || null;
    } catch (e) {
      if (e && e.code === '23505') {
        await pool.query('DELETE FROM cdek_imports WHERE id = $1 AND status = $2', [id, 'pending']);
        return { duplicate: true };
      }
      throw e;
    }
  }

  async function failCdekImport(id, message) {
    if (!enabled || !id) return false;
    // Сырой файл упавшего импорта не нужен: переигрывать нечего, а место он занимает.
    const { rowCount } = await pool.query(
      `UPDATE cdek_imports SET status = 'error', error = $2, finished_at = now(), file_bytes = NULL
        WHERE id = $1 AND status = 'pending'`,
      [id, String(message || 'ошибка импорта').slice(0, 500)]);
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
  };
}

module.exports = { createCdekRepo };
