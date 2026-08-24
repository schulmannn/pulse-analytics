'use strict';

// Тесты окна чтения СДЭКа (server/domain/cdekPeriod). Арифметика скучная, но ошибка на день здесь
// не падает и ничем себя не выдаёт — она просто делает дельту на карточке неправильной. Поэтому
// проверяется главное свойство: предыдущее окно ТОЙ ЖЕ длины, вплотную к текущему и без нахлёста.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCdekPeriod, daysBetween, defaultGrain } = require('../server/domain/cdekPeriod');

// Якорь вместо Date.now(): тест на относительных датах ломался бы раз в сутки.
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0); // 2026-07-30

test('пресет: окно заканчивается сегодня, предыдущее — ровно перед ним и той же длины', () => {
  const p = parseCdekPeriod({ days: '30' }, NOW);
  assert.equal(p.to, '2026-07-30');
  assert.equal(p.from, '2026-07-01');
  assert.equal(daysBetween(p.from, p.to), 30);
  assert.equal(p.prevTo, '2026-06-30', 'предыдущее кончается за день до текущего');
  assert.equal(daysBetween(p.prevFrom, p.prevTo), 30, 'и той же длины');
  assert.ok(p.prevTo < p.from, 'нахлёста нет');
});

test('произвольный диапазон: предыдущее окно повторяет его длину', () => {
  const p = parseCdekPeriod({ from: '2026-03-01', to: '2026-03-10' }, NOW);
  assert.equal(p.days, 10);
  assert.equal(p.prevFrom, '2026-02-19');
  assert.equal(p.prevTo, '2026-02-28');
  assert.equal(daysBetween(p.prevFrom, p.prevTo), 10);
  assert.equal(p.custom, true);
});

test('переход через границу года считается календарно, а не «минус 365»', () => {
  const p = parseCdekPeriod({ from: '2026-01-01', to: '2026-01-07' }, NOW);
  assert.equal(p.prevFrom, '2025-12-25');
  assert.equal(p.prevTo, '2025-12-31');
});

test('високосный февраль не теряет день', () => {
  const p = parseCdekPeriod({ from: '2028-03-01', to: '2028-03-05' }, NOW);
  assert.equal(p.prevFrom, '2028-02-25');
  assert.equal(p.prevTo, '2028-02-29', '2028 — високосный');
});

test('«Всё» не выдумывает предыдущее окно', () => {
  // Сравнивать всю историю не с чем: пустая дельта честнее придуманной.
  const p = parseCdekPeriod({ days: '0' }, NOW);
  assert.equal(p.all, true);
  assert.equal(p.from, null);
  assert.equal(p.to, null);
  assert.equal(p.prevFrom, null);
  assert.equal(p.prevTo, null);
});

test('кривой диапазон — invalid, а не тихое расширение до дефолта', () => {
  assert.equal(parseCdekPeriod({ from: '2026-03-10', to: '2026-03-01' }).invalid, true, 'from > to');
  assert.equal(parseCdekPeriod({ from: '10.03.2026', to: '2026-03-11' }).invalid, true, 'не тот формат');
  assert.equal(parseCdekPeriod({ from: '2026-03-01' }).invalid, true, 'половина диапазона');
  assert.equal(parseCdekPeriod({ from: '2026-02-31', to: '2026-03-01' }).invalid, true,
    'Date.UTC переварил бы 31 февраля и молча перенёс на март');
});

test('неизвестный days откатывается к 30, а не падает', () => {
  assert.equal(parseCdekPeriod({ days: '13' }, NOW).days, 30);
  assert.equal(parseCdekPeriod({}, NOW).days, 30);
  assert.equal(parseCdekPeriod({ days: 'нет' }, NOW).days, 30);
});

test('гранулярность по длине окна: при 3 заказах в день длинное окно идёт неделями', () => {
  assert.equal(defaultGrain(7), 'day');
  assert.equal(defaultGrain(31), 'day');
  assert.equal(defaultGrain(90), 'week');
  assert.equal(defaultGrain(180), 'week');
  assert.equal(defaultGrain(365), 'month');
  assert.equal(defaultGrain(0), 'month', '«Всё» — месяцами');
  assert.equal(parseCdekPeriod({ days: '90' }, NOW).grain, 'week');
});

test('явная гранулярность сильнее подобранной', () => {
  assert.equal(parseCdekPeriod({ days: '365', grain: 'day' }, NOW).grain, 'day');
  assert.equal(parseCdekPeriod({ days: '7', grain: 'месяц' }, NOW).grain, 'day', 'мусорный grain игнорируется');
});

test('окно не зависит от часа суток на сервере', () => {
  // Иначе тот же день до и после полудня давал бы разные границы — и разные числа на экране.
  const morning = parseCdekPeriod({ days: '7' }, Date.UTC(2026, 6, 30, 0, 1));
  const night = parseCdekPeriod({ days: '7' }, Date.UTC(2026, 6, 30, 23, 59));
  assert.deepEqual([morning.from, morning.to], [night.from, night.to]);
});
