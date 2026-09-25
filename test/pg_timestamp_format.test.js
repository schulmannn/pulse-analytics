'use strict';

// Формат моментов, которые сервер отдаёт СТРОКОЙ из Postgres (to_char по timestamptz).
//
// Грабли: шаблон to_char '...SSOF' при целочасовом поясе сессии (UTC на Railway, -03 на стенде)
// даёт голый часовой оффсет '+00'/'-03', а V8 такую строку не разбирает: new Date(...) → NaN.
// Отсюда вечный stale=true у collector-status, IG-токен, который никогда не продлевается
// (igTokenState → 'none'), и пустые «обновлён …» во фронте. Канон — 'TZH:TZM' ('+00:00').
// Поведение на реальной БД в четырёх поясах проверяет pg_timestamps.integration.test.js; здесь —
// статический гейт от возврата OF и контракт доменных потребителей на новой форме строки.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { igTokenState, igTokenDueForRefresh } = require('../server/domain/igToken');

const serverDir = path.join(__dirname, '..', 'server');

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listJs(p);
    return /\.(?:c|m)?js$/.test(e.name) ? [p] : [];
  });
}

test('в server/ нет to_char-шаблона с голым оффсетом OF (только TZH:TZM)', () => {
  // HH24:MI:SS + OF (в т.ч. с .MS/.US) — ровно та форма, что даёт '+00'. 'FOR UPDATE OF' не задевает.
  const OF_FORMAT = /HH(?:24|12)?:MI(?::SS(?:\.(?:MS|US))?)?\s*OF(?![A-Za-z])/;
  const offenders = [];
  for (const file of listJs(serverDir)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (OF_FORMAT.test(line)) offenders.push(`${path.relative(serverDir, file)}:${i + 1} → ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `to_char(..., '...OF') отдаёт '+00', JS Date его не парсит:\n${offenders.join('\n')}`);
});

// Строка ровно в форме to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') для заданного оффсета сессии.
function pgTzhTzm(ms, offsetMinutes) {
  const local = new Date(Math.floor(ms / 1000) * 1000 + offsetMinutes * 60 * 1000).toISOString().slice(0, 19);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('pgTzhTzm воспроизводит форму Postgres (сверено с PG16: UTC/Moscow/Bogota/Kolkata)', () => {
  const ts = Date.parse('2026-12-28T10:57:25.123Z');
  assert.equal(pgTzhTzm(ts, 0), '2026-12-28T10:57:25+00:00');
  assert.equal(pgTzhTzm(ts, 180), '2026-12-28T13:57:25+03:00');
  assert.equal(pgTzhTzm(ts, -300), '2026-12-28T05:57:25-05:00');
  assert.equal(pgTzhTzm(ts, 330), '2026-12-28T16:27:25+05:30');
});

for (const offset of [0, 180, -300, 330]) {
  test(`igTokenState/igTokenDueForRefresh понимают срок из БД с оффсетом ${pgTzhTzm(0, offset).slice(19)}`, () => {
    const inWindow = pgTzhTzm(NOW + 5 * DAY, offset);
    assert.equal(igTokenState(inWindow, NOW), 'expiring', inWindow);
    assert.equal(igTokenDueForRefresh(inWindow, NOW), true, inWindow);

    const far = pgTzhTzm(NOW + 40 * DAY, offset);
    assert.equal(igTokenState(far, NOW), 'ok', far);
    assert.equal(igTokenDueForRefresh(far, NOW), false, far);

    const expired = pgTzhTzm(NOW - DAY, offset);
    assert.equal(igTokenState(expired, NOW), 'expired', expired);
    assert.equal(igTokenDueForRefresh(expired, NOW), false, expired);
  });
}

test('GET collector-status: last_success_at в форме Postgres (5 мин назад) → stale=false, 30 ч → stale=true', async (t) => {
  const express = require('express');
  const { registerCollectorRoutes } = require('../server/routes/collector');
  const lastSuccess = new Map();
  const app = express();
  const pass = (_req, _res, next) => next();
  registerCollectorRoutes({
    app,
    express,
    db: {
      enabled: true,
      getChannel: async (id) => ({ id }),
      getCollectorStatus: async (id) => ({ collector_version: '1.0.0', last_success_at: lastSuccess.get(id) }),
    },
    rateLimit: () => pass,
    isReady: () => true,
    requireAuth: (req, _res, next) => { req.user = { uid: 1 }; next(); },
    audit: () => {},
    collectorStaleHours: 24,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = async (id) =>
    (await (await fetch(`http://127.0.0.1:${server.address().port}/api/channels/${id}/collector-status`)).json()).status;

  let id = 0;
  for (const offset of [0, 180, -300, 330]) {
    const fresh = ++id;
    const cold = ++id;
    lastSuccess.set(fresh, pgTzhTzm(Date.now() - 5 * 60 * 1000, offset));
    lastSuccess.set(cold, pgTzhTzm(Date.now() - 30 * 60 * 60 * 1000, offset));
    assert.equal((await get(fresh)).stale, false, lastSuccess.get(fresh));
    assert.equal((await get(cold)).stale, true, lastSuccess.get(cold));
  }
});
