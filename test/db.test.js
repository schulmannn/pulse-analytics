// Тесты чистого трансформа graphsToDailyRows — он питает весь архив истории в
// Postgres (channel_daily), поэтому тихая ошибка здесь молча портит историю.
// Без внешних зависимостей: встроенный node:test + node:assert.
// Запуск: `npm test` (или `node --test`).
const test = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');

// 2026-06-01 / 02 в UTC-миллисекундах (graphs.x приходит в ms-эпохе).
const T1 = Date.UTC(2026, 5, 1);
const T2 = Date.UTC(2026, 5, 2);
const rowOf = (rows, day) => rows.find(r => r.day === day);

test('пустой/недоступный вход → []', () => {
  assert.deepStrictEqual(db.graphsToDailyRows(null), []);
  assert.deepStrictEqual(db.graphsToDailyRows(undefined), []);
  assert.deepStrictEqual(db.graphsToDailyRows({ available: false }), []);
  assert.deepStrictEqual(db.graphsToDailyRows({ available: true }), []); // нет серий → нет строк
});

test('полный набор серий → дневные строки с верными полями', () => {
  const graphs = {
    available: true,
    growth:       { x: [T1, T2], series: [{ name: 'Total', values: [100, 110] }] },
    followers:    { x: [T1, T2], series: [
      { name: 'joined', values: [5, 6] },
      { name: 'left',   values: [1, 2] },
    ] },
    interactions: { x: [T1, T2], series: [
      { name: 'views',  values: [1000, 1200] },
      { name: 'shares', values: [10, 12] },
    ] },
    reactions_daily: { x: [T1, T2], values: [50, 60] },
  };
  const rows = db.graphsToDailyRows(graphs);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rowOf(rows, '2026-06-01'),
    { day: '2026-06-01', subscribers: 100, joins: 5, leaves: 1, views: 1000, forwards: 10, reactions: 50 });
  assert.deepStrictEqual(rowOf(rows, '2026-06-02'),
    { day: '2026-06-02', subscribers: 110, joins: 6, leaves: 2, views: 1200, forwards: 12, reactions: 60 });
});

test('русские имена серий тоже мапятся (joins/leaves, views/forwards)', () => {
  const graphs = {
    available: true,
    followers:    { x: [T1], series: [
      { name: 'Подписки',  values: [7] },
      { name: 'Отписки',   values: [3] },
    ] },
    interactions: { x: [T1], series: [
      { name: 'Просмотры', values: [900] },
      { name: 'Репосты',   values: [9] },
    ] },
  };
  const r = rowOf(db.graphsToDailyRows(graphs), '2026-06-01');
  assert.strictEqual(r.joins, 7);
  assert.strictEqual(r.leaves, 3);
  assert.strictEqual(r.views, 900);
  assert.strictEqual(r.forwards, 9);
});

test('num(): дробное округляется, null/NaN → null', () => {
  const graphs = {
    available: true,
    growth: { x: [T1, T2], series: [{ name: 'Total', values: [110.4, null] }] },
  };
  const rows = db.graphsToDailyRows(graphs);
  assert.strictEqual(rowOf(rows, '2026-06-01').subscribers, 110); // 110.4 → 110
  assert.strictEqual(rowOf(rows, '2026-06-02').subscribers, null); // null → null
});

test('битые timestamp-ы пропускаются, валидные остаются', () => {
  const graphs = {
    available: true,
    growth: { x: ['не-число', T2], series: [{ name: 'Total', values: [1, 2] }] },
  };
  const rows = db.graphsToDailyRows(graphs);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].day, '2026-06-02');
});
