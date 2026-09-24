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

test('xlsx: дедлайн проверяется по РАЗОБРАННЫМ строкам, а не по длине массива', () => {
  // Проверка дедлайна брала `rows.length`, а она растёт НЕ на единицу: Excel не пишет пустые
  // строки, но помнит их номера, и массив прыгает через пропуски, чтобы индекс совпадал с номером
  // строки в файле (см. `while (rows.length < target)`). Кратности 500 длина при этом может не
  // наступить ни разу — рубеж молчит на сколь угодно долгом разборе (аудит #554, проход №2, N16).
  //
  // Тест меряет ЧАСТОТУ проверок, а не факт броска, и вот почему. При РАВНОМЕРНОМ шаге номеров
  // старый и новый код эквивалентны: длина 500·s наступает ровно на 500-й строке, то есть оба
  // проверяют в один и тот же момент. Разойтись они могут только на НЕРАВНОМЕРНЫХ пропусках —
  // а такие и бывают в реальных выгрузках, где удалены куски строк.
  //
  // Лист: четыре плотных блока по 499 строк с разрывами между ними. Наблюдаемые на проверке длины
  // — 0…498, 1001…1498, 2001…2498, 3001…3498: НИ ОДНОЙ кратности 500, кроме нулевой, потому что
  // 500, 1000, 1500 … попадают внутрь разрывов и проскакиваются циклом дозаполнения.
  //   старый код: 1 проверка (нулевая) → два вызова часов вместе с установкой `until`;
  //   новый код:  3 проверки (500-я, 1000-я, 1500-я строки) → четыре вызова.
  const parts = [];
  for (const base of [0, 1000, 2000, 3000]) {
    for (let i = 1; i <= 499; i += 1) {
      const r = base + i;
      parts.push(`<row r="${r}"><c r="A${r}"><v>${i}</v></c></row>`);
    }
  }
  const buf = bookWithSheet(`<?xml version="1.0"?><worksheet><sheetData>${parts.join('')}</sheetData></worksheet>`);
  let calls = 0;
  // Часы никогда не истекают: предмет проверки — сколько раз о них спросили.
  const now = () => { calls += 1; return 0; };
  const { rows } = readXlsxRows(buf, { deadlineMs: 1_000_000, now });
  assert.equal(rows.filter((r) => r.length > 0).length, 1996, 'все строки разобраны');
  assert.ok(calls >= 4, `дедлайн обязан проверяться по мере работы, а не один раз (вызовов часов: ${calls})`);
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

// ── Служебные части книги и ширина листа (CDEKRS-1, CDEKRS-2) ────────────────────────────────────
// Линейный разбор H-2 закрыл только тело листа. До него книга читала workbook.xml, rels и styles.xml
// регулярками с `[^>]*`: rels из 2000 оборванных `<Relationship` (zip 684 Б) занимал единственную
// web-реплику на 26–80 с. Отдельно индекс колонки из `r="…"` не имел потолка: `r="AAAAAA1"` добивал
// строку null-ами до 12 млн элементов, и двадцать таких строк роняли процесс фатальным OOM.

const PLAIN_WORKBOOK = '<workbook xmlns:r="r"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>';
const PLAIN_RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
const ONE_CELL_SHEET = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>';

/** Книга из произвольных частей: по умолчанию корректная, с одной ячейкой «x» в A1. */
function bookWithParts({ workbook = PLAIN_WORKBOOK, rels = PLAIN_RELS, styles, shared, sheet = ONE_CELL_SHEET, extra = [] }) {
  const files = [
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels, 'utf8') },
  ];
  if (styles !== undefined) files.push({ name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') });
  if (shared !== undefined) files.push({ name: 'xl/sharedStrings.xml', data: Buffer.from(shared, 'utf8') });
  files.push({ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') });
  for (const { name, xml } of extra) files.push({ name, data: Buffer.from(xml, 'utf8') });
  return buildZip(files);
}

// Размеры подобраны так, что старый ридер тратил на каждый файл секунды (замер до правки — в
// скобках), а файл остаётся в пару килобайт. Новый — единицы миллисекунд; потолок в 1 с — запас
// против шумного раннера, недостижимый для квадратичного и кубического разбора.
const PATHOLOGICAL_BOOKS = [
  ['rels: 1500 оборванных <Relationship> (кубически, ~10 с)',
    { rels: `<Relationships>${'<Relationship Id="rId1" '.repeat(1500)}` }],
  ['workbook: 40 000 оборванных <sheet> (~4 с)',
    { workbook: `<workbook>${'<sheet '.repeat(40000)}` }],
  ['styles: <numFmt> из 32 000 numFmtId без formatCode (~5 с)',
    { styles: `<styleSheet><numFmts><numFmt ${'numFmtId="1" '.repeat(32000)}` }],
  ['styles: 80 000 незакрытых <cellXfs> (~4 с)',
    { styles: `<styleSheet>${'<cellXfs '.repeat(80000)}` }],
  // По 32 000 «[» — под потолком длины значения (32 767 символов): formatCode длиннее теперь
  // отвергается сразу (тест ниже), а квадратичный вырез скобок стоил ~0.37 с на КАЖДЫЙ такой формат.
  ['styles: 25 formatCode по 32 000 «[» без «]» (~9 с)',
    { styles: `<styleSheet><numFmts>${`<numFmt numFmtId="164" formatCode="${'['.repeat(32000)}"/>`.repeat(25)}</numFmts></styleSheet>` }],
];

for (const [label, parts] of PATHOLOGICAL_BOOKS) {
  test(`xlsx: ${label} — разбор за миллисекунды, книга читается`, () => {
    const buf = bookWithParts(parts);
    assert.ok(buf.length < 8 * 1024, `фикстура — килобайты, а не мегабайты (${buf.length} Б)`);
    const t0 = performance.now();
    const { rows } = readSheetRows(buf, 'export.xlsx');
    const ms = performance.now() - t0;
    // Оборванный служебный тег не делает книгу нечитаемой: как и раньше, лист находится фолбэком.
    assert.deepEqual(rows[0], ['x']);
    assert.ok(ms < 1000, `разбор занял ${ms.toFixed(0)} мс — потолок 1000 мс`);
  });
}

test('xlsx: rels с несколькими связями и `>` в значении атрибута читаются как раньше', () => {
  // Сохранение поведения, а не регрессия: лист берётся по r:id из rels, даже когда его связь не
  // первая и рядом лежит sheet1.xml (фолбэк выбрал бы его). `>` в formatCode законен в XML —
  // граница тега ищется по '<', и датовый формат с условием не теряется.
  const buf = bookWithParts({
    workbook: '<workbook xmlns:r="r"><workbookPr/><bookViews><workbookView/></bookViews>'
      + '<sheets><sheet name="Заказы" sheetId="2" r:id="rId3"/></sheets></workbook>',
    rels: '<Relationships>'
      + '<Relationship Id="rId1" Type="theme" Target="theme/theme1.xml"/>'
      + '<Relationship Id="rId2" Type="styles" Target="styles.xml"/>'
      + '<Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet2.xml"/>'
      + '</Relationships>',
    styles: '<styleSheet><numFmts count="1"><numFmt numFmtId="165" formatCode="[>=0]yyyy-mm-dd hh:mm:ss"/></numFmts>'
      + '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="165" applyNumberFormat="1"><alignment/></xf></cellXfs></styleSheet>',
    extra: [{
      name: 'xl/worksheets/sheet2.xml',
      xml: '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>45869.65263888889</v></c></row></sheetData></worksheet>',
    }],
  });
  const { rows, sheetName } = readSheetRows(buf, 'export.xlsx');
  assert.equal(sheetName, 'Заказы');
  assert.deepEqual(rows[0], ['2025-07-31 15:39:48']);
});

test('xlsx: дедлайн покрывает всю книгу — rels, строковую таблицу и стили, а не только строки листа', () => {
  // Лист — одна строка: до правки часы заводились только в цикле строк листа, и на книге, где вся
  // работа приходится на служебные части, рубеж не срабатывал ни разу.
  const n = 600;   // больше шага проверки часов (500) — проверка обязана случиться
  const cases = [
    ['rels', { rels: `<Relationships>${'<Relationship Id="rIdX" Target="x.xml"/>'.repeat(n)}<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` }],
    ['строковая таблица', { shared: `<sst>${'<si><t>y</t></si>'.repeat(n)}</sst>` }],
    ['форматы чисел', { styles: `<styleSheet><numFmts>${'<numFmt numFmtId="164" formatCode="0"/>'.repeat(n)}</numFmts></styleSheet>` }],
    ['стили ячеек', { styles: `<styleSheet><cellXfs>${'<xf numFmtId="0"/>'.repeat(n)}</cellXfs></styleSheet>` }],
  ];
  for (const [label, parts] of cases) {
    const buf = bookWithParts(parts);
    // Часы двигаются сами на каждый вызов: первая же проверка видит просрочку.
    let ticks = 0;
    const now = () => { ticks += 10_000; return ticks; };
    assert.throws(() => readXlsxRows(buf, { deadlineMs: 1, now }), /слишком сложный/i, label);
    assert.deepEqual(readXlsxRows(buf).rows[0], ['x'], `${label}: с нормальными часами книга читается`);
  }
});

/** Лист из одной строки с inline-ячейкой по заданной ссылке. */
const sheetWithCellAt = (ref) =>
  `<worksheet><sheetData><row r="1"><c r="${ref}" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`;

test('xlsx: данные далеко за краем листа пропускаются — файл читается, строка не раздувается', () => {
  // AAAAAA — 12 млн колонок (до CDEKRS-2: 300 МБ кучи и полсекунды на ОДНУ строку), XFE — за
  // пределом даже нынешнего Excel, IW — первая колонка за потолком ридера. Сначала такая ячейка
  // отвергала весь файл; но домен читает свои 18 колонок по заголовку, и заметка пользователя
  // где-то справа — не повод не принять выгрузку. Пропуск держит ту же память, что и отказ.
  for (const ref of ['AAAAAA1', 'AAAAAAA1', 'XFE1', 'IW1']) {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c>`
      + `<c r="${ref}" t="inlineStr"><is><t>заметка</t></is></c></row></sheetData></worksheet>`;
    const t0 = performance.now();
    const [row] = readSheetRows(bookWithParts({ sheet }), 'export.xlsx').rows;
    assert.ok(performance.now() - t0 < 500, `${ref}: пропуск обязан быть мгновенным`);
    assert.equal(row.length, 1, ref);
    assert.deepEqual(row, [7], ref);
  }
  // Объём: 20 000 строк с данными в AAAAAA — каждая строка остаётся в одну ячейку.
  const parts = [];
  for (let r = 1; r <= 20000; r++) {
    parts.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="AAAAAA${r}" t="inlineStr"><is><t>far</t></is></c></row>`);
  }
  const { rows } = readSheetRows(bookWithParts({ sheet: `<worksheet><sheetData>${parts.join('')}</sheetData></worksheet>` }), 'export.xlsx');
  assert.equal(rows.length, 20000);
  assert.ok(rows.every((row, i) => row.length === 1 && row[0] === i + 1), 'данные за краем не попали в строки');
});

test('xlsx: последняя допустимая колонка (IV, 256-я) читается', () => {
  const { rows } = readSheetRows(bookWithParts({ sheet: sheetWithCellAt('IV1') }), 'export.xlsx');
  assert.equal(rows[0].length, 256);
  assert.equal(rows[0][255], 'x');
  assert.equal(rows[0][0], null);
});

test('xlsx: пустая клетка оформления за краем листа не валит файл и не раздувает строку', () => {
  // Excel пишет `<c r="…" s="…"/>` у раскрашенных, но пустых клеток — данных в них нет.
  const buf = bookWithParts({
    sheet: '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c><c r="XFD1" s="1"/><c r="AAAAAA1"/></row></sheetData></worksheet>',
  });
  const [row] = readSheetRows(buf, 'export.xlsx').rows;
  // Длина — отдельно и первой: до правки строка была в 12 млн элементов, и diff deepEqual на ней
  // сам съедал память раннера.
  assert.equal(row.length, 1);
  assert.deepEqual(row, [7]);
});

test('xlsx: добитые null считаются в бюджет ячеек, а не только теги <c>', () => {
  // 50 строк по одной ячейке в 256-й колонке: тегов 50, а слотов в памяти — 12 800. Прежний счётчик
  // видел только теги, и сотня тысяч таких строк (zip ~0.5 МБ) держала 276 МБ кучи.
  const parts = [];
  for (let r = 1; r <= 50; r++) parts.push(`<row r="${r}"><c r="IV${r}"><v>${r}</v></c></row>`);
  const buf = bookWithParts({ sheet: `<worksheet><sheetData>${parts.join('')}</sheetData></worksheet>` });
  assert.throws(() => readXlsxRows(buf, { maxCells: 10000 }), /слишком много ячеек/);
  // Тот же файл в штатном бюджете читается целиком.
  const { rows } = readXlsxRows(buf);
  assert.equal(rows.length, 50);
  assert.equal(rows[49][255], 50);
});

// ── Потолок длины значения и пустое оформление справа (повторное ревью CDEKRS-2) ──────────────────
// decodeXml был s.replace(/&(…);/g, fn): глобальная регулярка с функцией в V8 сначала собирает ВСЕ
// совпадения, и одна ячейка из 11.5 МБ `&#65;` (zip ~18 КБ) за пару секунд съедала больше 256 МБ
// кучи — фатальный OOM того же класса, что CDEKRS-2. А бюджет слотов из CDEKRS-2 задел законные
// файлы: пустая клетка оформления в колонке IV добивала каждую строку null-ами до 256 слотов.

const { parseCdekSheet } = require('../server/domain/cdekImport');
const { CDEK_HEADER, cdekRow } = require('./cdekFixtures');

/** Прежний декодер — эталон смысла: линейный проход обязан давать ровно то же самое. */
const LEGACY_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const legacyDecode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }
  return LEGACY_ENTITIES[e] !== undefined ? LEGACY_ENTITIES[e] : m;
});

const tooLong = (fn, label) => assert.throws(fn, (e) => {
  assert.ok(e instanceof SheetReadError, label);
  assert.match(e.userMessage, /длиннее 32767 символов/, label);
  return true;
});

test('xlsx: линейный декодер ссылок даёт ровно то же, что прежний replace', () => {
  const samples = [
    'a&b', '&&amp;', '&amp;amp;', '&#65;&#x41;&#X41;', '&#0;&#x0;', '&#;&#x;&;', '&AMP;&Amp;',
    '&nbsp;&copy;', '&#128512;&#x1F600;', 'хвост&', '&#00065;', '&#9999999;x', '&#x110000;',
    '&lt;&gt;&quot;&apos;', 'a & b; c', '&amp', '&a1;', '&#1055;&#x440;&amp;&#65;', 'без ссылок',
    '&amp;&amp;&amp;', '&#65&#66;', '&&&#67;;',
  ];
  for (const s of samples) {
    const expected = legacyDecode(s);
    // inlineStr идёт через joinTexts, t="str" — прямо в decodeXml.
    assert.deepEqual(readSheetRows(xlsxWithRawCell(s), 'export.xlsx').rows[0], [expected], `inline: ${s}`);
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>${s}</v></c></row></sheetData></worksheet>`;
    assert.deepEqual(readSheetRows(bookWithParts({ sheet }), 'export.xlsx').rows[0], [expected], `str: ${s}`);
  }
});

// 2.3 млн `&#65;` — 11.5 МБ XML (под потолком листа в 12 МБ), zip ~18 КБ.
const ENTITY_FLOOD = '&#65;'.repeat(2_300_000);

test('xlsx: миллионы XML-ссылок в одном значении — мгновенный SheetReadError, а не фатальный OOM', () => {
  // До правки каждая из этих книг разворачивалась в значение на миллионы символов, а под
  // --max-old-space-size=256 процесс падал фатальным OOM (замер: 1.7–2.3 с, exit 134). try/catch
  // его не ловит — реплика перезапускается вместе со всеми запросами в полёте.
  const books = [
    ['ячейка inlineStr', { sheet: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${ENTITY_FLOOD}</t></is></c></row></sheetData></worksheet>` }],
    ['ячейка t="str"', { sheet: `<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>${ENTITY_FLOOD}</v></c></row></sheetData></worksheet>` }],
    ['formatCode', { styles: `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="${ENTITY_FLOOD}"/></numFmts></styleSheet>` }],
    // Строковой таблице распаковка отмеряет 4 МБ — в неё помещается 800 тысяч ссылок.
    ['строка sharedStrings', { shared: `<sst><si><t>${'&#65;'.repeat(800_000)}</t></si></sst>` }],
  ];
  for (const [label, parts] of books) {
    const buf = bookWithParts(parts);
    assert.ok(buf.length < 64 * 1024, `${label}: фикстура — десятки килобайт (${buf.length} Б)`);
    const t0 = performance.now();
    tooLong(() => readSheetRows(buf, 'export.xlsx'), label);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${label}: отказ занял ${ms.toFixed(0)} мс — потолок 1000 мс`);
  }
});

test('xlsx: потолок длины — 32 767 символов значения читаются, 32 768 уже нет; меряется декодированный текст', () => {
  const inline = (inner) => readSheetRows(xlsxWithRawCell(inner), 'export.xlsx').rows[0][0];
  // Предел ячейки самого Excel проходит целиком.
  assert.equal(inline('я'.repeat(32767)).length, 32767);
  tooLong(() => inline('я'.repeat(32768)), 'текст без ссылок');
  // Меряется РЕЗУЛЬТАТ: 32 767 `&amp;` — это 164 тысячи символов XML, но ровно 32 767 символов значения.
  assert.equal(inline('&amp;'.repeat(32767)), '&'.repeat(32767));
  tooLong(() => inline('&amp;'.repeat(32768)), 'ссылки');
  // rich-text: каждый кусок короткий, а значение целиком — нет.
  const rich = (n) => '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is>'
    + `<r><t>${'a'.repeat(n)}</t></r><r><t>${'b'.repeat(n)}</t></r></is></c></row></sheetData></worksheet>`;
  assert.equal(readSheetRows(bookWithParts({ sheet: rich(16000) }), 'export.xlsx').rows[0][0].length, 32000);
  tooLong(() => readSheetRows(bookWithParts({ sheet: rich(20000) }), 'export.xlsx'), 'rich-text из двух кусков');
  // Та же граница у строки из таблицы и у formatCode (сам Excel не пускает формат длиннее 255).
  tooLong(() => readSheetRows(bookWithParts({ shared: `<sst><si><t>${'x'.repeat(32768)}</t></si></sst>` }), 'export.xlsx'), 'sharedStrings');
  tooLong(() => readSheetRows(bookWithParts({
    styles: `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="${'['.repeat(150000)}"/></numFmts></styleSheet>`,
  }), 'export.xlsx'), 'formatCode из 150 000 «[»');
});

test('xlsx: пустая клетка посреди строки держит позицию, пустая справа строку не добивает', () => {
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1"><v>1</v></c><c r="B1" s="1"/><c r="C1"><v>3</v></c>'
    + '<c r="D1" t="inlineStr"><is><t></t></is></c><c r="E1" s="1"/></row>'
    + '<row r="2"><c r="A2" s="1"/><c r="IV2" s="1"/></row>'
    + '</sheetData></worksheet>';
  const { rows } = readSheetRows(bookWithParts({ sheet }), 'export.xlsx');
  assert.deepEqual(rows[0], [1, null, 3]);
  assert.equal(rows[1].length, 0, 'строка из одного оформления — пустая, а не 256 null');
});

test('xlsx: 20 000 строк с пустой клеткой оформления в IV — законная выгрузка читается и импортируется', () => {
  // Заливка или рамка, протянутая до колонки IV, — обычное дело. Excel пишет такие пустые клетки
  // тегом `<c r="IV5" s="1"/>`, а бюджет слотов из CDEKRS-2 добивал до неё каждую строку null-ами:
  // 20 001 × 256 = 5.1 млн слотов > 4 млн — выгрузка отвергалась «слишком много ячеек».
  const data = [CDEK_HEADER];
  for (let i = 1; i <= 20000; i++) {
    data.push(cdekRow({ id: i, created: '2026-01-10 10:00:00', productId: `p${i % 50}` }));
  }
  const { rows } = readSheetRows(buildXlsx(data, { styledTo: 'IV' }), 'export.xlsx');
  assert.equal(rows.length, 20001);
  // Длина строки — до последней НЕПУСТОЙ клетки (R, «Служба доставки»), а не до оформления.
  assert.ok(rows.every((row) => row.length === CDEK_HEADER.length), 'пустое оформление справа не раздувает строки');
  const parsed = parseCdekSheet(rows);
  assert.equal(parsed.stats.rows_total, 20000);
  assert.equal(parsed.stats.rows_rejected, 0);
  assert.equal(parsed.stats.orders_total, 20000);
});
