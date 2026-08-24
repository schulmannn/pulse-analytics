'use strict';

// Тесты сервиса импорта СДЭК (server/services/cdekImportService): протокол загрузки поверх
// настоящего ридера и настоящего разбора, но с фейковой БД. Проверяется то, чего нет ни в ридере,
// ни в домене: повторная загрузка того же файла, отчёт, судьба упавшего импорта, переигровка и
// гонка двух одинаковых файлов.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCdekImportService } = require('../server/services/cdekImportService');
const { readSheetRows } = require('../server/lib/sheetReader');
const { parseCdekSheet } = require('../server/domain/cdekImport');
const { buildXlsx, CDEK_HEADER, cdekRow } = require('./cdekFixtures');

const FILE = buildXlsx([
  CDEK_HEADER,
  cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p1', price: 2850 }),
  cdekRow({ id: 1, created: '2026-01-10 10:00:00', productId: 'p2', price: 3750 }),
  cdekRow({ id: 2, created: '2026-01-11 12:00:00', productId: 'p1', price: 2850, warehouse: '19821' }),
]);

function fakeDb(overrides = {}) {
  const calls = { applied: [], finished: [], failed: [], started: [], warehouse: [] };
  const db = {
    enabled: true,
    calls,
    findCdekImportByHash: async () => null,
    getCdekSource: async () => ({ channel_id: 5, warehouse_code: null, tz: 'Europe/Moscow' }),
    startCdekImport: async (row) => { calls.started.push(row); return 77; },
    applyCdekImport: async (args) => {
      calls.applied.push(args);
      return { inserted: args.orders.reduce((n, o) => n + o.items.length, 0), updated: 0, deleted: 0 };
    },
    setCdekWarehouse: async (channelId, code) => { calls.warehouse.push(code); return true; },
    finishCdekImport: async (id, payload, opts) => {
      calls.finished.push({ id, payload, opts });
      return { id, ...payload.stats, warnings: payload.warnings };
    },
    failCdekImport: async (id, message) => { calls.failed.push({ id, message }); return true; },
    getCdekImportFile: async () => ({ filename: 'сохранённый.xlsx', file_bytes: FILE }),
    ...overrides,
  };
  return db;
}

const build = (db) => createCdekImportService({ db, readSheetRows, parseCdekSheet });

test('загрузка: файл разобран, архив записан, отчёт собран', async () => {
  const db = fakeDb();
  const result = await build(db).importFile({ channelId: 5, uid: 3, filename: 'выгрузка.xlsx', buffer: FILE });

  assert.equal(result.duplicate, false);
  assert.equal(db.calls.applied.length, 1);
  assert.equal(db.calls.applied[0].orders.length, 2, 'три строки — два заказа');
  assert.equal(db.calls.applied[0].tz, 'Europe/Moscow');
  const finished = db.calls.finished[0];
  assert.equal(finished.payload.stats.rows_total, 3);
  assert.equal(finished.payload.counts.inserted, 3);
  assert.equal(finished.opts.replay, false);
  assert.deepEqual(db.calls.warehouse, ['19821'], 'код склада берётся из файла');
});

test('сырой файл сохраняется вместе со своим sha256 — иначе переигрывать будет нечего', async () => {
  const db = fakeDb();
  await build(db).importFile({ channelId: 5, uid: 3, filename: 'выгрузка.xlsx', buffer: FILE });
  const started = db.calls.started[0];
  assert.ok(Buffer.isBuffer(started.file_bytes));
  assert.match(started.file_sha256, /^[0-9a-f]{64}$/);
  assert.equal(started.uploaded_by, 3);
});

test('тот же файл повторно — no-op со ссылкой на прежний импорт', async () => {
  const previous = { id: 42, rows_total: 3, created_at: '2026-01-12T09:00:00' };
  const db = fakeDb({ findCdekImportByHash: async () => previous });
  const result = await build(db).importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE });

  assert.equal(result.duplicate, true);
  assert.equal(result.import, previous);
  assert.equal(db.calls.started.length, 0, 'вторая строка импорта не заводится');
  assert.equal(db.calls.applied.length, 0, 'и запись не повторяется');
});

test('гонка двух одинаковых файлов: победил параллельный импорт — отдаём его отчёт', async () => {
  let seen = 0;
  const winner = { id: 41 };
  const db = fakeDb({
    // Первый вызов (перед стартом) — пусто, второй (после 23505 на финише) — победитель.
    findCdekImportByHash: async () => (seen++ === 0 ? null : winner),
    finishCdekImport: async () => ({ duplicate: true }),
  });
  const result = await build(db).importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE });
  assert.equal(result.duplicate, true);
  assert.equal(result.import, winner);
});

test('нечитаемый файл: импорт помечен упавшим, наверх идёт сообщение для пользователя', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => build(db).importFile({
      channelId: 5,
      filename: 'мусор.xlsx',
      buffer: Buffer.from('это обычный текст, переименованный в .xlsx, и он заметно длиннее пустого'),
    }),
    (e) => {
      assert.match(e.userMessage, /не \.xlsx/i);
      return true;
    },
  );
  assert.equal(db.calls.failed.length, 1);
  assert.equal(db.calls.failed[0].id, 77);
  assert.equal(db.calls.finished.length, 0);
});

test('чужая выгрузка в источник другого склада — предупреждение, но не блокировка', async () => {
  // Блокировать нельзя: склады объединяют осознанно. Молчать тоже нельзя — чужие заказы
  // бесшумно подмешались бы в архив.
  const db = fakeDb({
    getCdekSource: async () => ({ channel_id: 5, warehouse_code: '11111', tz: 'Asia/Yekaterinburg' }),
  });
  await build(db).importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE });
  const { warnings } = db.calls.finished[0].payload;
  assert.match(warnings[0], /в файле склад 19821.*источник заведён на склад 11111/i);
  assert.equal(db.calls.applied[0].tz, 'Asia/Yekaterinburg', 'зона берётся у источника, а не у вызова');
});

test('исчезнувшие позиции попадают в предупреждения отчёта', async () => {
  const db = fakeDb({
    applyCdekImport: async () => ({ inserted: 1, updated: 2, deleted: 3 }),
  });
  await build(db).importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE });
  const { warnings, counts } = db.calls.finished[0].payload;
  assert.equal(counts.deleted, 3);
  assert.ok(warnings.some((w) => /исчезнувших из заказов: 3/.test(w)));
});

test('переигровка идёт из сохранённого файла в ту же строку импорта', async () => {
  const db = fakeDb();
  await build(db).replayImport({ channelId: 5, importId: 77 });
  assert.equal(db.calls.applied.length, 1);
  assert.equal(db.calls.finished[0].id, 77);
  assert.equal(db.calls.finished[0].opts.replay, true);
  assert.equal(db.calls.started.length, 0, 'новая строка импорта не заводится');
});

test('переигровка упавшего импорта невозможна — файла у него нет', async () => {
  const db = fakeDb({ getCdekImportFile: async () => null });
  await assert.rejects(
    () => build(db).replayImport({ channelId: 5, importId: 77 }),
    (e) => {
      assert.equal(e.status, 404);
      assert.match(e.message, /не сохранён/);
      return true;
    },
  );
});

test('без базы импорт честно отказывает до чтения файла', async () => {
  const db = fakeDb({ enabled: false });
  await assert.rejects(
    () => build(db).importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE }),
    (e) => {
      assert.equal(e.status, 503);
      return true;
    },
  );
});
