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
