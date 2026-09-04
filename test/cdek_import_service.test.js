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
  const calls = { applied: [], finished: [], failed: [], started: [], warehouse: [], pruned: [] };
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
    finishCdekImport: async (channelId, id, payload, opts) => {
      calls.finished.push({ channelId, id, payload, opts });
      return { id, ...payload.stats, warnings: payload.warnings };
    },
    failCdekImport: async (channelId, id, message) => { calls.failed.push({ channelId, id, message }); return true; },
    pruneCdekImportFiles: async (channelId, opts) => { calls.pruned.push({ channelId, opts }); return 0; },
    getCdekImportFile: async () => ({ filename: 'сохранённый.xlsx', file_bytes: FILE }),
    ...overrides,
  };
  return db;
}

const build = (db, extra = {}) => createCdekImportService({ db, readSheetRows, parseCdekSheet, ...extra });

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

// ── Окно хранения сырых исходников (M-1, аудит #554) ───────────────────────────────────────────
// Файл кладётся в Postgres целиком и до этого не удалялся ничем: ни квоты, ни ретеншна. При
// потолке загрузки 2 МБ и лимитере 10 импортов в час это 480 МБ в сутки на канал — и рост не
// останавливался никогда. Уборка идёт СРАЗУ после успешной записи и только после неё.

test('успешный импорт закрывает окно хранения исходников того же канала', async () => {
  const db = fakeDb();
  await build(db).importFile({ channelId: 5, uid: 3, filename: 'выгрузка.xlsx', buffer: FILE });

  assert.deepEqual(db.calls.pruned, [{ channelId: 5, opts: undefined }],
    'уборка скоупится каналом импорта, потолок берётся из репо');
  const prunedAfterFinish = db.calls.finished.length === 1 && db.calls.pruned.length === 1;
  assert.ok(prunedAfterFinish, 'уборка идёт ПОСЛЕ записи отчёта, а не вместо неё');
});

test('дубль и упавший импорт окно хранения не двигают', async () => {
  const dup = fakeDb({ findCdekImportByHash: async () => ({ id: 1, status: 'done' }) });
  await build(dup).importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE });
  assert.deepEqual(dup.calls.pruned, [], 'повторная загрузка ничего не добавила — убирать нечего');

  const broken = fakeDb();
  await assert.rejects(() => build(broken).importFile({
    channelId: 5, filename: 'мусор.xlsx', buffer: Buffer.from('это обычный текст, а не выгрузка склада'),
  }));
  assert.deepEqual(broken.calls.pruned, [], 'у упавшего импорта file_bytes уже обнулил failCdekImport');
});

test('сбой уборки не отменяет уже записанный импорт', async () => {
  // Архив записан, отчёт сохранён — падать из-за служебной уборки было бы враньём пользователю.
  const logs = [];
  const db = fakeDb({ pruneCdekImportFiles: async () => { throw new Error('deadlock detected'); } });
  const result = await build(db, { log: (level, event, meta) => logs.push({ level, event, meta }) })
    .importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE });

  assert.equal(result.duplicate, false);
  assert.equal(db.calls.finished.length, 1);
  assert.ok(logs.some((l) => l.event === 'cdek_import_prune_failed'), 'сбой уборки не проглочен молча');
});

// ── Внутренности не попадают в витрину импортов (I-2, аудит #554) ──────────────────────────────
// `cdek_imports.error` читает пользователь. Прежний `e.userMessage || e.message` означал, что
// неожиданное исключение сохраняло туда текст драйвера — и он же уезжал в ответ роута.

test('неожиданное исключение пишет в строку импорта человеческую причину, а не текст драйвера', async () => {
  const logs = [];
  const db = fakeDb({ applyCdekImport: async () => { throw new RangeError('Invalid code point 9999999'); } });
  await assert.rejects(() => build(db, { log: (level, event, meta) => logs.push({ level, event, meta }) })
    .importFile({ channelId: 5, filename: 'выгрузка.xlsx', buffer: FILE }));

  const stored = db.calls.failed[0].message;
  assert.doesNotMatch(stored, /Invalid code point/);
  assert.match(stored, /Импорт не удался/);
  // Настоящая причина не потеряна — она в логе.
  const failure = logs.find((l) => l.event === 'cdek_import_failed');
  assert.match(failure.meta.error, /Invalid code point 9999999/);
});

test('ошибка разбора по-прежнему доносит до пользователя СВОЮ причину, а не общую', async () => {
  // Общая фраза — только для непредусмотренного. Там, где ридер знает, что не так, он говорит это.
  const db = fakeDb();
  await assert.rejects(
    () => build(db).importFile({
      channelId: 5, filename: 'мусор.xlsx', buffer: Buffer.from('это обычный текст, а не выгрузка склада'),
    }),
    (e) => {
      assert.match(e.userMessage, /не \.xlsx/i);
      return true;
    },
  );
  assert.match(db.calls.failed[0].message, /не \.xlsx/i);
});

test('файл с непредусмотренным содержимым: пользователь видит «не разобрался», а не пятисотку', async () => {
  // Полный путь с НАСТОЯЩИМ ридером: ссылка за пределами Unicode раньше давала RangeError,
  // а теперь либо разбирается, либо честно отвергается — но не текстом драйвера.
  const db = fakeDb();
  const { buildZip } = require('./cdekFixtures');
  const buf = buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>', 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#9999999;</t></is></c></row></sheetData></worksheet>', 'utf8'),
    },
  ]);
  await assert.rejects(
    () => build(db).importFile({ channelId: 5, filename: 'странный.xlsx', buffer: buf }),
    (e) => {
      assert.ok(e.userMessage, 'наружу идёт сообщение для пользователя, а не голое исключение');
      assert.doesNotMatch(String(e.message), /code point/i);
      return true;
    },
  );
  assert.doesNotMatch(db.calls.failed[0].message, /code point/i);
});
