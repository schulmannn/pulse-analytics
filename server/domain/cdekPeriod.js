'use strict';

/**
 * Окно чтения СДЭКа и его предыдущее равное окно — чистая арифметика над календарными днями.
 *
 * Вынесено из роута, потому что именно здесь живёт вся тонкость сравнения периодов: предыдущее
 * окно обязано быть ТОЙ ЖЕ длины и заканчиваться ровно за день до текущего. Ошибка на день здесь
 * не падает и не подсвечивается — она просто делает дельту на карточке неправильной.
 *
 * Дни считаются в UTC-полночь: строка «YYYY-MM-DD» здесь не момент времени, а координата
 * календаря. В зону источника её переводит уже SQL (`AT TIME ZONE`), поэтому арифметика не должна
 * зависеть ни от зоны сервера, ни от переходов на летнее время.
 */

const DAY_MS = 86400000;
const DAYS_ALLOWED = [0, 7, 30, 90, 180, 365];
const DEFAULT_DAYS = 30;
const GRAINS = ['day', 'week', 'month'];

const isDayKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** «YYYY-MM-DD» → epoch ms полуночи UTC. Невалидная строка → NaN. */
function dayToMs(key) {
  if (!isDayKey(key)) return NaN;
  const [y, m, d] = key.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  // Date.UTC переваривает 2026-02-31 и тихо переносит на март — сверяем обратным форматированием.
  return msToDay(ms) === key ? ms : NaN;
}

function msToDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const shiftDay = (key, offset) => msToDay(dayToMs(key) + offset * DAY_MS);

/** Число дней в окне включительно. */
const daysBetween = (from, to) => Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS) + 1;

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

/**
 * Разбор окна из query. Возвращает `{ invalid }` на кривом диапазоне — честный 400 вместо тихого
 * расширения окна до дефолта.
 *
 * `all: true` («Всё») — окно не ограничено И предыдущего окна НЕТ: сравнивать всю историю не с чем,
 * и выдуманная дельта была бы враньём.
 */
function parseCdekPeriod(query = {}, now = Date.now()) {
  const rawDays = parseInt(query.days, 10);
  const days = DAYS_ALLOWED.includes(rawDays) ? rawDays : DEFAULT_DAYS;
  const grain = GRAINS.includes(query.grain) ? query.grain : null;

  if (query.from != null || query.to != null) {
    const from = String(query.from || '');
    const to = String(query.to || '');
    if (!isDayKey(from) || !isDayKey(to) || Number.isNaN(dayToMs(from)) || Number.isNaN(dayToMs(to)) || from > to) {
      return { invalid: true };
    }
    const length = daysBetween(from, to);
    return {
      invalid: false,
      all: false,
      days: length,
      from,
      to,
      prevFrom: shiftDay(from, -length),
      prevTo: shiftDay(from, -1),
      grain: grain || defaultGrain(length),
      custom: true,
    };
  }

  if (days === 0) {
    return { invalid: false, all: true, days: 0, from: null, to: null, prevFrom: null, prevTo: null, grain: grain || 'month' };
  }

  const to = msToDay(now);
  const from = shiftDay(to, -(days - 1));
  return {
    invalid: false,
    all: false,
    days,
    from,
    to,
    prevFrom: shiftDay(from, -days),
    prevTo: shiftDay(from, -1),
    grain: grain || defaultGrain(days),
    custom: false,
  };
}

module.exports = {
  parseCdekPeriod,
  defaultGrain,
  daysBetween,
  shiftDay,
  dayToMs,
  msToDay,
  isDayKey,
  DAYS_ALLOWED,
  GRAINS,
};
