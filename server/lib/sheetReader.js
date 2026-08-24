'use strict';

const zlib = require('zlib');

/**
 * Чтение табличной выгрузки (.xlsx / .csv) в массив строк-массивов — без внешних зависимостей.
 *
 * ПОЧЕМУ СВОЙ РИДЕР. Единственный формат, который нам нужен, — плоский лист без формул: .xlsx
 * это zip с XML внутри, а `zlib.inflateRaw` уже есть в Node. Готовые пакеты (exceljs) тянут
 * десяток транзитивных зависимостей ради того, чего мы не используем, а `xlsx` на npm стоит на
 * версии 2022 года с известной уязвимостью. Свой ридер к тому же НИКОГДА не вычисляет формул
 * (читает только кэшированные значения) и умеет ограничить объём распаковки — обе защиты нужны
 * ровно потому, что файл приходит от пользователя.
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ: zip64 (файлы > 4 ГБ), шифрованных книг, нескольких листов
 * (берётся первый — выгрузка СДЭКа одностраничная), стилей/форматирования. Каждый из этих
 * случаев падает с ВНЯТНЫМ сообщением, а не отдаёт молча пустой лист.
 *
 * Даты. Выгрузка СДЭКа печатает время строкой («2025-07-31 15:39:48»), но шаблон могут
 * поменять на настоящие даты — тогда в ячейке лежит серийное число, и без разбора стилей
 * весь файл отвергся бы «неразборчивой датой». Поэтому numFmt читается, и дата-ячейка
 * отдаётся тем же наивным строковым видом, что и текстовая: у домена один путь разбора даты.
 */

class SheetReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetReadError';
    this.userMessage = message;
  }
}

// ── ZIP ────────────────────────────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

/** Смещение End-of-central-directory. Ищем с конца: за ним может стоять комментарий до 64 КБ. */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Центральный каталог → Map<имя, {method, compSize, uncompSize, localOff}>. */
function readZipEntries(buf) {
  if (buf.length < 22) throw new SheetReadError('Файл повреждён или пуст');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new SheetReadError('Это не .xlsx — внутри нет zip-архива');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === ZIP64_MARK || count === 0xffff) {
    throw new SheetReadError('Формат zip64 не поддерживается — сохраните файл заново');
  }
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) {
      throw new SheetReadError('Файл повреждён: не читается оглавление архива');
    }
    const nameLen = buf.readUInt16LE(off + 28);
    const entry = {
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      uncompSize: buf.readUInt32LE(off + 24),
      localOff: buf.readUInt32LE(off + 42),
    };
    entries.set(buf.toString('utf8', off + 46, off + 46 + nameLen), entry);
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return entries;
}

/**
 * Распаковка одной записи в utf8-строку. budget — общий остаток на весь архив: без него
 * zip-бомба на 100 КБ разворачивается в гигабайты (`maxOutputLength` рвёт inflate на пороге,
 * а не после того, как память уже съедена).
 */
function inflateEntry(buf, entry, budget) {
  if (entry.compSize === ZIP64_MARK || entry.uncompSize === ZIP64_MARK) {
    throw new SheetReadError('Формат zip64 не поддерживается — сохраните файл заново');
  }
  if (entry.uncompSize > budget.left) throw new SheetReadError('Файл слишком большой в распакованном виде');
  const lo = entry.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) {
    throw new SheetReadError('Файл повреждён: не читается запись архива');
  }
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + entry.compSize);
  let out;
  if (entry.method === 0) out = Buffer.from(data);
  else if (entry.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: budget.left });
  else throw new SheetReadError(`Файл сжат неизвестным способом (${entry.method})`);
  budget.left -= out.length;
  return out.toString('utf8');
}

// ── XML ────────────────────────────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  if (!s || !s.includes('&')) return s || '';
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/** Склейка всех <t> внутри блока (rich-text разбит на <r><t>…</t></r> кусками). */
function joinTexts(xml) {
  // <rPh> — фонетическая подсказка (японский), внутри тоже <t>: в текст ячейки не входит.
  const body = xml.includes('<rPh') ? xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '') : xml;
  let text = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(body))) text += decodeXml(m[1]);
  return text;
}

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? joinTexts(m[1]) : '');
  return out;
}

/**
 * Индексы стилей, означающих дату. Встроенные numFmtId 14–22 и 45–47 — календарные/временные
 * по спецификации; пользовательские определяются по формату: из кода вырезаются литералы
 * (кавычки, экранирование, скобки условий) и проверяется наличие y/m/d/h/s.
 */
function parseDateStyles(xml) {
  const dateFmts = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const numFmtRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m;
  while ((m = numFmtRe.exec(xml))) {
    const code = decodeXml(m[2])
      .replace(/\[[^\]]*\]/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/\\./g, '');
    if (/[ymdhs]/i.test(code)) dateFmts.add(Number(m[1]));
  }
  const block = xml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/);
  const isDate = [];
  if (block) {
    const xfRe = /<xf\b([^>]*?)\/?>/g;
    let xf;
    while ((xf = xfRe.exec(block[0]))) {
      const id = (xf[1].match(/numFmtId="(\d+)"/) || [])[1];
      isDate.push(id !== undefined && dateFmts.has(Number(id)));
    }
  }
  return isDate;
}

/** «AB» → 27 (0-based). Буквенная часть ссылки вида «AB12». */
function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/**
 * Серийная дата Excel → наивная строка «YYYY-MM-DD HH:MM:SS».
 * 1 = 1900-01-01, но в книге есть фиктивное 29 февраля 1900 (серийный 60), поэтому сдвиг в
 * 25569 суток до Unix-эпохи верен для дат ПОСЛЕ 1 марта 1900. Более ранние в выгрузках заказов
 * не встречаются — они возвращаются числом как есть, а не переводятся наугад.
 * Компоненты читаются через getUTC*: серийное значение по смыслу наивное, и локальная зона
 * рантайма не должна его сдвигать.
 */
function serialToNaive(serial) {
  if (!(serial > 60)) return serial;
  const ms = Math.round((serial - 25569) * 86400) * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function parseSheet(xml, { shared, dateStyles, maxRows, maxCells }) {
  const start = xml.indexOf('<sheetData');
  const body = start < 0 ? '' : xml.slice(start);
  const rows = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let cells = 0;
  let m;
  while ((m = rowRe.exec(body))) {
    if (rows.length >= maxRows) throw new SheetReadError(`В файле больше ${maxRows} строк`);
    const row = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cellRe.exec(m[1] || ''))) {
      if (++cells > maxCells) throw new SheetReadError('В файле слишком много ячеек');
      const attrs = c[1] || '';
      const inner = c[2] || '';
      const ref = attrs.match(/r="([A-Za-z]+)\d+"/);
      const idx = ref ? colIndex(ref[1]) : row.length;
      if (idx < 0) continue;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const style = (attrs.match(/\bs="(\d+)"/) || [])[1];
      let value = null;
      if (type === 'inlineStr') {
        value = joinTexts(inner);
      } else {
        const raw = (inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (raw !== undefined) {
          if (type === 's') {
            const i = Number(raw);
            value = shared[i] !== undefined ? shared[i] : '';
          } else if (type === 'str') {
            value = decodeXml(raw);
          } else if (type === 'b') {
            value = raw === '1';
          } else if (type !== 'e') {
            const num = Number(raw);
            if (Number.isFinite(num)) {
              value = style !== undefined && dateStyles[Number(style)] ? serialToNaive(num) : num;
            }
          }
        }
      }
      while (row.length < idx) row.push(null);
      row[idx] = value === '' ? null : value;
    }
    rows.push(row);
  }
  return rows;
}

/** Путь первого листа книги: workbook.xml → r:id → rels. Фолбэк — младший sheetN.xml. */
function firstSheetPath(entries, workbookXml, relsXml) {
  const decl = workbookXml && workbookXml.match(/<sheet\b[^>]*>/);
  const name = decl ? decodeXml((decl[0].match(/name="([^"]*)"/) || [])[1] || '') : '';
  const rid = decl ? (decl[0].match(/r:id="([^"]+)"/) || [])[1] : null;
  if (rid && relsXml) {
    const rel = relsXml.match(new RegExp(`<Relationship\\b[^>]*Id="${rid.replace(/[^\w.-]/g, '')}"[^>]*>`));
    const target = rel ? (rel[0].match(/Target="([^"]+)"/) || [])[1] : null;
    if (target) {
      const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      if (entries.has(path)) return { path, name };
    }
  }
  const fallback = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  if (!fallback.length) throw new SheetReadError('В книге не найдено ни одного листа');
  return { path: fallback[0], name };
}

/**
 * Бюджет распаковки: настоящая выгрузка СДЭКа разворачивается в 7.8 раза (107 КБ zip → 0.81 МБ
 * XML, ~758 байт на строку), поэтому файл предельного размера, который принимает роут (10 МБ),
 * даёт около 80 МБ XML. 128 МБ — это ~13-кратное отношение: законному файлу с запасом хватает,
 * а классическая zip-бомба с отношением в сотни раз обрывается на пороге.
 */
function readXlsxRows(buffer, { maxRows = 100000, maxCells = 4000000, maxInflatedBytes = 128 * 1024 * 1024 } = {}) {
  const entries = readZipEntries(buffer);
  const budget = { left: maxInflatedBytes };
  const get = (name) => (entries.has(name) ? inflateEntry(buffer, entries.get(name), budget) : '');
  const sheet = firstSheetPath(entries, get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'));
  const shared = entries.has('xl/sharedStrings.xml') ? parseSharedStrings(get('xl/sharedStrings.xml')) : [];
  const dateStyles = entries.has('xl/styles.xml') ? parseDateStyles(get('xl/styles.xml')) : [];
  const rows = parseSheet(inflateEntry(buffer, entries.get(sheet.path), budget), {
    shared, dateStyles, maxRows, maxCells,
  });
  return { rows, sheetName: sheet.name || '' };
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────

/** Проверка на валидный UTF-8 без исключений — по ней выбирается кодировка CSV. */
function looksLikeUtf8(buf) {
  for (let i = 0; i < buf.length; ) {
    const b = buf[i];
    let extra;
    if (b < 0x80) { i++; continue; }
    else if (b >= 0xc2 && b <= 0xdf) extra = 1;
    else if (b >= 0xe0 && b <= 0xef) extra = 2;
    else if (b >= 0xf0 && b <= 0xf4) extra = 3;
    else return false;
    if (i + extra >= buf.length) return false;
    for (let k = 1; k <= extra; k++) if ((buf[i + k] & 0xc0) !== 0x80) return false;
    i += extra + 1;
  }
  return true;
}

/**
 * Байты → текст. Excel в русской локали сохраняет CSV в windows-1251, и без этой развилки
 * кириллица тихо превращается в кракозябры: заголовки не сойдутся, и файл будет отвергнут с
 * невнятной причиной вместо честного разбора.
 */
function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8', 3);
  }
  if (looksLikeUtf8(buffer)) return buffer.toString('utf8');
  return new TextDecoder('windows-1251').decode(buffer);
}

/** Разделитель по первой строке: считаем вне кавычек. Русский Excel пишет «;». */
function sniffDelimiter(text) {
  const line = text.slice(0, text.indexOf('\n') + 1 || text.length);
  let quoted = false;
  const counts = { ';': 0, ',': 0, '\t': 0 };
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts[ch] !== undefined) counts[ch]++;
  }
  return Object.keys(counts).reduce((best, k) => (counts[k] > counts[best] ? k : best), ',');
}

function readCsvRows(buffer, { maxRows = 100000 } = {}) {
  const text = decodeText(buffer);
  const delim = sniffDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const pushField = () => { row.push(field.length ? field : null); field = ''; };
  const pushRow = () => {
    rows.push(row);
    if (rows.length > maxRows) throw new SheetReadError(`В файле больше ${maxRows} строк`);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) pushField();
    else if (ch === '\r') continue;
    else if (ch === '\n') { pushField(); pushRow(); }
    else field += ch;
  }
  if (field.length || row.length) { pushField(); pushRow(); }
  // Хвостовая пустая строка файла — не строка данных.
  while (rows.length && rows[rows.length - 1].every((v) => v === null)) rows.pop();
  return { rows, sheetName: '' };
}

/**
 * Единый вход: формат выбирается по расширению, а при его отсутствии — по сигнатуре файла.
 * Старый бинарный .xls (OLE-контейнер) распознаётся ОТДЕЛЬНО и отвергается с подсказкой: иначе он
 * ушёл бы в CSV-ветку и разобрался бы в мусорные строки — молча и правдоподобно.
 */
function readSheetRows(buffer, filename = '', options = {}) {
  const name = String(filename || '').toLowerCase();
  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === LOCAL_SIG;
  const isOle = buffer.length > 8 && buffer.readUInt32LE(0) === 0xe011cfd0;
  if (isZip || name.endsWith('.xlsx')) return readXlsxRows(buffer, options);
  if (isOle || name.endsWith('.xls')) {
    throw new SheetReadError('Старый формат .xls не поддерживается — пересохраните как .xlsx или .csv');
  }
  return readCsvRows(buffer, options);
}

module.exports = { readSheetRows, readXlsxRows, readCsvRows, SheetReadError, serialToNaive, decodeText };
