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
  constructor(message, options) {
    super(message, options);
    this.name = 'SheetReadError';
    this.userMessage = message;
  }
}

/**
 * Что показать, когда ридер упал НЕ своей ошибкой. Любое исключение, кроме SheetReadError, —
 * это внутренность реализации (RangeError из String.fromCodePoint, ошибка zlib, промах по
 * буферу), и его текст ничего не говорит пользователю: он видел «Invalid code point 9999999»
 * и пятисотку, а строка импорта сохраняла ту же фразу в `error` (I-2, аудит #554).
 */
const UNPARSEABLE = 'Файл не разобрался — сохраните его заново как .xlsx или .csv и попробуйте ещё раз';

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
function inflateEntry(buf, entry, budget, entryLimit = Infinity) {
  if (entry.compSize === ZIP64_MARK || entry.uncompSize === ZIP64_MARK) {
    throw new SheetReadError('Формат zip64 не поддерживается — сохраните файл заново');
  }
  // Потолок КОНКРЕТНОЙ записи, а не только общий остаток: один лист не должен съедать весь бюджет
  // архива и оставлять разбору 12 МБ строки вместо ожидаемой сотни килобайт.
  const limit = Math.min(budget.left, entryLimit);
  if (entry.uncompSize > limit) throw new SheetReadError('Файл слишком большой в распакованном виде');
  const lo = entry.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) {
    throw new SheetReadError('Файл повреждён: не читается запись архива');
  }
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + entry.compSize);
  let out;
  try {
    if (entry.method === 0) out = Buffer.from(data);
    else if (entry.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: limit });
    else throw new SheetReadError(`Файл сжат неизвестным способом (${entry.method})`);
  } catch (e) {
    // RangeError от maxOutputLength и ошибки zlib — это по-прежнему «плохой файл», а не сбой
    // сервиса: без обёртки текст драйвера доезжал до cdek_imports.error и до пользователя (I-2).
    if (e instanceof SheetReadError) throw e;
    if (e instanceof RangeError) throw new SheetReadError('Файл слишком большой в распакованном виде');
    throw new SheetReadError('Файл повреждён: не удалось распаковать архив');
  }
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
      // Верхняя граница обязательна: `&#9999999;` — валидный синтаксис, но за пределами Unicode,
      // и String.fromCodePoint на нём бросает RangeError. Неразбираемая ссылка остаётся собой —
      // ровно как неизвестная именованная сущность ниже.
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

// ── Линейный токенизатор вместо ленивых регулярок ──────────────────────────────────────────────
// ПОЧЕМУ. Регулярка вида /<row\b[^>]*>([\s\S]*?)<\/row>/ на КАЖДОМ незакрытом теге сканирует
// остаток файла до конца и откатывается: на входе из повторяющихся оборванных тегов время растёт
// квадратично. Замер аудита #554: ×4 на удвоение входа, 528 КБ занимали единственную web-реплику
// на 1.7 с, и это доступно любому пользователю через импорт своего канала СДЭКа (H-2).
// indexOf идёт вперёд и не откатывается — каждый символ читается фиксированное число раз.

const BROKEN = 'Файл повреждён';

/** Символы, продолжающие имя тега: без этой проверки `<row` нашёлся бы внутри `<rowBreaks`. */
function isNameChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 45 || code === 46 || code === 58 || code === 95;   // - . : _
}

/** Позиция следующего открывающего тега `<name` с настоящей границей имени, или -1. */
function findOpenTag(s, name, from) {
  const needle = `<${name}`;
  for (let i = s.indexOf(needle, from); i >= 0; i = s.indexOf(needle, i + 1)) {
    // На конце строки charCodeAt даёт NaN — сравнения ложны, тег считается найденным, и
    // отсутствие '>' ниже честно превращается в «Файл повреждён».
    if (!isNameChar(s.charCodeAt(i + needle.length))) return i;
  }
  return -1;
}

/**
 * Один элемент `<name …>…</name>` (или самозакрытый) начиная с `from`.
 * Возвращает { attrs, inner, next } либо null, если тегов больше нет. Отсутствие закрывающего
 * тега — ошибка, а НЕ повод просканировать файл до конца.
 * Ни один из разбираемых элементов (row, c, si, t, v) не вкладывается сам в себя, поэтому первый
 * встречный `</name>` и есть парный.
 */
function readElement(s, name, from) {
  const open = findOpenTag(s, name, from);
  if (open < 0) return null;
  const gt = s.indexOf('>', open);
  if (gt < 0) throw new SheetReadError(BROKEN);
  const selfClosing = s.charCodeAt(gt - 1) === 47;   // '/'
  const attrs = s.slice(open + name.length + 1, selfClosing ? gt - 1 : gt);
  if (selfClosing) return { attrs, inner: '', next: gt + 1 };
  const closeTag = `</${name}>`;
  const close = s.indexOf(closeTag, gt + 1);
  if (close < 0) throw new SheetReadError(BROKEN);
  return { attrs, inner: s.slice(gt + 1, close), next: close + closeTag.length };
}

/** Линейный подсчёт открытий/самозакрытий/закрытий одного тега — один проход, без разбора. */
function countTag(s, name) {
  const closeTag = `</${name}>`;
  let opens = 0;
  let selfClosing = 0;
  let closes = 0;
  for (let i = findOpenTag(s, name, 0); i >= 0; ) {
    opens++;
    const gt = s.indexOf('>', i);
    if (gt < 0) throw new SheetReadError(BROKEN);
    if (s.charCodeAt(gt - 1) === 47) selfClosing++;
    i = findOpenTag(s, name, gt + 1);
  }
  for (let i = s.indexOf(closeTag); i >= 0; i = s.indexOf(closeTag, i + closeTag.length)) closes++;
  return { opens, selfClosing, closes };
}

/**
 * Вторая линия обороны: до всякого разбора линейно считаем теги. Аномальный файл отвергается за
 * миллисекунды и не доходит до аллокаций, а токенизатор ниже уже не встретит несходящихся тегов.
 */
function prescanSheet(body, { maxRows, maxCells }) {
  const rows = countTag(body, 'row');
  if (rows.opens - rows.selfClosing !== rows.closes) throw new SheetReadError(BROKEN);
  // +1 — запас на строку заголовка: сам кап проверяется по номеру строки в parseSheet.
  if (rows.opens > maxRows + 1) throw new SheetReadError(`В файле больше ${maxRows} строк`);
  const cells = countTag(body, 'c');
  if (cells.opens - cells.selfClosing !== cells.closes) throw new SheetReadError(BROKEN);
  if (cells.opens > maxCells) throw new SheetReadError('В файле слишком много ячеек');
}

/** Склейка всех <t> внутри блока (rich-text разбит на <r><t>…</t></r> кусками). */
function joinTexts(xml) {
  // <rPh> — фонетическая подсказка (японский), внутри тоже <t>: в текст ячейки не входит.
  let body = xml;
  if (body.includes('<rPh')) {
    let stripped = '';
    let pos = 0;
    for (;;) {
      const at = findOpenTag(body, 'rPh', pos);
      if (at < 0) break;
      stripped += body.slice(pos, at);
      const el = readElement(body, 'rPh', at);
      pos = el.next;
    }
    body = stripped + body.slice(pos);
  }
  let text = '';
  let pos = 0;
  for (;;) {
    const el = readElement(body, 't', pos);
    if (!el) return text;
    text += decodeXml(el.inner);
    pos = el.next;
  }
}

function parseSharedStrings(xml, { maxCells = 4000000 } = {}) {
  const counts = countTag(xml, 'si');
  if (counts.opens - counts.selfClosing !== counts.closes) throw new SheetReadError(BROKEN);
  if (counts.opens > maxCells) throw new SheetReadError('В файле слишком много ячеек');
  const out = [];
  let pos = 0;
  for (;;) {
    const el = readElement(xml, 'si', pos);
    if (!el) return out;
    out.push(el.inner ? joinTexts(el.inner) : '');
    pos = el.next;
  }
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

const PARSE_DEADLINE_MS = 3000;
const DEADLINE_CHECK_EVERY = 500;

function parseSheet(xml, { shared, dateStyles, maxRows, maxCells, deadlineMs = PARSE_DEADLINE_MS, now = Date.now }) {
  const start = xml.indexOf('<sheetData');
  const body = start < 0 ? '' : xml.slice(start);
  prescanSheet(body, { maxRows, maxCells });
  const rows = [];
  let cells = 0;
  let pos = 0;
  // Счётчик РАЗОБРАННЫХ тегов <row>. Раньше дедлайн проверялся по `rows.length`, а она растёт не
  // на единицу: Excel не пишет пустые строки, но помнит их номера, и `while (rows.length < target)`
  // ниже прыгает через пропуски. Кратности 500 массив мог не коснуться НИ РАЗУ — «последний
  // рубеж» просто не срабатывал (аудит #554, проход №2, N16). DoS этим не открывается: перед
  // разбором стоит линейный pre-scan, — но рубеж обязан работать так, как о нём написано.
  let parsedRows = 0;
  // Дедлайн — последний рубеж: даже линейный разбор гигантского законного листа не должен
  // занимать единственную web-реплику дольше нескольких секунд.
  const until = now() + deadlineMs;
  for (;;) {
    const el = readElement(body, 'row', pos);
    if (!el) break;
    pos = el.next;
    parsedRows += 1;
    if (parsedRows % DEADLINE_CHECK_EVERY === 0 && now() > until) {
      throw new SheetReadError('Файл слишком сложный — разбор занял бы слишком много времени');
    }
    // Excel не пишет в XML пустые строки, но помнит их номер в атрибуте r. Держим индекс массива
    // равным номеру строки в самом Excel: по этому номеру пользователь ищет отвергнутую строку
    // в своём файле, и «12-я по счёту непустая» ему ничем не поможет.
    const at = Number((el.attrs.match(/\br="(\d+)"/) || [])[1]);
    const target = Number.isFinite(at) && at > 0 ? at - 1 : rows.length;
    if (target >= maxRows) throw new SheetReadError(`В файле больше ${maxRows} строк`);
    while (rows.length < target) rows.push([]);
    const row = [];
    let cellPos = 0;
    for (;;) {
      const c = readElement(el.inner, 'c', cellPos);
      if (!c) break;
      cellPos = c.next;
      if (++cells > maxCells) throw new SheetReadError('В файле слишком много ячеек');
      const attrs = c.attrs;
      const inner = c.inner;
      const ref = attrs.match(/r="([A-Za-z]+)\d+"/);
      const idx = ref ? colIndex(ref[1]) : row.length;
      if (idx < 0) continue;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const style = (attrs.match(/\bs="(\d+)"/) || [])[1];
      let value = null;
      if (type === 'inlineStr') {
        value = joinTexts(inner);
      } else {
        const v = readElement(inner, 'v', 0);
        const raw = v ? v.inner : undefined;
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
 * Бюджет распаковки. Настоящая выгрузка СДЭКа разворачивается в 7.8 раза (107 КБ zip → 0.81 МБ
 * XML, ~758 байт на строку); годовая выгрузка — это сотни килобайт. Прежние 128 МБ были снятой с
 * потолка величиной «с запасом на всё» и в паре с ленивыми регулярками давали минуты работы
 * единственной web-реплики (H-2). 16 МБ — это ~20 тысяч строк заказов, вдвое больше самого
 * большого законного файла, который видел прод; отдельные потолки на лист и на строковую таблицу
 * не дают одной записи выбрать весь бюджет.
 */
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_SHEET_BYTES = 12 * 1024 * 1024;
const MAX_SHARED_STRINGS_BYTES = 4 * 1024 * 1024;

function readXlsxRows(buffer, {
  maxRows = 100000,
  maxCells = 4000000,
  maxInflatedBytes = MAX_INFLATED_BYTES,
  maxSheetBytes = MAX_SHEET_BYTES,
  maxSharedStringsBytes = MAX_SHARED_STRINGS_BYTES,
  deadlineMs,
  now,
} = {}) {
  const entries = readZipEntries(buffer);
  const budget = { left: maxInflatedBytes };
  const get = (name, limit) => (entries.has(name) ? inflateEntry(buffer, entries.get(name), budget, limit) : '');
  const sheet = firstSheetPath(entries, get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'));
  const shared = entries.has('xl/sharedStrings.xml')
    ? parseSharedStrings(get('xl/sharedStrings.xml', maxSharedStringsBytes), { maxCells })
    : [];
  const dateStyles = entries.has('xl/styles.xml') ? parseDateStyles(get('xl/styles.xml')) : [];
  const rows = parseSheet(inflateEntry(buffer, entries.get(sheet.path), budget, maxSheetBytes), {
    shared, dateStyles, maxRows, maxCells,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(now !== undefined ? { now } : {}),
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
function readSheetRowsUnguarded(buffer, filename = '', options = {}) {
  const name = String(filename || '').toLowerCase();
  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === LOCAL_SIG;
  const isOle = buffer.length > 8 && buffer.readUInt32LE(0) === 0xe011cfd0;
  if (isZip || name.endsWith('.xlsx')) return readXlsxRows(buffer, options);
  if (isOle || name.endsWith('.xls')) {
    throw new SheetReadError('Старый формат .xls не поддерживается — пересохраните как .xlsx или .csv');
  }
  return readCsvRows(buffer, options);
}

/**
 * Единственная граница ридера наружу: ЛЮБОЙ выход — либо строки, либо SheetReadError.
 * Разбор чужого файла — это разбор недоверенного ввода, и полный список его отказов не
 * перечислим по построению: на каждый предусмотренный случай найдётся непредусмотренный.
 * Поэтому дело не в починке конкретного RangeError (он тоже починен выше), а в том, что
 * «неизвестно почему не читается» — тоже ответ пользователю, а не пятисотка с текстом драйвера.
 * Исходное исключение не теряется: оно уезжает в `cause`, и вызывающий пишет его в лог.
 */
function readSheetRows(buffer, filename = '', options = {}) {
  try {
    return readSheetRowsUnguarded(buffer, filename, options);
  } catch (e) {
    if (e instanceof SheetReadError) throw e;
    throw new SheetReadError(UNPARSEABLE, { cause: e });
  }
}

module.exports = { readSheetRows, readXlsxRows, readCsvRows, SheetReadError, serialToNaive, decodeText };
