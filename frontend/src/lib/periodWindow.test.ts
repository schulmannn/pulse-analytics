import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { msPeriod, msPeriodBounds, msPreviousPeriod } from './msPeriod';
import {
  PERIOD_DAYS,
  PERIOD_PRESETS,
  baselineWindow,
  dayKeyOf,
  daysBetween,
  defaultGrain,
  endOfLocalDay,
  grainOptions,
  isDayKey,
  periodDateTimestamp,
  periodLabel,
  previousCalendarWindow,
  resolvePeriod,
  shiftDay,
  splitCalendarRows,
  splitWindowRows,
  yearAgoDay,
  type DayZone,
  type Grain,
  type PeriodWindow,
} from './periodWindow';

/**
 * Зеркальные векторы окна (test/fixtures/period-vectors.json) — те же, что читает серверный
 * node --test (test/period_domain.test.js). Прогон идёт при TZ=Europe/Moscow и TZ=America/New_York:
 * зона 'local' — это календарь браузера, и окно, прошлое окно и «сегодня» обязаны совпасть с
 * ожиданиями, посчитанными для этой зоны на сервере.
 */

interface Vectors {
  dayKeys: Array<{ key: unknown; valid: boolean }>;
  shift: Array<{ key: string; offset: number; expected: string }>;
  span: Array<{ from: string; to: string; days: number }>;
  previous: Array<{ from: string; to: string; prevFrom: string; prevTo: string }>;
  yearAgo: Array<{ from: string; to: string; yearFrom: string; yearTo: string }>;
  today: Array<{ now: string; zone: string; day: string }>;
  presets: Array<{
    now: string;
    zone: string;
    days: number;
    includeToday: boolean;
    all: boolean;
    from: string | null;
    to: string | null;
    prevFrom: string | null;
    prevTo: string | null;
  }>;
  grains: Array<{ days: number; defaultGrain: Grain; options: Grain[] }>;
  rows: Array<{
    name: string;
    window: { from: string | null; to: string | null };
    days: string[];
    current: string[];
    previous: string[] | null;
    coverage: 'full' | 'partial' | 'none' | null;
  }>;
}

const V: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../test/fixtures/period-vectors.json', import.meta.url)), 'utf8'),
);

const TIMEZONES = ['Europe/Moscow', 'America/New_York'] as const;
// Смещение в середине января — проверка, что рантайм действительно сменил зону (иначе прогон
// «при TZ=…» молча шёл бы в зоне раннера и ничего не доказывал).
const JANUARY_OFFSET: Record<(typeof TIMEZONES)[number], number> = { 'Europe/Moscow': -180, 'America/New_York': 300 };

const windowOf = (from: string | null, to: string | null): PeriodWindow => ({
  days: from && to ? daysBetween(from, to) : 0,
  all: !(from && to),
  custom: true,
  from,
  to,
});

describe.each(TIMEZONES)('period vectors при TZ=%s', (tz) => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  /** A vector's zone as this runtime can express it: its own IANA zone is `local`, UTC is `UTC`. */
  const zoneOf = (zone: string): DayZone | null => (zone === 'UTC' ? 'UTC' : zone === tz ? 'local' : null);

  it('рантайм действительно в этой зоне', () => {
    expect(new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset()).toBe(JANUARY_OFFSET[tz]);
  });

  it('строгий day-ключ', () => {
    for (const v of V.dayKeys) expect(isDayKey(v.key), JSON.stringify(v.key)).toBe(v.valid);
  });

  it('календарный сдвиг дня не зависит от переходов на летнее время', () => {
    for (const v of V.shift) expect(shiftDay(v.key, v.offset), `${v.key} ${v.offset}`).toBe(v.expected);
    expect(shiftDay('2026-02-31', 1)).toBeNull();
  });

  it('длина окна включительно', () => {
    for (const v of V.span) expect(daysBetween(v.from, v.to), `${v.from}…${v.to}`).toBe(v.days);
  });

  it('предыдущее равное окно кончается накануне начала текущего', () => {
    for (const v of V.previous) {
      const base = baselineWindow(windowOf(v.from, v.to), 'prev');
      expect([base?.from, base?.to], `${v.from}…${v.to}`).toEqual([v.prevFrom, v.prevTo]);
    }
  });

  it('прежний previousCalendarWindow на полных локальных днях даёт те же даты', () => {
    for (const v of V.previous) {
      const prev = previousCalendarWindow({
        from: periodDateTimestamp(v.from),
        to: endOfLocalDay(periodDateTimestamp(v.to)),
      });
      expect(prev && [dayKeyOf(prev.from, 'local'), dayKeyOf(prev.to, 'local')], `${v.from}…${v.to}`).toEqual([
        v.prevFrom,
        v.prevTo,
      ]);
    }
  });

  it('«год назад» — та же календарная дата, 29 фев. → 28 фев.', () => {
    for (const v of V.yearAgo) {
      const base = baselineWindow(windowOf(v.from, v.to), 'year');
      expect([base?.from, base?.to], `${v.from}…${v.to}`).toEqual([v.yearFrom, v.yearTo]);
      expect(yearAgoDay(v.from)).toBe(v.yearFrom);
    }
  });

  it('«сегодня» — день своей зоны: полночь МСК и переходы NY', () => {
    let checked = 0;
    for (const v of V.today) {
      const zone = zoneOf(v.zone);
      if (!zone) continue;
      expect(dayKeyOf(Date.parse(v.now), zone), `${v.now} в ${v.zone}`).toBe(v.day);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('пресет: включительные дни, includeToday и зона — явные параметры', () => {
    let checked = 0;
    for (const v of V.presets) {
      const zone = zoneOf(v.zone);
      if (!zone) continue;
      const now = Date.parse(v.now);
      const window = resolvePeriod({ days: v.days }, { now, includeToday: v.includeToday, zone });
      const base = baselineWindow(window, 'prev');
      const label = `${v.days} дн. на ${v.now} в ${v.zone}, includeToday=${v.includeToday}`;
      expect(window.all, label).toBe(v.all);
      expect([window.from, window.to, base?.from ?? null, base?.to ?? null], label).toEqual([
        v.from,
        v.to,
        v.prevFrom,
        v.prevTo,
      ]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('МойСклад и соседи (msPeriod) — те же окна: сегодня входит, день браузера', () => {
    let checked = 0;
    for (const v of V.presets) {
      if (v.zone !== tz || !v.includeToday) continue;
      const now = Date.parse(v.now);
      const period = msPeriod({ days: v.days as 0 | 7 | 30 | 90, range: null }, now);
      expect(msPeriodBounds(period, now)).toEqual(v.from && v.to ? { from: v.from, to: v.to } : null);
      const previous = msPreviousPeriod(period, now);
      expect(previous && [previous.from, previous.to]).toEqual(v.prevFrom ? [v.prevFrom, v.prevTo] : null);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('гранулярность: доступность и умолчание по длине окна', () => {
    for (const v of V.grains) {
      const options = grainOptions(v.days);
      expect(
        (['day', 'week', 'month'] as Grain[]).filter((grain) => options[grain]),
        `${v.days} дн.`,
      ).toEqual(v.options);
      expect(defaultGrain(v.days), `${v.days} дн.`).toBe(v.defaultGrain);
    }
  });

  it('строки окна и базы: база только при полном покрытии архивом', () => {
    for (const v of V.rows) {
      const split = splitWindowRows(v.days, windowOf(v.window.from, v.window.to), (day) => day);
      expect({ current: split.current, previous: split.previous, coverage: split.coverage }, v.name).toEqual({
        current: v.current,
        previous: v.previous,
        coverage: v.coverage,
      });
    }
  });

  it('прежний splitCalendarRows на полных локальных днях отбирает те же строки', () => {
    for (const v of V.rows) {
      const { from, to } = v.window;
      const dated = v.days.filter((day) => isDayKey(day));
      // Разные по замыслу ветки: у «Всё» и у ряда без дат прежняя функция отдаёт строки как есть.
      if (!from || !to || dated.length === 0) continue;
      const split = splitCalendarRows(
        v.days,
        { from: periodDateTimestamp(from), to: endOfLocalDay(periodDateTimestamp(to)) },
        (day) => periodDateTimestamp(day),
      );
      expect({ current: split.current, previous: split.previous }, v.name).toEqual({
        current: v.current,
        previous: v.previous,
      });
    }
  });
});

describe('PERIOD_PRESETS — единственный список пресетов', () => {
  it('7д / 30д / 90д / Всё в этом порядке', () => {
    expect(PERIOD_PRESETS.map((preset) => [preset.days, preset.label])).toEqual([
      [7, '7д'],
      [30, '30д'],
      [90, '90д'],
      [0, 'Всё'],
    ]);
    expect(PERIOD_DAYS).toEqual([7, 30, 90, 0]);
  });
});

describe('resolvePeriod', () => {
  const now = new Date(2026, 6, 18, 12).getTime();
  const options = { now, includeToday: true, zone: 'local' } as const;

  it('свой период сохраняет точные дни и пресет, на котором стоит', () => {
    const range = { from: new Date(2026, 2, 5).getTime(), to: endOfLocalDay(new Date(2026, 2, 18).getTime()) };
    expect(resolvePeriod({ days: 30, range }, options)).toEqual({
      days: 30,
      all: false,
      custom: true,
      from: '2026-03-05',
      to: '2026-03-18',
    });
  });

  it('«Всё» без границ и без базы', () => {
    const all = resolvePeriod({ days: 0 }, options);
    expect(all).toEqual({ days: 0, all: true, custom: false, from: null, to: null });
    expect(baselineWindow(all, 'prev')).toBeNull();
    expect(baselineWindow(all, 'year')).toBeNull();
  });

  it('без сегодня окно той же длины кончается вчера', () => {
    const w = resolvePeriod({ days: 7 }, { ...options, includeToday: false });
    expect([w.from, w.to]).toEqual(['2026-07-11', '2026-07-17']);
    expect(daysBetween(w.from ?? '', w.to ?? '')).toBe(7);
  });

  it('перевёрнутое окно не выдумывает базу', () => {
    expect(baselineWindow(windowOf('2026-03-10', '2026-03-01'), 'prev')).toBeNull();
  });
});

describe('periodLabel — одна подпись окна', () => {
  it.each([
    [{ days: 30, custom: false }, 'prefixed', 'за 30 дн.'],
    [{ days: 0, custom: false }, 'prefixed', 'за всё время'],
    [{ days: 30, custom: true }, 'prefixed', 'за выбранный период'],
    [{ days: 7, custom: false }, 'bare', '7 дн.'],
    [{ days: 0, custom: false }, 'bare', 'всё время'],
    [{ days: 90, custom: true }, 'bare', 'выбранный период'],
  ] as const)('%o, %s → «%s»', (window, form, expected) => {
    expect(periodLabel(window, form)).toBe(expected);
  });
});

describe('grainOptions — правило TG explorer', () => {
  it('неограниченное окно («Всё», длина неизвестна) разрешает любую гранулярность', () => {
    for (const days of [0, Number.POSITIVE_INFINITY]) {
      expect(grainOptions(days)).toEqual({ day: true, week: true, month: true });
    }
  });
});
