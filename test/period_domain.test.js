'use strict';

// Общий серверный разбор окна (server/domain/period.js) против зеркальных векторов
// test/fixtures/period-vectors.json. Те же векторы читает клиентский lib/periodWindow.test.ts, поэтому
// расхождение клиента и сервера в окне, прошлом окне или длине краснит обе суиты сразу.
//
// Ожидаемые значения в векторах посчитаны независимо (Python datetime/zoneinfo), а не этим кодом.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parsePeriod,
  resolveAll,
  previousWindow,
  defaultGrain,
  isDayKey,
  fmtDay,
  shiftDay,
  daysBetween,
  dayToLocalDate,
  BAD_PERIOD,
} = require('../server/domain/period');
const { parseCdekPeriod } = require('../server/domain/cdekPeriod');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'period-vectors.json'), 'utf8'));

const ALLOWED = [0, 7, 30, 90];

test('векторы: строгий day-ключ — формат И настоящая дата календаря', () => {
  for (const v of V.dayKeys) {
    assert.equal(isDayKey(v.key), v.valid, `${JSON.stringify(v.key)}${v.why ? ` (${v.why})` : ''}`);
  }
});

test('векторы: сдвиг дня календарный, DST и границы года/февраля не теряют день', () => {
  for (const v of V.shift) {
    assert.equal(shiftDay(v.key, v.offset), v.expected, `${v.key} ${v.offset > 0 ? '+' : ''}${v.offset}`);
  }
  assert.equal(shiftDay('2026-02-31', 1), null, 'кривой ключ не превращается в «NaN-NaN-NaN»');
});

test('векторы: длина окна включительно', () => {
  for (const v of V.span) assert.equal(daysBetween(v.from, v.to), v.days, `${v.from}…${v.to}`);
});

test('векторы: предыдущее равное окно кончается накануне начала текущего', () => {
  for (const v of V.previous) {
    assert.deepEqual(previousWindow(v.from, v.to), { from: v.prevFrom, to: v.prevTo }, `${v.from}…${v.to}`);
    // Тот же ответ даёт разбор явного окна — одна формула, а не две.
    const p = parsePeriod({ from: v.from, to: v.to }, { tz: 'UTC', allowedDays: ALLOWED });
    assert.deepEqual([p.prevFrom, p.prevTo], [v.prevFrom, v.prevTo], `parsePeriod ${v.from}…${v.to}`);
  }
  assert.equal(previousWindow(null, null), null, '«Всё» не выдумывает прошлое окно');
  assert.equal(previousWindow('2026-03-10', '2026-03-01'), null, 'перевёрнутое окно');
});

test('векторы: «сегодня» названо в явной зоне — полночь МСК и переходы NY на летнее время', () => {
  for (const v of V.today) {
    assert.equal(fmtDay(Date.parse(v.now), v.zone), v.day, `${v.now} в ${v.zone}`);
  }
});

test("векторы: зона 'local' — это часы процесса (как fmtDay МС/ЯМ до переезда)", () => {
  const saved = process.env.TZ;
  try {
    for (const zone of V.zones.filter((z) => z !== 'UTC')) {
      process.env.TZ = zone;
      for (const v of V.today.filter((t) => t.zone === zone)) {
        assert.equal(fmtDay(new Date(Date.parse(v.now)), 'local'), v.day, `${v.now} при TZ=${zone}`);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('dayToLocalDate: местная полночь дня — обратна fmtDay(…, \'local\') в любой зоне процесса', () => {
  const saved = process.env.TZ;
  try {
    for (const zone of [...V.zones, 'Asia/Tokyo']) {
      process.env.TZ = zone;
      for (const v of V.shift) {
        const d = dayToLocalDate(v.key);
        assert.equal(fmtDay(d, 'local'), v.key, `${v.key} при TZ=${zone}`);
        assert.deepEqual([d.getHours(), d.getMinutes()], [0, 0], `${v.key} при TZ=${zone}`);
      }
      // Как прежний parseDay бэкфилла МС: берёт первые 10 символов (moment заказа).
      assert.equal(fmtDay(dayToLocalDate('2026-03-05 14:22:01'), 'local'), '2026-03-05');
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('векторы: пресет — включительные дни до «сегодня» зоны и равное прошлое окно', () => {
  // У сервера окна без сегодня нет — такие векторы проверяет только клиент.
  for (const v of V.presets.filter((p) => p.includeToday)) {
    const p = parsePeriod({ days: String(v.days) }, { now: Date.parse(v.now), tz: v.zone, allowedDays: ALLOWED });
    const label = `${v.days} дн. на ${v.now} в ${v.zone}`;
    assert.equal(p.invalid, false, label);
    assert.equal(p.all, v.all, label);
    assert.deepEqual([p.from, p.to, p.prevFrom, p.prevTo], [v.from, v.to, v.prevFrom, v.prevTo], label);
    assert.equal(p.tz, v.zone);
    assert.equal(p.periodKey, `d:${v.days}`, 'кэш-токен пресета — как у МойСклада и Метрики');
  }
});

test('векторы: гранулярность по длине окна', () => {
  for (const v of V.grains) assert.equal(defaultGrain(v.days), v.defaultGrain, `${v.days} дн.`);
});

test('кривое окно — invalid с кодом bad_period, а не тихое расширение до дефолта', () => {
  const opts = { tz: 'UTC', allowedDays: ALLOWED };
  for (const [query, why] of [
    [{ from: '2026-03-10', to: '2026-03-01' }, 'from > to'],
    [{ from: '10.03.2026', to: '2026-03-11' }, 'не тот формат'],
    [{ from: '2026-03-01' }, 'половина диапазона'],
    [{ to: '2026-03-01' }, 'другая половина'],
    [{ from: '', to: '' }, 'пустые границы'],
    [{ from: ['2026-03-01', '2026-03-02'], to: '2026-03-05' }, 'повтор параметра (массив)'],
    [{ from: ['2026-03-01'], to: '2026-03-05' }, 'qs-массив из одного элемента — не строка'],
    [{ from: '2026-02-31', to: '2026-03-01' }, 'несуществующая дата'],
  ]) {
    const p = parsePeriod(query, opts);
    assert.equal(p.invalid, true, why);
    assert.equal(p.code, BAD_PERIOD, why);
    assert.match(p.error, /Некорректный диапазон дат/, why);
  }
});

test('потолок ширины — параметр источника; без него окно не ограничено', () => {
  const wide = { from: '2025-01-01', to: '2026-02-05' }; // 401 день
  assert.equal(daysBetween(wide.from, wide.to), 401);
  const capped = parsePeriod(wide, { tz: 'UTC', allowedDays: ALLOWED, maxRangeDays: 400 });
  assert.equal(capped.invalid, true);
  assert.equal(capped.code, BAD_PERIOD);
  assert.equal(capped.error, 'Слишком широкий диапазон дат: максимум 400 дней. Для всей истории выберите период «Всё»');
  const edge = parsePeriod({ from: '2025-01-01', to: '2026-02-04' }, { tz: 'UTC', allowedDays: ALLOWED, maxRangeDays: 400 });
  assert.equal(edge.invalid, false, 'ровно 400 дней — ещё можно');
  assert.equal(parsePeriod(wide, { tz: 'UTC', allowedDays: ALLOWED }).invalid, false);
});

test('явное окно: реальная длина, custom, кэш-токен r:from:to', () => {
  const p = parsePeriod({ days: '7', from: '2026-03-01', to: '2026-03-10' }, { tz: 'UTC', allowedDays: ALLOWED });
  assert.deepEqual(
    { all: p.all, custom: p.custom, days: p.days, from: p.from, to: p.to, periodKey: p.periodKey },
    { all: false, custom: true, days: 10, from: '2026-03-01', to: '2026-03-10', periodKey: 'r:2026-03-01:2026-03-10' },
  );
});

test('«Всё»: без границ и без прошлого окна', () => {
  const p = parsePeriod({ days: '0' }, { tz: 'UTC', allowedDays: ALLOWED });
  assert.deepEqual(
    [p.all, p.custom, p.days, p.from, p.to, p.prevFrom, p.prevTo, p.periodKey],
    [true, false, 0, null, null, null, null, 'd:0'],
  );
});

test('enum пресетов и откат — параметры источника', () => {
  const now = Date.UTC(2026, 6, 30, 12);
  assert.equal(parsePeriod({ days: '13' }, { now, tz: 'UTC', allowedDays: ALLOWED }).days, 30, 'дефолтный откат — 30');
  assert.equal(parsePeriod({}, { now, tz: 'UTC', allowedDays: ALLOWED }).days, 30);
  // Упоминания исторически откатывают незнакомый days во «Всё» — это их явный параметр.
  const legacy = parsePeriod({ days: '13' }, { now, tz: 'UTC', allowedDays: ALLOWED, fallbackDays: 0 });
  assert.equal(legacy.all, true);
  assert.equal(parsePeriod({ days: '180' }, { now, tz: 'UTC', allowedDays: [0, 7, 30, 90, 180] }).days, 180);
});

test('grain: явный сильнее подобранного; без правила источника — только явный', () => {
  const opts = { tz: 'UTC', allowedDays: ALLOWED, defaultGrain };
  assert.equal(parsePeriod({ days: '90' }, opts).grain, 'week');
  assert.equal(parsePeriod({ days: '90', grain: 'day' }, opts).grain, 'day');
  assert.equal(parsePeriod({ days: '7', grain: 'месяц' }, opts).grain, 'day', 'мусорный grain игнорируется');
  assert.equal(parsePeriod({ days: '0' }, opts).grain, 'month');
  assert.equal(parsePeriod({ days: '90' }, { tz: 'UTC', allowedDays: ALLOWED }).grain, null);
  assert.equal(parsePeriod({ days: '90', grain: 'month' }, { tz: 'UTC', allowedDays: ALLOWED }).grain, 'month');
});

test('зона дня и enum пресетов — обязательные параметры: умолчание выбирает OD-8, а не модуль', () => {
  assert.throws(() => parsePeriod({ days: '7' }, { allowedDays: ALLOWED }), TypeError);
  assert.throws(() => parsePeriod({ days: '7' }, { tz: 'UTC' }), TypeError);
  assert.throws(() => fmtDay(Date.now()), TypeError);
  assert.throws(() => fmtDay(Date.now(), 'Mars/Olympus'), RangeError);
  assert.equal(fmtDay(Number.NaN, 'UTC'), null);
});

test('resolveAll: «Всё» материализуется размахом архива, пустой архив — null', () => {
  const all = parsePeriod({ days: '0' }, { tz: 'UTC', allowedDays: ALLOWED });
  const bounds = { first_day: '2025-11-03', last_day: '2026-07-29' };
  assert.deepEqual(resolveAll(all, bounds), { from: '2025-11-03', to: '2026-07-29' });
  assert.equal(resolveAll(all, null), null);
  assert.equal(resolveAll(all, { first_day: null, last_day: null }), null);
  assert.equal(resolveAll(all, { first_day: '2025-11-03', last_day: null }), null, 'половина размаха — не окно');
  const bounded = parsePeriod({ from: '2026-03-01', to: '2026-03-10' }, { tz: 'UTC', allowedDays: ALLOWED });
  assert.deepEqual(resolveAll(bounded, bounds), { from: '2026-03-01', to: '2026-03-10' }, 'своё окно сильнее архива');
});

// ── СДЭК: обёртка обязана отвечать ровно как до переезда ────────────────────────────────────────
// Эталон — дословная копия parseCdekPeriod ДО выноса в domain/period.js. Сверка по сетке входов
// ловит любую разницу формы ответа (лишний ключ, другой grain, сдвиг окна), а не только чисел.
function legacyParseCdekPeriod(query = {}, now = Date.now()) {
  const DAY_MS = 86400000;
  const DAYS_ALLOWED = [0, 7, 30, 90, 180, 365];
  const GRAINS = ['day', 'week', 'month'];
  const legacyIsDayKey = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const msToDay = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  };
  const dayToMs = (key) => {
    if (!legacyIsDayKey(key)) return NaN;
    const [y, m, d] = key.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d);
    return msToDay(ms) === key ? ms : NaN;
  };
  const shift = (key, offset) => msToDay(dayToMs(key) + offset * DAY_MS);
  const between = (from, to) => Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS) + 1;
  const grainOf = (days) => (!days || days > 180 ? 'month' : days > 31 ? 'week' : 'day');

  const rawDays = parseInt(query.days, 10);
  const days = DAYS_ALLOWED.includes(rawDays) ? rawDays : 30;
  const grain = GRAINS.includes(query.grain) ? query.grain : null;
  if (query.from != null || query.to != null) {
    const from = String(query.from || '');
    const to = String(query.to || '');
    if (!legacyIsDayKey(from) || !legacyIsDayKey(to) || Number.isNaN(dayToMs(from)) || Number.isNaN(dayToMs(to)) || from > to) {
      return { invalid: true };
    }
    const length = between(from, to);
    return {
      invalid: false, all: false, days: length, from, to,
      prevFrom: shift(from, -length), prevTo: shift(from, -1), grain: grain || grainOf(length), custom: true,
    };
  }
  if (days === 0) {
    return { invalid: false, all: true, days: 0, from: null, to: null, prevFrom: null, prevTo: null, grain: grain || 'month' };
  }
  const to = msToDay(now);
  const from = shift(to, -(days - 1));
  return {
    invalid: false, all: false, days, from, to,
    prevFrom: shift(from, -days), prevTo: shift(from, -1), grain: grain || grainOf(days), custom: false,
  };
}

test('СДЭК: parseCdekPeriod после переезда отвечает ровно как до него', () => {
  const nows = [...new Set([
    ...V.today.map((v) => Date.parse(v.now)),
    ...V.presets.map((v) => Date.parse(v.now)),
    Date.UTC(2026, 6, 30, 0, 1),
    Date.UTC(2026, 6, 30, 23, 59),
  ])];
  const dayValues = [undefined, '', '0', '7', '13', '30', '90', '180', '365', '400', 'нет', '30abc', '-7'];
  const grains = [undefined, 'day', 'week', 'month', 'месяц', ''];
  const ranges = [
    {},
    ...V.previous.map((v) => ({ from: v.from, to: v.to })),
    ...V.span.map((v) => ({ from: v.from, to: v.to })),
    { from: '2026-03-10', to: '2026-03-01' },
    { from: '2026-02-31', to: '2026-03-01' },
    { from: '2026-03-01', to: '2026-02-29' },
    { from: '2026-03-01' },
    { to: '2026-03-01' },
    { from: '', to: '' },
    { from: '10.03.2026', to: '2026-03-11' },
    { from: ['2026-03-01', '2026-03-02'], to: '2026-03-05' },
    // Массив из одного элемента (прямой вызов или extended-qs Express 4); прежний String() делал из него день.
    { from: ['2026-03-01'], to: '2026-03-05' },
    { from: ['2026-03-01'], to: ['2026-03-05'] },
    { from: [['2026-03-01']], to: '2026-03-05' },
    { from: 20260301, to: '2026-03-05' },
    { from: '2024-01-01', to: '2026-07-30' },
  ];
  let checked = 0;
  for (const now of nows) {
    for (const days of dayValues) {
      for (const grain of grains) {
        for (const range of ranges) {
          const query = { ...range };
          if (days !== undefined) query.days = days;
          if (grain !== undefined) query.grain = grain;
          assert.deepStrictEqual(parseCdekPeriod(query, now), legacyParseCdekPeriod(query, now), JSON.stringify({ query, now }));
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 10000, `сверено ${checked} входов`);
});
