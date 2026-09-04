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

test('xlsx: вход вдвое больше разбирается за абсолютный потолок, а не за секунды', () => {
  /* Здесь СОЗНАТЕЛЬНО абсолютный потолок, а не отношение двух замеров.
     Первая версия сравнивала время на 8000 и 16000 повторов и требовала рост меньше ×2.5 — на
     общем CI-раннере оба замера субмиллисекундные, и шум планировщика легко даёт ×3 при
     совершенно линейном коде. Тест краснел на чужом PR, ничего не сообщая о самом коде.
     Разница между линейным и квадратичным разбором здесь не в разах, а в порядках: 1.8 МБ
     патологического входа старый ридер съедал бы десятки секунд (замер на 906 КБ — 9.9 с,
     ×4 на каждое удвоение), новый укладывается в единицы миллисекунд. Потолок в 1 с оставляет
     линейному коду двухсоткратный запас и всё равно недостижим для квадратичного. */
  const buf = bookWithSheet(unclosedSheet(64000));   // ~1.8 МБ XML
  const t0 = performance.now();
  assert.throws(() => readXlsxRows(buf), /повреждён/i);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `разбор 1.8 МБ занял ${ms.toFixed(0)} мс — потолок 1000 мс (квадратичный код здесь берёт десятки секунд)`);
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

// ── Наружу ридер отдаёт либо строки, либо SheetReadError (I-2, аудит #554) ─────────────────────
// Разбор чужого файла — разбор недоверенного ввода: полный список его отказов не перечислим, и на
// каждый предусмотренный случай найдётся непредусмотренный. Раньше такой случай означал пятисотку
// и текст драйвера в `cdek_imports.error`, который пользователь читает в витрине импортов.

/** Лист с ОДНОЙ inline-ячейкой заданного текста — без экранирования фикстурой. */
function xlsxWithRawCell(inner) {
  return buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>', 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${inner}</t></is></c></row></sheetData></worksheet>`,
        'utf8',
      ),
    },
  ]);
}

test('xlsx: числовая ссылка за пределами Unicode не роняет разбор RangeError-ом', () => {
  // `&#9999999;` — валидный синтаксис XML-ссылки, но такого кодпоинта не существует, и
  // String.fromCodePoint на нём бросает «Invalid code point 9999999». Эта строка доезжала до
  // пользователя. Неразбираемая ссылка остаётся собой — как неизвестная именованная сущность.
  const { rows } = readSheetRows(xlsxWithRawCell('&#9999999;'), 'export.xlsx');
  assert.deepEqual(rows[0], ['&#9999999;']);
});

test('xlsx: обычные ссылки по-прежнему декодируются (граница не съела рабочий случай)', () => {
  const { rows } = readSheetRows(xlsxWithRawCell('&#1055;&#x440;&amp;&#65;'), 'export.xlsx');
  assert.deepEqual(rows[0], ['Пр&A']);
});

test('readSheetRows не выпускает наружу чужое исключение — только SheetReadError с userMessage', () => {
  // Моделируем «непредусмотренный случай» изнутри разбора: подменённый Buffer.prototype бросает
  // не-SheetReadError оттуда, где ридер этого не ждёт. Наружу обязан выйти пользовательский текст,
  // а исходная ошибка — уехать в cause, чтобы вызывающий записал её в лог.
  const buf = buildXlsx([['ID'], [1]]);
  const original = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUInt32LE = function patched(offset) {
    if (offset === 0) throw new TypeError('внутренности драйвера: patched readUInt32LE');
    return original.call(this, offset);
  };
  try {
    assert.throws(() => readSheetRows(buf, 'export.xlsx'), (e) => {
      assert.ok(e instanceof SheetReadError);
      assert.match(e.userMessage, /не разобрал/i);
      assert.doesNotMatch(e.message, /patched readUInt32LE/);
      assert.equal(e.cause instanceof TypeError, true, 'исходная ошибка не потеряна — она в cause');
      assert.match(e.cause.message, /patched readUInt32LE/);
      return true;
    });
  } finally {
    Buffer.prototype.readUInt32LE = original;
  }
});
