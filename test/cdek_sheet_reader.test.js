'use strict';

// Тесты собственного ридера .xlsx/.csv (server/lib/sheetReader). Ридер свой, потому что нам нужен
// ровно плоский лист без формул, а готовые пакеты тянут дерево зависимостей ради того, чего мы не
// используем. Плата за это — вот эти тесты: формат читается вручную, значит каждый его угол
// (shared strings, inline strings, разрежённые ячейки, серийные даты, кодировка CSV) должен быть
// закрыт явно. Фикстура собирается в тесте настоящим zip'ом — см. test/cdekFixtures.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { readSheetRows, readXlsxRows, readCsvRows, SheetReadError, serialToNaive } =
  require('../server/lib/sheetReader');
const { buildXlsx, buildZip } = require('./cdekFixtures');

test('xlsx: заголовки, shared strings, числа и имя листа', () => {
  const buf = buildXlsx([
    ['ID', 'Название', 'Цена'],
    [33896248, 'Мини-сумка — Серый', 3750],
    [33896262, 'Мини-сумка — Серый', 2929.5],
  ], { sheetName: 'Лист заказов' });

  const { rows, sheetName } = readSheetRows(buf, 'export.xlsx');
  assert.equal(sheetName, 'Лист заказов');
  assert.deepEqual(rows[0], ['ID', 'Название', 'Цена']);
  assert.deepEqual(rows[1], [33896248, 'Мини-сумка — Серый', 3750]);
  assert.equal(rows[2][2], 2929.5);
});

test('xlsx: пропущенная ячейка держит позицию колонки, а не сдвигает строку', () => {
  // В настоящей выгрузке пустые «Внешний ID»/«Трек-номер» вообще отсутствуют в XML. Если ридер
  // сдвинет остальные значения влево, вся дальнейшая разметка колонок поедет молча.
  const buf = buildXlsx([
    ['A', 'B', 'C', 'D'],
    [1, null, null, 'хвост'],
  ]);
  const { rows } = readSheetRows(buf, 'export.xlsx');
  assert.deepEqual(rows[1], [1, null, null, 'хвост']);
});

test('xlsx: пропущенные строки держат нумерацию, как в самом Excel', () => {
  // Excel не пишет пустые строки в XML, но помнит их номер в атрибуте r. Если ридер уплотнит
  // строки, номер отвергнутой строки в отчёте импорта перестанет совпадать с тем, что видит
  // пользователь в своём файле, — и по нему уже ничего не найти.
  const buf = buildXlsx([['ID'], [1], [], [], [4]]);
  const { rows } = readSheetRows(buf, 'export.xlsx');
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1], [1]);
  assert.deepEqual(rows[2], []);
  assert.deepEqual(rows[4], [4], 'пятая строка осталась пятой');
});

test('xlsx: inlineStr и кэшированный результат формулы читаются как текст', () => {
  const buf = buildXlsx([
    ['A', 'B'],
    [{ inline: 'встроенная строка' }, { formulaText: 'результат формулы' }],
  ]);
  const { rows } = readSheetRows(buf, 'export.xlsx');
  assert.deepEqual(rows[1], ['встроенная строка', 'результат формулы']);
});

test('xlsx: датовый стиль превращает серийное число в наивную строку', () => {
  // Выгрузка СДЭКа сегодня печатает дату текстом, но шаблон могут поменять на настоящие даты —
  // тогда без разбора стилей весь файл отвергся бы «неразборчивой датой».
  // 45869.65263888889 — ровно «2025-07-31 15:39:48», первая строка эталонной выгрузки.
  const buf = buildXlsx([['Создан'], [{ date: 45869.65263888889 }]]);
  const { rows } = readSheetRows(buf, 'export.xlsx');
  assert.equal(rows[1][0], '2025-07-31 15:39:48');
});

test('serialToNaive не выдумывает даты до фиктивного 29 февраля 1900', () => {
  assert.equal(serialToNaive(45870), '2025-08-01 00:00:00');
  assert.equal(serialToNaive(12), 12, 'ранние серийные числа возвращаются как есть');
});

test('xlsx: понятная ошибка вместо тишины на не-zip и на пустом файле', () => {
  assert.throws(() => readXlsxRows(Buffer.from('это не архив, а текст')), (e) => {
    assert.ok(e instanceof SheetReadError);
    assert.match(e.userMessage, /не \.xlsx/i);
    return true;
  });
  assert.throws(() => readXlsxRows(Buffer.alloc(0)), /повреждён или пуст/);
});

test('xlsx: zip-бомба обрывается на бюджете распаковки, а не съедает память', () => {
  const bomb = buildZip([
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(5 * 1024 * 1024, 0x20) },
  ]);
  assert.ok(bomb.length < 64 * 1024, 'фикстура сжимается в десятки килобайт');
  assert.throws(() => readXlsxRows(bomb, { maxInflatedBytes: 64 * 1024 }), /слишком большой/i);
});

test('xlsx: кап числа строк срабатывает до сборки всего листа', () => {
  const rows = [['ID']];
  for (let i = 0; i < 50; i++) rows.push([i]);
  const buf = buildXlsx(rows);
  assert.throws(() => readXlsxRows(buf, { maxRows: 10 }), /больше 10 строк/);
});

test('csv: utf-8 с BOM, запятая-разделитель и экранированные кавычки', () => {
  const text = '﻿ID,Название,Цена\r\n1,"Чехол, 14""",2850\r\n';
  const { rows } = readSheetRows(Buffer.from(text, 'utf8'), 'export.csv');
  assert.deepEqual(rows[0], ['ID', 'Название', 'Цена']);
  assert.deepEqual(rows[1], ['1', 'Чехол, 14"', '2850']);
});

test('csv: русский Excel — windows-1251 и точка с запятой', () => {
  // Без развилки по кодировке кириллица превратилась бы в кракозябры, заголовки не сошлись бы, и
  // пользователь увидел бы «нет обязательных колонок» вместо честного разбора.
  const text = 'ID;Статус;Комментарий\r\n1;complete;Корректировка остатков\r\n';
  const { rows } = readCsvRows(Buffer.from(cp1251Encode(text)));
  assert.deepEqual(rows[0], ['ID', 'Статус', 'Комментарий']);
  assert.equal(rows[1][2], 'Корректировка остатков');
});

test('csv: хвостовой перевод строки не превращается в пустую строку данных', () => {
  const { rows } = readCsvRows(Buffer.from('A;B\r\n1;2\r\n\r\n', 'utf8'));
  assert.equal(rows.length, 2);
});

test('файл без расширения распознаётся по zip-сигнатуре', () => {
  const buf = buildXlsx([['ID'], [1]]);
  assert.deepEqual(readSheetRows(buf, '').rows[0], ['ID']);
  assert.deepEqual(readSheetRows(Buffer.from('A;B\n1;2', 'utf8'), '').rows[0], ['A', 'B']);
});

test('старый .xls отвергается с подсказкой, а не молчаливым мусором', () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  assert.throws(() => readSheetRows(ole, 'старая.xls'), /пересохраните/i);
});

// windows-1251 кодировщик для фикстуры: обратное отображение того, что декодирует ридер.
function cp1251Encode(text) {
  const decoder = new TextDecoder('windows-1251');
  const map = new Map();
  for (let b = 0; b < 256; b++) map.set(decoder.decode(Uint8Array.from([b])), b);
  const out = [];
  for (const ch of text) {
    const b = map.get(ch);
    assert.notEqual(b, undefined, `символ ${JSON.stringify(ch)} не кодируется в windows-1251`);
    out.push(b);
  }
  return Uint8Array.from(out);
}

test('сжатие фикстуры действительно deflate, а не «хранение»', () => {
  // Страховка самого теста: если бы buildZip писал метод 0, тест zip-бомбы ничего не проверял бы.
  const buf = buildXlsx([['ID'], [1]]);
  const entryStart = buf.indexOf(Buffer.from('xl/workbook.xml')) - 30;
  assert.equal(buf.readUInt16LE(entryStart + 8), 8);
  assert.ok(zlib.inflateRawSync !== undefined);
});

// ── H-2: линейное время и жёсткие бюджеты ─────────────────────────────────────────────────────────
// Ленивые регулярки (/<row\b[^>]*>([\s\S]*?)<\/row>/) на каждом НЕЗАКРЫТОМ теге сканировали остаток
// файла и откатывались: замер аудита #554 — ×4 на удвоение входа, 906 КБ занимали единственную
// web-реплику на 9.9 с, и это было доступно любому пользователю через импорт своего канала.

/** Книга с произвольным XML листа — фикстуры buildXlsx умеют только корректный лист. */
function bookWithSheet(sheetXml) {
  const { buildZip } = require('./cdekFixtures');
  return buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>', 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]);
}

const unclosedSheet = (repeats) =>
  '<?xml version="1.0"?><worksheet><sheetData>'
  + '<row r="1"><c r="A1"><v>1</v>'.repeat(repeats)
  + '</sheetData></worksheet>';

test('xlsx: патологический лист с оборванными тегами отвергается за миллисекунды', () => {
  // 1 МБ повторов незакрытых <row>/<c>: до правки этот вход разбирался почти 10 секунд.
  const buf = bookWithSheet(unclosedSheet(36000));
  const t0 = performance.now();
  assert.throws(() => readXlsxRows(buf), (e) => {
    assert.ok(e instanceof SheetReadError);
    assert.match(e.userMessage, /повреждён/i);
    return true;
  });
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `разбор занял ${ms.toFixed(0)} мс — порог 500 мс (запас против флаков)`);
});

test('xlsx: время растёт линейно — удвоение входа не даёт ×4', () => {
  const measure = (repeats) => {
    const buf = bookWithSheet(unclosedSheet(repeats));
    const t0 = performance.now();
    try { readXlsxRows(buf); } catch { /* ожидаемо отвергается */ }
    return performance.now() - t0;
  };
  measure(4000);                                  // прогрев JIT
  const small = Math.max(measure(8000), 0.5);     // пол против нулевых замеров на быстрой машине
  const large = measure(16000);
  assert.ok(large / small < 2.5,
    `удвоение входа дало ×${(large / small).toFixed(2)} (${small.toFixed(1)} → ${large.toFixed(1)} мс), ожидалось < 2.5`);
});

test('xlsx: несходящиеся теги ловятся пре-сканом до всякого разбора', () => {
  // Лишний </row> без пары — файл повреждён, и это видно счётом, а не разбором.
  const buf = bookWithSheet('<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></row></sheetData></worksheet>');
  assert.throws(() => readXlsxRows(buf), /повреждён/i);
});

test('xlsx: `<row` не путается с `<rowBreaks` за пределами sheetData', () => {
  const buf = bookWithSheet(
    '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>'
    + '<rowBreaks count="1"><brk id="1"/></rowBreaks></worksheet>');
  assert.deepEqual(readXlsxRows(buf).rows[0], [7]);
});

test('xlsx: дедлайн разбора — последний рубеж даже для линейного пути', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [i, `строка ${i}`]);
  const buf = buildXlsx(rows);
  // Часы двигаются сами на каждый вызов: любой реальный лист гарантированно «просрочен».
  let ticks = 0;
  const now = () => { ticks += 10_000; return ticks; };
  assert.throws(() => readXlsxRows(buf, { deadlineMs: 1, now }), /слишком сложный/i);
  // С нормальными часами тот же файл читается целиком.
  assert.equal(readXlsxRows(buf).rows.length, 2000);
});

test('xlsx: отдельный потолок на лист — одна запись не выбирает бюджет архива', () => {
  const buf = buildXlsx([['ID'], [1]]);
  assert.throws(() => readXlsxRows(buf, { maxSheetBytes: 16 }), /слишком большой/i);
  assert.throws(() => readXlsxRows(buf, { maxSharedStringsBytes: 4 }), /слишком большой/i);
});

test('xlsx: ошибка распаковки приходит пользовательским текстом, а не текстом драйвера', () => {
  // Бьём хвост данных записи: inflate падает изнутри zlib.
  const buf = buildXlsx([['ID'], [1]]);
  const broken = Buffer.from(buf);
  for (let i = 40; i < Math.min(80, broken.length); i++) broken[i] = 0xff;
  assert.throws(() => readXlsxRows(broken), (e) => {
    assert.ok(e instanceof SheetReadError, 'сырой RangeError/zlib-ошибка не должна доезжать до cdek_imports.error');
    return true;
  });
});

test('xlsx: строковая таблица с оборванным <si> тоже отвергается, а не сканируется до конца', () => {
  const { buildZip } = require('./cdekFixtures');
  const buf = buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>', 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst>' + '<si><t>x</t>'.repeat(20000) + '</sst>', 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>', 'utf8') },
  ]);
  const t0 = performance.now();
  assert.throws(() => readXlsxRows(buf), /повреждён/i);
  assert.ok(performance.now() - t0 < 500);
});
