'use strict';

/**
 * Окно периода на сервере — одно определение для всех источников (U01, серверная половина).
 *
 * Сюда переехала арифметика окна СДЭКа (domain/cdekPeriod.js стал тонкой обёрткой): строгий
 * календарь, равное предыдущее окно и явный grain клиента сильнее подобранного. Остальные роуты
 * (МойСклад, Метрика, Rusender, упоминания) переходят на тот же разбор отдельными PR — поэтому всё,
 * в чём они сейчас расходятся, здесь ЯВНЫЙ параметр, а не молчаливый дефолт:
 *   - `tz` — зона «сегодня» пресета: 'UTC', 'local' (часы процесса, как у нынешних fmtDay МС/ЯМ и
 *     джоб) или IANA-зона. Выбор зоны по умолчанию — решение владельца (OD-8), поэтому по умолчанию
 *     её нет: без `tz` разбор бросает TypeError, а не угадывает;
 *   - `allowedDays` / `fallbackDays` — узкий enum пресетов источника и откат для незнакомого days;
 *   - `maxRangeDays` — потолок ширины явного окна (нет — не ограничено);
 *   - `defaultGrain` — правило гранулярности по длине окна (нет — grain только явный).
 *
 * Строка «YYYY-MM-DD» здесь не момент времени, а координата календаря: сдвиги и длины считаются в
 * UTC-полночь и не зависят ни от зоны процесса, ни от переходов на летнее время. В зону источника
 * день переводит уже SQL (`AT TIME ZONE`). Зона нужна ровно в одном месте — чтобы назвать
 * «сегодня» пресета, а клиент и это присылает сам точными from/to (msPeriodQuery), поэтому
 * серверное «сегодня» — фолбэк для клиентов без from/to.
 *
 * Те же тест-векторы (test/fixtures/period-vectors.json) читает клиентский lib/periodWindow.ts:
 * клиент и сервер не могут разойтись в окне, прошлом окне и длине.
 */

const DAY_MS = 86400000;
const GRAINS = ['day', 'week', 'month'];
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const BAD_PERIOD = 'bad_period';
const BAD_RANGE_ERROR = 'Некорректный диапазон дат (ожидается from<=to в формате YYYY-MM-DD)';
const wideRangeError = (maxRangeDays) =>
  `Слишком широкий диапазон дат: максимум ${maxRangeDays} дней. Для всей истории выберите период «Всё»`;

const pad2 = (n) => String(n).padStart(2, '0');

/** epoch ms → «YYYY-MM-DD» дня UTC. Не число → null. */
function msToDay(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** «YYYY-MM-DD» → epoch ms полуночи UTC. Невалидная строка → NaN. */
function dayToMs(key) {
  if (typeof key !== 'string' || !DAY_KEY_RE.test(key)) return NaN;
  const [y, m, d] = key.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  // Date.UTC переваривает 2026-02-31 и тихо переносит на март — сверяем обратным форматированием.
  return msToDay(ms) === key ? ms : NaN;
}

/** Строгий day-ключ: формат И настоящая дата календаря (2026-02-31 — не день). */
const isDayKey = (v) => !Number.isNaN(dayToMs(v));

const zoneFormatters = new Map();
function zoneFormatter(tz) {
  let f = zoneFormatters.get(tz);
  if (!f) {
    // Бросает RangeError на незнакомой зоне — это ошибка вызывающего кода, а не пользователя.
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    zoneFormatters.set(tz, f);
  }
  return f;
}

/**
 * Момент (epoch ms или Date) → «YYYY-MM-DD» календарного дня в зоне `tz`: 'UTC', 'local' (часы
 * процесса) или IANA-зона. Зона обязательна — умолчание выбирает OD-8, а не этот модуль.
 */
function fmtDay(at, tz) {
  if (typeof tz !== 'string' || !tz) {
    throw new TypeError("fmtDay: зона дня обязательна ('UTC' | 'local' | IANA)");
  }
  const ms = at instanceof Date ? at.getTime() : Number(at);
  if (!Number.isFinite(ms)) return null;
  if (tz === 'UTC') return msToDay(ms);
  if (tz === 'local') {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const parts = {};
  for (const p of zoneFormatter(tz).formatToParts(ms)) parts[p.type] = p.value;
  return `${String(parts.year).padStart(4, '0')}-${parts.month}-${parts.day}`;
}

/** День, сдвинутый на `offset` календарных дней. Невалидный ключ → null. */
function shiftDay(key, offset) {
  const ms = dayToMs(key);
  return Number.isNaN(ms) ? null : msToDay(ms + offset * DAY_MS);
}

/** Число дней в окне включительно. */
const daysBetween = (from, to) => Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS) + 1;

/**
 * Равное предыдущее окно к включительному [from..to]: той же длины и кончается ровно за день до
 * `from`. Для «Всё» (границ нет) предыдущего окна не существует — null, а не выдуманный диапазон.
 */
function previousWindow(from, to) {
  if (!isDayKey(from) || !isDayKey(to) || from > to) return null;
  const length = daysBetween(from, to);
  return { from: shiftDay(from, -length), to: shiftDay(from, -1) };
}

/**
 * Гранулярность по длине окна. При медиане 3 заказа в день дневные столбцы на окне «Всё»
 * превращаются в частокол шума, поэтому длинные окна по умолчанию идут неделями и месяцами.
 * Явный `grain` от клиента всегда сильнее.
 */
function defaultGrain(days) {
  if (!days || days > 180) return 'month';
  if (days > 31) return 'week';
  return 'day';
}

const badPeriod = (error) => ({ invalid: true, code: BAD_PERIOD, error });

/**
 * Разбор окна из query: пресет `days` ЛИБО точный включительный диапазон `from`/`to`.
 *
 * Возвращает `{ invalid: true, code: 'bad_period', error }` на кривом, перевёрнутом, половинчатом
 * или слишком широком диапазоне — честный 400 вместо тихого расширения окна до дефолта. from/to —
 * только строки: qs-массив (`?from[]=…`) тоже кривой диапазон, строки из него разбор не делает. Иначе:
 *   all       — «Всё»: окно не ограничено И предыдущего окна НЕТ (сравнивать всю историю не с чем);
 *   custom    — true для явного from/to;
 *   days      — длина окна в днях (для явного диапазона — его реальная длина), 0 у «Всё»;
 *   from/to   — включительные дневные границы (null у «Всё»);
 *   prevFrom/prevTo — равное предыдущее окно (null у «Всё»);
 *   tz        — зона, в которой названо «сегодня» пресета;
 *   grain     — явный grain клиента, иначе defaultGrain(days), иначе null;
 *   periodKey — стабильный кэш-токен ('r:from:to' | 'd:days'), как у МойСклада и Метрики.
 */
function parsePeriod(query, options) {
  const {
    now = Date.now(),
    tz,
    allowedDays,
    fallbackDays = 30,
    maxRangeDays = null,
    defaultGrain: grainOf = null,
  } = options || {};
  if (typeof tz !== 'string' || !tz) {
    throw new TypeError("parsePeriod: зона дня обязательна ('UTC' | 'local' | IANA)");
  }
  if (!Array.isArray(allowedDays)) {
    throw new TypeError('parsePeriod: allowedDays обязателен — узкий enum пресетов источника');
  }
  const q = query || {};
  const rawDays = parseInt(q.days, 10);
  const days = allowedDays.includes(rawDays) ? rawDays : fallbackDays;
  const explicitGrain = GRAINS.includes(q.grain) ? q.grain : null;
  const grainFor = (length) => explicitGrain || (grainOf ? grainOf(length) : null);

  if (q.from != null || q.to != null) {
    const { from, to } = q;
    if (!isDayKey(from) || !isDayKey(to) || from > to) return badPeriod(BAD_RANGE_ERROR);
    const length = daysBetween(from, to);
    if (maxRangeDays != null && length > maxRangeDays) return badPeriod(wideRangeError(maxRangeDays));
    const prev = previousWindow(from, to);
    return {
      invalid: false,
      all: false,
      custom: true,
      days: length,
      from,
      to,
      prevFrom: prev.from,
      prevTo: prev.to,
      tz,
      grain: grainFor(length),
      periodKey: `r:${from}:${to}`,
    };
  }

  if (days === 0) {
    return {
      invalid: false,
      all: true,
      custom: false,
      days: 0,
      from: null,
      to: null,
      prevFrom: null,
      prevTo: null,
      tz,
      grain: grainFor(0),
      periodKey: 'd:0',
    };
  }

  const to = fmtDay(now, tz);
  const from = shiftDay(to, -(days - 1));
  const prev = previousWindow(from, to);
  return {
    invalid: false,
    all: false,
    custom: false,
    days,
    from,
    to,
    prevFrom: prev.from,
    prevTo: prev.to,
    tz,
    grain: grainFor(days),
    periodKey: `d:${days}`,
  };
}

/**
 * Границы окна, которые можно материализовать: собственные from/to окна, а у «Всё» — размах
 * архива (`bounds.first_day…bounds.last_day`). Пустой архив у «Всё» → null: придумывать окно нельзя.
 */
function resolveAll(period, bounds) {
  const from = period?.from || bounds?.first_day || null;
  const to = period?.to || bounds?.last_day || null;
  return from && to ? { from, to } : null;
}

module.exports = {
  parsePeriod,
  resolveAll,
  previousWindow,
  defaultGrain,
  isDayKey,
  fmtDay,
  shiftDay,
  daysBetween,
  dayToMs,
  msToDay,
  GRAINS,
  BAD_PERIOD,
};
