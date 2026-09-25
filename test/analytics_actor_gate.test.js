'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAnalyticsRepo } = require('../server/repos/analyticsRepo');

/**
 * КАЖДЫЙ `*ForActor` СПРАШИВАЕТ ДОСТУП — и, не получив его, НЕ ХОДИТ В БАЗУ.
 *
 * Инвариант репозитория (шапка analyticsRepo): голого un-gated ридера в публичном API нет. Раньше
 * его держали двадцать две одинаковые обёртки, и «забыл allowed()» выглядело как обычная строка —
 * ревью такую пропажу не видит. Гейт переехал в фабрику `gated`, и этот тест сторожит уже её.
 *
 * Почему не интеграционным прогоном: там утечка видна ТОЛЬКО если чужому каналу есть что отдать.
 * Ридер без данных вернёт `[]` и с гейтом, и без него — проверено снятием гейта на одном ридере:
 * интеграционный сweep остался зелёным. Здесь предпосылки нет вовсе: доказательство в том, что
 * при отказе доступа ЗАПРОСА В БАЗУ НЕ БЫЛО.
 */

/** Пул, который считает обращения и на любой запрос отдаёт строку с данными. */
function spyPool() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [{ leaked: 1 }], rowCount: 1 };
    },
  };
}

test('ни один ForActor не идёт в базу, пока доступ не подтверждён', async () => {
  const pool = spyPool();
  const seen = [];
  const repo = createAnalyticsRepo({
    pool,
    enabled: true,
    getAccessibleChannel: async (channelId, actor) => {
      seen.push({ channelId, actor });
      return null; // доступа нет
    },
  });

  const readers = Object.keys(repo).filter((k) => k.endsWith('ForActor')).sort();
  // Пустой обход прошёл бы зелёным ни на чём.
  assert.ok(readers.length >= 22, `ридеров ForActor должно быть не меньше 22, найдено ${readers.length}`);

  for (const name of readers) {
    seen.length = 0;
    pool.calls.length = 0;
    const out = await repo[name](42, { uid: 7 });

    assert.equal(seen.length, 1, `${name} не спросил доступ`);
    assert.deepEqual(seen[0], { channelId: 42, actor: { uid: 7 } }, `${name} спросил доступ не про тот канал`);
    assert.equal(pool.calls.length, 0, `${name} сходил в базу без доступа: ${pool.calls[0]?.text?.slice(0, 120)}`);
    // И отдал пустое — той формы, которую ждёт роут (список, одиночка или объект-оболочка).
    const leaks = (v) =>
      Array.isArray(v) ? v.length > 0
      : typeof v === 'number' ? v > 0
      : v && typeof v === 'object' ? Object.values(v).some(leaks)
      : false;
    assert.ok(!leaks(out), `${name} отдал данные без доступа: ${JSON.stringify(out).slice(0, 160)}`);
  }
});

test('подтверждённый доступ пропускает ридер к базе — иначе «в базу не ходил» ничего не значит', async () => {
  const pool = spyPool();
  const repo = createAnalyticsRepo({
    pool,
    enabled: true,
    getAccessibleChannel: async () => ({ id: 42 }),
  });
  await repo.getChannelHistoryForActor(42, { uid: 7 }, 30);
  assert.equal(pool.calls.length, 1, 'с доступом ридер обязан выполнить запрос');
  assert.ok(pool.calls[0].params.includes(42), 'запрос идёт по запрошенному каналу');
});
