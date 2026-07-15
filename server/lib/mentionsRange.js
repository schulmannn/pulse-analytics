'use strict';

/**
 * Валидация пользовательского диапазона дат для архива упоминаний (заголовок TG-фида: «Свой период»).
 * Чистая функция без БД: и роут (парсинг query), и репозиторий (санитайз opts.range) зовут одну и ту же
 * проверку, поэтому в SQL попадают ТОЛЬКО реальные календарные даты строгого формата
 * `YYYY-MM-DD` — их безопасно
 * подставлять как date-литералы (та же дисциплина, что у whitelisted-смещений {7,30,90}).
 *
 * Возвращает `{ from, to }` (включительно, from ≤ to) либо `null`, если хотя бы одна граница
 * отсутствует/некорректна. ISO-даты сортируются лексикографически, поэтому сравнение строк корректно
 * определяет from > to без разбора в Date (и без часовых поясов).
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(value) {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseMentionsRange(query) {
  if (!query || typeof query !== 'object') return null;
  const from = query.from;
  const to = query.to;
  if (!isCalendarDay(from) || !isCalendarDay(to)) return null;
  if (from > to) return null;
  return { from, to };
}

/** Число календарных дней в включительном окне [from, to] (для scope.daily_days фронтового zero-fill). */
function rangeDayCount(range) {
  const ms = Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`);
  return Math.round(ms / 86400000) + 1;
}

module.exports = { parseMentionsRange, rangeDayCount };
