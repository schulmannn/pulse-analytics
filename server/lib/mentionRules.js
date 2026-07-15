'use strict';

/* ── Pure validation/sanitization of per-channel mention rules ────────────────────────────────────
   Единственная точка правды для формы правил упоминаний (channel_mention_settings, миграция 018).
   Чистый модуль без БД/сети: и роут PUT /api/tg/mention-settings, и юнит-тесты зовут validateRules.

   Что делаем:
     • входные списки — ТОЛЬКО массивы (объект/строка/число → 400);
     • термины трим + схлопывание внутренних пробелов, но НАПИСАНИЕ сохраняем (display/query как ввёл
       пользователь) — Telegram searchPosts ищет по видимой форме;
     • дедуп по регистронезависимой канонической форме, НО диакритические варианты сохраняются:
       Telegram не документирует accent-folding глобального поиска, поэтому 'notem' и 'nōtem'
       должны уйти отдельными searchPosts-запросами. Латиница и кириллица также остаются разными;
     • лимиты: include 1..12, exclude ≤30, sources ≤50, длина элемента ≤80;
     • источники (exclude_sources): @ снимается, lowercase; допускается либо числовой id канала,
       либо username из разрешённого набора символов Telegram;
     • match_mode ∈ {contains, word}.

   Ошибки — стабильный throw с .code='mention_rules_invalid', .status=400 и БЕЗОПАСНЫМ русским
   .message (без эха пользовательского ввода — чтобы не тащить мусор в UI/логи). */

const MAX_ITEM_LEN = 80;
const MAX_INCLUDE = 12;
const MAX_EXCLUDE = 30;
const MAX_SOURCES = 50;
const MATCH_MODES = ['contains', 'word'];
// Telegram usernames: латиница/цифры/подчёркивание. Валидируем набор символов (не длину 5..32 —
// исторические/служебные имена бывают короче), но кап 32 держим как разумную границу.
const USERNAME_RE = /^[a-z0-9_]{1,32}$/;
const NUMERIC_ID_RE = /^\d{1,19}$/;

function ruError(message) {
  const err = new Error(message);
  err.code = 'mention_rules_invalid';
  err.status = 400;
  return err;
}

// Поисковый дедуп намеренно НЕ снимает диакритику: Telegram может вернуть разные результаты для
// notem/nōtem. NFKC + lowercase убирают только реально одинаковые варианты написания/регистра.
function searchKey(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase().trim();
}

// Нормализация отображаемого термина: трим + внутренние пробелы в один пробел. Написание сохраняем.
function normalizeTerm(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// asArray: строго массив, иначе — доменная ошибка (не молча приводим строку к [строка]).
function asArray(value, fieldLabel) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ruError(`Поле «${fieldLabel}» должно быть списком`);
  return value;
}

// Общий дедуп-нормализатор списка терминов. Возвращает массив display-строк, первое вхождение
// каждого ключа свёртки. Пустые (после трима) отбрасываются. Проверяет тип и длину элемента.
function normalizeTermList(raw, { fieldLabel, max }) {
  const arr = asArray(raw, fieldLabel);
  if (arr.length > max * 4) throw ruError(`Слишком много значений в поле «${fieldLabel}»`);
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string') throw ruError(`Значения в поле «${fieldLabel}» должны быть строками`);
    const term = normalizeTerm(item);
    if (!term) continue;
    if (term.length > MAX_ITEM_LEN) throw ruError(`Термин длиннее ${MAX_ITEM_LEN} символов в поле «${fieldLabel}»`);
    const key = searchKey(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length > max) throw ruError(`В поле «${fieldLabel}» не больше ${max} значений`);
  }
  return out;
}

// Источники: @ снимается, lowercase; либо числовой id, либо username-набор символов.
function normalizeSourceList(raw) {
  const arr = asArray(raw, 'Исключённые источники');
  if (arr.length > MAX_SOURCES * 4) throw ruError('Слишком много исключённых источников');
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string') throw ruError('Источники должны быть строками');
    const cleaned = item.replace(/\s+/g, '').replace(/^@+/, '').toLowerCase();
    if (!cleaned) continue;
    if (cleaned.length > MAX_ITEM_LEN) throw ruError(`Источник длиннее ${MAX_ITEM_LEN} символов`);
    if (!NUMERIC_ID_RE.test(cleaned) && !USERNAME_RE.test(cleaned)) {
      throw ruError('Источник должен быть @username или числовым id канала');
    }
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length > MAX_SOURCES) throw ruError(`Не больше ${MAX_SOURCES} исключённых источников`);
  }
  return out;
}

/* Полная валидация правил из тела запроса. Возвращает нормализованный объект, готовый к записи:
   { include_terms, exclude_terms, exclude_sources, match_mode }.
   Бросает ruError (status=400, code='mention_rules_invalid') на любой невалидный вход. */
function validateRules(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw ruError('Ожидались правила упоминаний');
  }
  const include_terms = normalizeTermList(input.include_terms, {
    fieldLabel: 'Искать упоминания', max: MAX_INCLUDE,
  });
  if (include_terms.length < 1) throw ruError('Добавьте хотя бы один поисковый термин');

  const exclude_terms = normalizeTermList(input.exclude_terms, {
    fieldLabel: 'Исключить термины', max: MAX_EXCLUDE,
  });
  const exclude_sources = normalizeSourceList(input.exclude_sources);

  let match_mode = input.match_mode === undefined || input.match_mode === null ? 'contains' : input.match_mode;
  if (typeof match_mode !== 'string' || !MATCH_MODES.includes(match_mode)) {
    throw ruError('Недопустимый режим совпадения');
  }

  return { include_terms, exclude_terms, exclude_sources, match_mode };
}

module.exports = {
  validateRules,
  MAX_ITEM_LEN,
  MAX_INCLUDE,
  MAX_EXCLUDE,
  MAX_SOURCES,
  MATCH_MODES,
};
