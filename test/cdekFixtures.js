'use strict';

// Сборка НАСТОЯЩЕГО .xlsx (zip + OOXML) прямо в тесте — вместо бинарного файла в репозитории.
// Так проверяется весь путь ридера: центральный каталог zip, deflate, sharedStrings, стили дат,
// разрежённые строки. Фикстура-байты в git были бы непрозрачны для ревью и несли бы настоящие
// данные склада владельца; здесь же структура эталонной выгрузки воспроизводится синтетикой.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Минимальный zip-писатель: локальные заголовки + центральный каталог + EOCD, deflate. */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** «A», «B», … «AA» по 0-based индексу колонки. */
function colName(i) {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * rows — массив массивов. Ячейка может быть:
 *   строкой  → shared string,
 *   числом   → число,
 *   null     → пропущенная ячейка (в XML её просто нет — как в настоящей выгрузке),
 *   { date }        → серийное число под датовым стилем,
 *   { inline }      → inlineStr,
 *   { formulaText } → t="str" (кэшированный результат формулы).
 */
function buildXlsx(rows, { sheetName = 'Sheet1' } = {}) {
  const shared = [];
  const sharedIndex = new Map();
  const sharedOf = (s) => {
    if (!sharedIndex.has(s)) { sharedIndex.set(s, shared.length); shared.push(s); }
    return sharedIndex.get(s);
  };

  const xmlRows = rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (cell === null || cell === undefined) return '';
      const ref = `${colName(c)}${r + 1}`;
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${sharedOf(cell)}</v></c>`;
      if (cell.date !== undefined) return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
      if (cell.inline !== undefined) {
        return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.inline)}</t></is></c>`;
      }
      if (cell.formulaText !== undefined) {
        return `<c r="${ref}" t="str"><f>A1</f><v>${esc(cell.formulaText)}</v></c>`;
      }
      return '';
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${xmlRows}</sheetData></worksheet>`;

  const sst = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">`
    + shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
    + `</sst>`;

  // Стиль 0 — обычный, стиль 1 — пользовательский датовый формат (numFmtId 164).
  const styles = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>`
    + `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`
    + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs>`
    + `</styleSheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
    + `</Relationships>`;

  return buildZip([
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sst, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}

/** Заголовок эталонной выгрузки СДЭК — все 18 колонок в исходном порядке. */
const CDEK_HEADER = [
  'ID', 'Создан', 'Внешний ID', 'Трек-номер', 'Статус', 'Комментарий',
  'ID товара', 'Название товара', 'Внешний ID товара', 'Статус товара',
  'Артикул', 'SKU товара', 'Штрих-коды', 'Стоимость товара', 'Количество',
  'Зарезервированное количество', 'Склад', 'Служба доставки',
];

/** Строка выгрузки из именованных полей — в тестах видно только то, что важно для случая. */
function cdekRow({
  id, created, externalId = null, track = null, status = 'complete', comment = null,
  productId, title = 'Товар', productExternalId = null, itemStatus = 'normal',
  article = null, sku = null, barcodes = null, price = 1000, qty = 1, reserved = 1,
  warehouse = '19821', carrier = 'Cdek',
}) {
  return [id, created, externalId, track, status, comment, productId, title, productExternalId,
    itemStatus, article, sku, barcodes, price, qty, reserved, warehouse, carrier];
}

module.exports = { buildXlsx, buildZip, crc32, CDEK_HEADER, cdekRow };
