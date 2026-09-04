'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readRetryAfterHeader,
  parseRetryAfterSeconds,
  parseRetryAfterMs,
} = require('../server/lib/retryAfter');

/**
 * Разбор `Retry-After` был скопирован в четыре клиента двумя поколениями (аудит #554), и копии
 * разошлись по смыслу, а не только по форме. Здесь пришпилен общий контракт — включая ровно те
 * два места, где строгий разбор ОТЛИЧАЕТСЯ от прежнего второго поколения.
 */

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00:00Z

/** Ответ-двойник: только то, что нужно читателю заголовка. */
const resWith = (value) => ({ headers: { get: (name) => (name === 'retry-after' ? value : null) } });

test('целые секунды — основная форма по RFC 9110', () => {
  assert.equal(parseRetryAfterSeconds('120', NOW), 120);
  assert.equal(parseRetryAfterSeconds('  7  ', NOW), 7, 'пробелы по краям не мешают');
  assert.equal(parseRetryAfterSeconds('0', NOW), 0, 'ноль — валидная пауза, не «нет значения»');
  assert.equal(parseRetryAfterMs('120', NOW), 120_000);
});

test('HTTP-дата считается от переданных часов, а не от системных', () => {
  const at = new Date(NOW + 90_000).toUTCString();
  assert.equal(parseRetryAfterSeconds(at, NOW), 90);
  // Дата в прошлом — «можно сейчас», а не отрицательная пауза.
  assert.equal(parseRetryAfterSeconds(new Date(NOW - 60_000).toUTCString(), NOW), 0);
});

test('нет значения — null, и вызывающий берёт свой дефолтный бэкофф', () => {
  for (const v of [null, undefined, '', '   ', 'позже', 'NaN']) {
    assert.equal(parseRetryAfterSeconds(v, NOW), null, `«${String(v)}»`);
  }
});

test('строгость: дробное и переполняющее значение больше не притворяются паузой', () => {
  // Прежнее поколение (rusender/ym) считало «1.5» валидным и отдавало 1500 мс — сверх RFC,
  // где delay-seconds это `1*DIGIT`.
  assert.equal(parseRetryAfterMs('1.5', NOW), null);
  // «99999999999999999999» давало 10^22 мс — паузу длиной в вечность вместо честного дефолта.
  assert.equal(parseRetryAfterSeconds('99999999999999999999', NOW), null);
});

test('голое число не проваливается в ветку даты и не даёт «повторяй немедленно»', () => {
  // Ловушка, которая жила во ВСЕХ четырёх копиях: `Date.parse` в V8 читает голое число как дату
  // («-5» → 2001-04-30, «1.5» → 2001-01-04, «+3» → 2001-02-28). Дата в прошлом, `Math.max(0, …)`
  // даёт 0 — и мусорный заголовок означал повтор без паузы.
  for (const v of ['-5', '1.5', '+3', '.5']) {
    assert.equal(Number.isFinite(Date.parse(v)), true, `предпосылка: «${v}» парсится как дата`);
    assert.equal(parseRetryAfterSeconds(v, NOW), null, `«${v}» — не пауза`);
  }
  // При этом настоящая HTTP-дата ветку по-прежнему открывает.
  assert.equal(parseRetryAfterSeconds('Sun, 04 Sep 2026 12:00:30 GMT', NOW), 30);
});

test('чтение заголовка переживает ответ без headers и без get', () => {
  assert.equal(readRetryAfterHeader(resWith('30')), '30');
  assert.equal(readRetryAfterHeader({ headers: {} }), null);
  assert.equal(readRetryAfterHeader({}), null);
  assert.equal(readRetryAfterHeader(null), null);
});

test('секунды и миллисекунды — одно значение в двух единицах', () => {
  for (const v of ['0', '3', '600', 'мусор', null, new Date(NOW + 45_000).toUTCString()]) {
    const seconds = parseRetryAfterSeconds(v, NOW);
    assert.equal(parseRetryAfterMs(v, NOW), seconds == null ? null : seconds * 1000, `«${String(v)}»`);
  }
});
