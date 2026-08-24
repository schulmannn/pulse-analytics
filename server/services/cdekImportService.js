'use strict';

const crypto = require('crypto');

/**
 * Импорт выгрузки СДЭК Fulfillment: файл → строки листа → заказы → база → отчёт.
 *
 * Сервис, а не repo: он пересекает три слоя (чтение файла, разбор домена, запись архива) и
 * владеет протоколом отчёта, который видит пользователь. Отчёт — не тост, а первоклассный
 * результат: у источника с ручной загрузкой это единственное место, где видно, что именно
 * попало в базу и что было отвергнуто.
 *
 * Идемпотентность двухуровневая: тот же файл (sha256) — no-op со ссылкой на прежний импорт;
 * пересекающиеся по периоду разные файлы — upsert по номеру заказа, где заказ ПЕРЕЗАПИСЫВАЕТСЯ
 * целиком. Перевыгрузка с нахлёстом — нормальный рабочий режим, а не ошибка пользователя.
 */

// В строке импорта храним усечённый список отвергнутого: он для отчёта, а не для восстановления
// данных — исходник целиком лежит рядом в file_bytes.
const MAX_REJECTED_STORED = 200;

function createCdekImportService({ db, readSheetRows, parseCdekSheet, log = () => {}, maxRows = 100000 }) {
  const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

  /** Код склада, преобладающий в файле: подпись источника и повод предупредить о подмене. */
  function dominantWarehouse(orders) {
    const counts = new Map();
    for (const order of orders) {
      if (!order.warehouse_code) continue;
      counts.set(order.warehouse_code, (counts.get(order.warehouse_code) || 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [code, count] of counts) if (count > bestCount) { best = code; bestCount = count; }
    return best;
  }

  /** Разбор + запись + отчёт. Общая часть загрузки нового файла и переигровки сохранённого. */
  async function ingest({ channelId, importId, filename, buffer, tz, replay }) {
    const { rows } = readSheetRows(buffer, filename, { maxRows });
    const parsed = parseCdekSheet(rows);
    const warnings = [...parsed.warnings];

    const source = await db.getCdekSource(channelId);
    const warehouse = dominantWarehouse(parsed.orders);
    if (warehouse && source && source.warehouse_code && source.warehouse_code !== warehouse) {
      // Не блокируем: пользователь мог осознанно объединить склады. Но и молчать нельзя —
      // иначе чужая выгрузка бесшумно подмешается в архив этого источника.
      warnings.unshift(`В файле склад ${warehouse}, а источник заведён на склад ${source.warehouse_code}`);
    }

    const counts = await db.applyCdekImport({
      channelId,
      importId,
      tz: (source && source.tz) || tz || 'Europe/Moscow',
      orders: parsed.orders,
      products: parsed.products,
    });
    if (warehouse) await db.setCdekWarehouse(channelId, warehouse);
    if (counts.deleted) warnings.push(`Удалено позиций, исчезнувших из заказов: ${counts.deleted}`);
    if (parsed.rejected_truncated) warnings.push('Список отвергнутых строк усечён — показаны первые');

    const saved = await db.finishCdekImport(channelId, importId, {
      stats: parsed.stats,
      rejected: parsed.rejected.slice(0, MAX_REJECTED_STORED),
      warnings,
      counts,
    }, { replay });
    return { saved, parsed, counts };
  }

  /**
   * Загрузка нового файла. Возвращает `{ duplicate, import }` — маршрут решает, каким статусом
   * это подать. Ошибка разбора помечает импорт упавшим и поднимается наверх с userMessage:
   * «файл не тот» — это сообщение пользователю, а не пятисотка.
   */
  async function importFile({ channelId, uid = null, filename, buffer, tz }) {
    if (!db.enabled) throw Object.assign(new Error('База данных недоступна'), { status: 503 });
    const hash = sha256(buffer);
    const already = await db.findCdekImportByHash(channelId, hash);
    if (already) return { duplicate: true, import: already };

    const importId = await db.startCdekImport({
      channel_id: channelId,
      uploaded_by: uid,
      filename,
      file_sha256: hash,
      file_bytes: buffer,
    });
    if (!importId) throw Object.assign(new Error('Не удалось начать импорт'), { status: 503 });

    try {
      const { saved, parsed } = await ingest({ channelId, importId, filename, buffer, tz, replay: false });
      // Гонка двух одинаковых файлов: параллельная загрузка финишировала первой.
      if (saved && saved.duplicate) {
        const winner = await db.findCdekImportByHash(channelId, hash);
        return { duplicate: true, import: winner };
      }
      log('info', 'cdek_import_done', {
        channelId, importId, rows: parsed.stats.rows_total, orders: parsed.stats.orders_total,
        rejected: parsed.stats.rows_rejected,
      });
      return { duplicate: false, import: saved };
    } catch (e) {
      await db.failCdekImport(channelId, importId, e.userMessage || e.message).catch(() => {});
      log('warn', 'cdek_import_failed', { channelId, importId, error: e && e.message });
      throw e;
    }
  }

  /**
   * Переигровка сохранённого файла — тем же кодом, что и первичная загрузка, но в ту же строку
   * импорта. Нужна ровно потому, что правила классификации строк («это складское движение, а не
   * продажа») живут в коде: когда они уточняются, архив пересобирается из исходника, а не
   * запрашивается у пользователя заново.
   */
  async function replayImport({ channelId, importId, tz }) {
    if (!db.enabled) throw Object.assign(new Error('База данных недоступна'), { status: 503 });
    const file = await db.getCdekImportFile(channelId, importId);
    if (!file) throw Object.assign(new Error('Исходный файл этого импорта не сохранён'), { status: 404 });
    const { saved } = await ingest({
      channelId, importId, filename: file.filename, buffer: file.file_bytes, tz, replay: true,
    });
    log('info', 'cdek_import_replayed', { channelId, importId });
    return { import: saved };
  }

  return { importFile, replayImport, sha256 };
}

module.exports = { createCdekImportService };
