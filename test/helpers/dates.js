'use strict';

// ═══════════════════════════════════════════════════════════════
//  Atlavue — даты в тестах: якорь вместо литералов
// ═══════════════════════════════════════════════════════════════
// ПРАВИЛО. Тест, который проверяет ОКНО (последние N дней, «текущий период», ретеншн), обязан
// считать свои даты от одного якоря — Date.now() на момент прогона, — а не писать '2026-07-01'
// рядом с немокнутым now. Литерал внутри окна работает ровно до того дня, когда окно от него
// уедет: тест зеленеет месяцами и краснеет в случайную дату без единой правки кода.
//
// Литералы остаются законными там, где дата — ЧАСТЬ ФИКСТУРЫ, а не граница окна: разбор строки
// «2025-07-31 15:39:48» из выгрузки СДЭКа, серийное число Excel, ожидаемый формат вывода.
//
// Якорь фиксируется ОДИН раз на файл (`const T = anchor()`), иначе полночь между двумя вызовами
// внутри теста даст разные «сегодня» — та же болезнь, только тоньше.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Момент прогона, снятый один раз. Все даты файла считаются от него. */
function anchor(now = Date.now()) {
  return now;
}

/** Наивный день (YYYY-MM-DD) в UTC со сдвигом от якоря: dayKey(T, -1) — вчера. */
function dayKey(anchorMs, offsetDays = 0) {
  return new Date(anchorMs + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** ISO-момент со сдвигом от якоря в днях (дробные допустимы: -0.5 = 12 часов назад). */
function isoAt(anchorMs, offsetDays = 0) {
  return new Date(anchorMs + offsetDays * DAY_MS).toISOString();
}

/** Ряд последовательных дней [от, до] относительно якоря: days(T, -6, 0) — окно «7 дней». */
function days(anchorMs, fromOffset, toOffset) {
  const out = [];
  for (let d = fromOffset; d <= toOffset; d++) out.push(dayKey(anchorMs, d));
  return out;
}

/** Первый день месяца якоря — граница для месячных свёрток. */
function monthStart(anchorMs, offsetMonths = 0) {
  const d = new Date(anchorMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1))
    .toISOString().slice(0, 10);
}

module.exports = { DAY_MS, anchor, dayKey, isoAt, days, monthStart };
