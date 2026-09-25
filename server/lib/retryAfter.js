'use strict';

/**
 * `Retry-After` — ОДИН разбор на все апстримы (аудит #554, «шесть источников, три поколения
 * паттернов»).
 *
 * Заголовок разбирали четыре клиента, и разбор разошёлся на два поколения:
 *   • instagramClient и emailService — `parseRetryAfterSeconds(headerValue, nowMs)`, побайтово
 *     одинаковые: строгий `^\d+$`, `Number.isSafeInteger`, часы инъекцией;
 *   • rusenderClient и ymClient — `parseRetryAfter(res)`, тоже побайтово одинаковые: `Number(raw)`
 *     и `Date.now()` внутри.
 *
 * Копии расходились не только формой, но и СМЫСЛОМ. RFC 9110 §10.2.3 знает ровно два вида
 * значения: `delay-seconds` (`1*DIGIT` — целое) и HTTP-дату. Второе поколение принимало сверх
 * этого дробное («1.5» → 1500 мс) и сколь угодно большое («99999999999999999999» → 10^22 мс,
 * то есть пауза длиной в вечность вместо честного дефолтного бэкоффа). Общий разбор строгий,
 * как первое поколение: нестандартное значение больше не притворяется валидной паузой, а честно
 * отдаёт `null`, и вызывающий берёт свой дефолт.
 *
 * Часы всегда параметром: ветка HTTP-даты без этого недетерминирована, и unit-тест на неё
 * приходится писать вокруг реального времени.
 */

/** Заголовок `Retry-After` из ответа — безопасно для любого объекта (в том числе тестового). */
function readRetryAfterHeader(res) {
  const headers = res && res.headers;
  return headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
}

/**
 * `Retry-After` → ЦЕЛЫЕ секунды (≥0), либо null, если заголовка нет или он не по RFC.
 * @param {string|null|undefined} headerValue сырое значение заголовка
 * @param {number} nowMs точка отсчёта для ветки HTTP-даты
 */
function parseRetryAfterSeconds(headerValue, nowMs) {
  if (headerValue == null) return null;
  const s = String(headerValue).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) {
    const seconds = Number(s);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  // Ветка HTTP-даты открывается ТОЛЬКО для строки с буквами. Без этого условия ловушка:
  // `Date.parse` в V8 читает голое число как дату — «-5» это 2001-04-30, «1.5» это 2001-01-04,
  // «+3» это 2001-02-28. Все три в прошлом, `Math.max(0, …)` даёт 0, и мусорный (или враждебный)
  // заголовок превращался в «повторяй немедленно» вместо честного дефолтного бэкоффа. Настоящая
  // HTTP-дата по RFC 9110 §5.6.7 всегда несёт день недели, месяц и GMT — то есть буквы.
  if (!/[A-Za-z]/.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/**
 * То же значение в миллисекундах — форма, в которой его ждут клиенты Rusender и Яндекс.Метрики.
 * Значение НЕ кэпается: cap на 429 применяется только к внутреннему ожиданию, а роут должен
 * получить исходную паузу и честно передать её клиенту.
 */
function parseRetryAfterMs(headerValue, nowMs) {
  const seconds = parseRetryAfterSeconds(headerValue, nowMs);
  return seconds == null ? null : seconds * 1000;
}

module.exports = { readRetryAfterHeader, parseRetryAfterSeconds, parseRetryAfterMs };
