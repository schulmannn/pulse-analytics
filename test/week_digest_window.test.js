'use strict';

// Окна серверного недельного дайджеста после PR 2.5: weekDigest считает их через переходный
// хелпер домена transitionalRollingWindow (скользящие N×24 ч до календарных дней OD-8). Семантика
// не меняется, поэтому здесь закреплены ТОЧНЫЕ границы — ровно на отметке N×24 ч и на миллисекунду
// за ней. Эти тесты зелёные и на коде до PR 2.5: они характеризуют поведение, а не вводят новое.
// Остальная сборка входа — в week_digest.test.js (он не менялся).

const test = require('node:test');
const assert = require('node:assert/strict');

const { assembleWeekInput } = require('../server/lib/weekDigest');
const { transitionalRollingWindow } = require('../server/domain/period');

const DAY_MS = 24 * 60 * 60 * 1000;
// Полночь UTC: Date.parse('YYYY-MM-DD') тоже полночь UTC, поэтому строки дней встают ровно на
// отметки N×24 ч и граница проверяется точно, а не «примерно».
const NOW = Date.parse('2026-07-20T00:00:00.000Z');
const day = (ago) => new Date(NOW - ago * DAY_MS).toISOString().slice(0, 10);
const post = (ms, views = 100) => ({ date_published: new Date(ms).toISOString(), views, reactions: 10, forwards: 0, replies: 0, erv: null });

test('transitionalRollingWindow: начало окна — now − N×24 ч; now явный (число или Date)', () => {
  assert.equal(transitionalRollingWindow(NOW).sinceMs(7), NOW - 7 * DAY_MS);
  assert.equal(transitionalRollingWindow(new Date(NOW)).sinceMs(14), NOW - 14 * DAY_MS);
  assert.equal(transitionalRollingWindow(NOW).nowMs, NOW);
  // Без now — часы процесса (как прежний дефолт assembleWeekInput).
  const before = Date.now();
  const { nowMs } = transitionalRollingWindow();
  assert.ok(nowMs >= before && nowMs <= Date.now());
});

test('дайджест: день ровно на отметке 14×24 ч входит в ряд, день раньше — нет (>=)', () => {
  const daily = [15, 14, 13].map((ago) => ({ day: day(ago), views: ago, subscribers: null }));
  const igDaily = [15, 14, 13].map((ago) => ({ day: day(ago), reach: ago, follows: 0, unfollows: 0 }));
  const input = assembleWeekInput({ daily, posts: [], igDaily }, NOW);
  assert.deepEqual(input.viewsDaily.map((r) => r.day), [day(14), day(13)]);
  assert.deepEqual(input.ig.reachDaily.map((r) => r.day), [day(14), day(13)]);
});

test('дайджест: пост возрастом ровно 7×24 ч — в неделе, на 1 мс старше — нет (возраст <=)', () => {
  const posts = [
    post(NOW - 7 * DAY_MS - 1),
    post(NOW - 7 * DAY_MS),
    post(NOW - 28 * DAY_MS - 1),
    post(NOW - 28 * DAY_MS),
    post(NOW - DAY_MS),
  ];
  const input = assembleWeekInput({ daily: [], posts, igDaily: [] }, NOW);
  assert.equal(input.posts.length, 2, 'неделя: ровно 7×24 ч и сутки назад');
  // База ERV: 4 поста в пределах 28×24 ч включительно (ровно 28×24 ч — внутри), значит avgErv есть.
  assert.equal(input.avgErv, 10);
  const without = assembleWeekInput({ daily: [], posts: posts.slice(0, 1).concat(posts.slice(2, 3)), igDaily: [] }, NOW);
  assert.equal(without.posts.length, 0);
  assert.equal(without.avgErv, null, 'меньше трёх постов в базе');
});

test('дайджест: «неделю назад» — последний уровень не позже now − 7×24 ч включительно (<=)', () => {
  const daily = [8, 7, 6, 0].map((ago, i) => ({ day: day(ago), views: null, subscribers: 1000 + i * 10 }));
  const input = assembleWeekInput({ daily, posts: [], igDaily: [] }, NOW);
  // Уровень ровно на отметке 7×24 ч (1010) — это и есть «неделю назад», не 8-дневный (1000).
  assert.equal(input.subsNow, 1030);
  assert.equal(input.subsD7, 1030 - 1010);
  // Только уровни моложе недели → Δ7д недоступна.
  const young = assembleWeekInput({ daily: daily.slice(2), posts: [], igDaily: [] }, NOW);
  assert.equal(young.subsD7, null);
});
