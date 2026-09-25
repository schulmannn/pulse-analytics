'use strict';

/**
 * Окно чтения СДЭКа и его предыдущее равное окно — тонкая обёртка над domain/period.js.
 *
 * Вся арифметика (строгий календарь, предыдущее окно той же длины вплотную к текущему, явный grain
 * клиента сильнее подобранного) переехала в общий разбор периода. Здесь осталось только то, что
 * принадлежит СДЭКу: его enum пресетов, правило гранулярности по длине окна и нынешняя зона
 * «сегодня» пресета — UTC (так окно считалось до переезда; смена зоны — решение OD-8, не этого
 * модуля). Форма ответа прежняя: роут и репозиторий СДЭКа не заметили переезда.
 */

const { parsePeriod, defaultGrain, daysBetween, shiftDay, dayToMs, msToDay, isDayKey, GRAINS } = require('./period');

const DAYS_ALLOWED = [0, 7, 30, 90, 180, 365];
const DEFAULT_DAYS = 30;

/**
 * Разбор окна из query. Возвращает `{ invalid }` на кривом диапазоне — честный 400 вместо тихого
 * расширения окна до дефолта.
 *
 * `all: true` («Всё») — окно не ограничено И предыдущего окна НЕТ: сравнивать всю историю не с чем,
 * и выдуманная дельта была бы враньём.
 */
function parseCdekPeriod(query = {}, now = Date.now()) {
  const q = query || {};
  // Прежний разбор приводил from/to к строке, а qs превращает `?from[]=2026-03-01` в массив из одного
  // элемента — String() делал из него день, и роут отвечал 200. Общий parsePeriod строже (не строка —
  // не день); до перевода роутов в 2.x обёртка сохраняет прежний ответ, а не 400.
  const legacy = q.from != null || q.to != null ? { ...q, from: String(q.from || ''), to: String(q.to || '') } : q;
  const p = parsePeriod(legacy, {
    now,
    tz: 'UTC',
    allowedDays: DAYS_ALLOWED,
    fallbackDays: DEFAULT_DAYS,
    defaultGrain,
  });
  if (p.invalid) return { invalid: true };
  const out = {
    invalid: false,
    all: p.all,
    days: p.days,
    from: p.from,
    to: p.to,
    prevFrom: p.prevFrom,
    prevTo: p.prevTo,
    grain: p.grain,
  };
  // У «Всё» признака custom не было никогда — форма ответа сохраняется до ключа.
  if (!p.all) out.custom = p.custom;
  return out;
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
