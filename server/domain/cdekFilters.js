'use strict';

const { SALES_CHANNELS, ORDER_STATUSES } = require('./cdekImport');

/* ── Нормализация фильтров СДЭКа (домен) ────────────────────────────────────────────────────────
   Чистые функции разбора пользовательского выбора: каналы продаж, товары, «что считать выручкой».
   Жили в repos/cdekRepo, и роут импортировал их ОТТУДА — через слой, к которому у него доступа
   быть не должно (аудит #554: routes тянут repo напрямую). Сами по себе они к БД отношения не
   имеют: это правила чтения запроса, то есть домен.

   Общий принцип всех трёх: незнакомый ключ — ОТКАЗ, а не молчаливый пустой ответ. Пустой график,
   неотличимый от «продаж не было», — худший из возможных ответов. */

const SALES_CHANNEL_KEYS = [...new Set([...Object.values(SALES_CHANNELS), 'other'])].sort();

/**
 * Набор каналов продаж для запроса; null — фильтра нет.
 *
 * Незнакомый ключ — ОШИБКА, а не повод молча вернуть ноль строк: «Wildberrys» с опечаткой дал бы
 * пустой график, неотличимый от «продаж не было». Возвращаем признак, роут отвечает отказом —
 * тот же приём, что у потолка товаров и у каналов МойСклада.
 */
function normalizeCdekChannels(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  const picked = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort();
  if (picked.length === 0) return null;
  if (picked.some((key) => !SALES_CHANNEL_KEYS.includes(key))) return { unknown: true };
  // Выбраны все — это «фильтра нет»: короче строка, устойчивее кэш (тот же приём у статусов).
  return picked.length === SALES_CHANNEL_KEYS.length ? null : picked;
}

/**
 * Наборы фильтров ЛЕНТЫ заказов. Отличие от метрик одно: лента показывает СТРОКИ, а не считает
 * число, поэтому «выбраны все» здесь тоже честно значит «фильтра нет», а незнакомый ключ —
 * отказ, как и везде (пустая лента, неотличимая от «заказов не было», — худший из ответов).
 */
function normalizeKeySet(raw, known) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  const picked = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort();
  if (picked.length === 0) return null;
  if (picked.some((key) => !known.includes(key))) return { unknown: true };
  return picked.length === known.length ? null : picked;
}

/**
 * Ключи каналов ЛЕНТЫ: к пяти известным добавлен `none` — заказ без перевозчика. В SQL он значит
 * пустую строку (COALESCE над NULL), но в списке через запятую пустое значение не передать.
 */
const ORDER_CHANNEL_KEYS = [...SALES_CHANNEL_KEYS, 'none'];
const normalizeOrderChannels = (raw) => {
  const picked = normalizeKeySet(raw, ORDER_CHANNEL_KEYS);
  return Array.isArray(picked) ? picked.map((k) => (k === 'none' ? '' : k)) : picked;
};

/** Ограничение набора товаров: столько влезает в осмысленный выбор, дальше это уже «все». */
const PRODUCT_FILTER_MAX = 50;

/**
 * Массив товаров для параметра запроса; null — фильтра нет (а не «ноль товаров»).
 *
 * Перебор потолка — ОШИБКА, а не повод молча срезать хвост. Раньше 51-й товар просто исчезал:
 * выручка считалась по пятидесяти, а карточка над ней писала «Только выбранные товары: 51», и
 * узнать о подмене было неоткуда — ответ применённый список не возвращает. Тот же вопрос в
 * МойСкладе решён отказом («Можно выбрать не более 20 каналов»), и здесь теперь так же: неверное
 * число честнее подменённого.
 */
function normalizeCdekProducts(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? raw.split(',') : [];
  const picked = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort();
  if (picked.length > PRODUCT_FILTER_MAX) return { tooMany: true };
  return picked.length > 0 ? picked : null;
}

const INCLUDE_MODES = new Set(['revenue', 'completed', 'all']);
/** Статусы заказа, известные разбору выгрузки. Произвольный набор строится ТОЛЬКО из них. */
// Список статусов — из домена, а не переписан рядом: разойдись они, фильтр молча перестал бы
// принимать статус, который импорт кладёт в базу.

/**
 * Нормализация «что считать выручкой». Кроме трёх прежних режимов принимает явный набор статусов
 * `status:complete,delivery` (запрос владельца — считать выручку по выбранным статусам).
 *
 * Набор едет ТЕМ ЖЕ параметром $7, а не новым: `windowParams` отдаёт ровно $1..$7, и каждый
 * читающий запрос дописывает свои плейсхолдеры следом — восьмой параметр в префиксе сдвинул бы
 * нумерацию во всех запросах сразу. Здесь же меняется одно место.
 *
 * Значения из набора всегда из белого списка, отсортированы и без дублей: иначе один и тот же
 * выбор давал бы разные строки и, следовательно, разные ключи кэша на клиенте.
 */
function normalizeCdekInclude(raw) {
  if (typeof raw !== 'string') return 'revenue';
  if (INCLUDE_MODES.has(raw)) return raw;
  if (!raw.startsWith('status:')) return 'revenue';
  const picked = [...new Set(raw.slice(7).split(',').map((s) => s.trim()))]
    .filter((s) => ORDER_STATUSES.includes(s))
    .sort();
  // Пустой или целиком мусорный набор — это не «ничего не считать», а «выбора нет»: падаем на
  // канонический режим, а не показываем ноль, который человек прочитал бы как отсутствие продаж.
  if (picked.length === 0) return 'revenue';
  // Набор, совпавший со всеми статусами, — это режим «все»: короче строка, устойчивее кэш.
  return picked.length === ORDER_STATUSES.length ? 'all' : `status:${picked.join(',')}`;
}

module.exports = {
  SALES_CHANNEL_KEYS,
  ORDER_CHANNEL_KEYS,
  INCLUDE_MODES,
  PRODUCT_FILTER_MAX,
  normalizeCdekChannels,
  normalizeKeySet,
  normalizeOrderChannels,
  normalizeCdekProducts,
  normalizeCdekInclude,
};
