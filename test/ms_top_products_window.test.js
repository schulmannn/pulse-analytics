'use strict';

// previousWindow из server/lib/msTopProducts.js после PR 2.5 — упаковка над previousWindow домена
// (server/domain/period.js). Строки, которые он отдаёт роуту /api/ms/top-products, — ключ кэша
// loadTopRawCached (periodKey) и moment-границы живого отчёта МС. Их расхождение со старым кодом
// удвоило бы page-loop МС, поэтому здесь они сверяются БАЙТ В БАЙТ со старой реализацией
// (скопирована ниже как оракул) на окнах test/fixtures/period-vectors.json — в зоне процесса и
// в нескольких явных зонах, включая Asia/Tokyo и переходы на летнее время.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { previousWindow } = require('../server/lib/msTopProducts');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'period-vectors.json'), 'utf8'));

// ── Оракул: реализация msTopProducts до PR 2.5, дословно ─────────────────────────────────────
function legacyShift(key, offset) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(y, m - 1, d + offset);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}
function legacyLength(fromKey, toKey) {
  const [fy, fm, fd] = String(fromKey).split('-').map(Number);
  const [ty, tm, td] = String(toKey).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}
function legacyPreviousWindow(sinceDay, untilDay) {
  if (!sinceDay || !untilDay) return null;
  const len = legacyLength(sinceDay, untilDay);
  if (!(len > 0)) return null;
  const prevTo = legacyShift(sinceDay, -1);
  const prevFrom = legacyShift(sinceDay, -len);
  return {
    sinceDay: prevFrom,
    untilDay: prevTo,
    momentFrom: `${prevFrom} 00:00:00`,
    momentTo: `${prevTo} 23:59:59`,
    periodKey: `r:${prevFrom}:${prevTo}`,
  };
}

// Окна из векторов: секции previous и span (span даёт окна через переходы DST и длиной в 730 дней).
const WINDOWS = [
  ...V.previous.map((v) => ({ from: v.from, to: v.to, prevFrom: v.prevFrom, prevTo: v.prevTo })),
  ...V.span.map((v) => ({ from: v.from, to: v.to })),
];

function withTz(zone, fn) {
  const saved = process.env.TZ;
  try {
    if (zone) process.env.TZ = zone;
    fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test('previousWindow МС: форма ответа — periodKey r:prevFrom:prevTo и momentTo «… 23:59:59»', () => {
  for (const v of V.previous) {
    assert.deepEqual(
      previousWindow(v.from, v.to),
      {
        sinceDay: v.prevFrom,
        untilDay: v.prevTo,
        momentFrom: `${v.prevFrom} 00:00:00`,
        momentTo: `${v.prevTo} 23:59:59`,
        periodKey: `r:${v.prevFrom}:${v.prevTo}`,
      },
      `${v.from}…${v.to}`,
    );
  }
});

test('previousWindow МС: байт в байт как до PR 2.5 — в зоне процесса и в явных зонах', () => {
  for (const zone of [null, 'Asia/Tokyo', ...V.zones]) {
    withTz(zone, () => {
      for (const w of WINDOWS) {
        const label = `${w.from}…${w.to} при TZ=${zone || process.env.TZ || '(процесс)'}`;
        const now = previousWindow(w.from, w.to);
        assert.deepEqual(now, legacyPreviousWindow(w.from, w.to), label);
        // Тот же ключ, та же строка — именно по нему loadTopRawCached находит сохранённый отчёт.
        assert.equal(JSON.stringify(now), JSON.stringify(legacyPreviousWindow(w.from, w.to)), label);
      }
    });
  }
});

test('previousWindow МС: «Всё» и перевёрнутое окно — null, как раньше', () => {
  for (const [from, to] of [[null, null], [undefined, '2026-03-10'], ['2026-03-10', null], ['2026-03-10', '2026-03-01']]) {
    assert.equal(previousWindow(from, to), null, `${from}…${to}`);
    assert.equal(legacyPreviousWindow(from, to), null, `оракул ${from}…${to}`);
  }
});
