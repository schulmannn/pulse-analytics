import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasDataWithin,
  inRangeByDays,
  calendarWindowForDays,
  calendarWindowForPeriod,
  endOfLocalDay,
  periodDateTimestamp,
  previousCalendarWindow,
  recommendPeriod,
  resolveEffectivePeriod,
  resolveRequestedWidgetDays,
  splitCalendarRows,
  tgLimit,
  widgetPeriodValue,
} from '@/lib/period';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-03T12:00:00.000Z');
const ago = (days: number) => NOW - days * DAY;

describe('tgLimit', () => {
  it.each([
    [7, 30],
    [30, 60],
    [90, 100],
    [0, 100],
  ] as const)('maps %s days to limit %s', (days, expected) => {
    expect(tgLimit(days)).toBe(expected);
  });
});

describe('inRangeByDays', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts every value for the all-time period', () => {
    expect(inRangeByDays(null, 0)).toBe(true);
    expect(inRangeByDays('not-a-date', 0)).toBe(true);
  });

  it('rejects missing and invalid dates for bounded periods', () => {
    expect(inRangeByDays(null, 30)).toBe(false);
    expect(inRangeByDays(undefined, 30)).toBe(false);
    expect(inRangeByDays('not-a-date', 30)).toBe(false);
  });

  it('includes the exact lower boundary and rejects an older instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'));
    expect(inRangeByDays('2026-05-26T12:00:00.000Z', 30)).toBe(true);
    expect(inRangeByDays('2026-05-26T11:59:59.999Z', 30)).toBe(false);
    expect(inRangeByDays('2026-06-25T12:00:00.000Z', 30)).toBe(true);
  });
});

describe('feed widget period precedence', () => {
  it('uses the page period even when the widget has an older saved override', () => {
    expect(resolveRequestedWidgetDays(30, 7)).toBe(30);
    expect(resolveRequestedWidgetDays(90, 0)).toBe(90);
  });

  it('keeps per-widget periods outside a feed and otherwise uses the default', () => {
    expect(resolveRequestedWidgetDays(null, 7)).toBe(7);
    expect(resolveRequestedWidgetDays(undefined, 0)).toBe(0);
    expect(resolveRequestedWidgetDays(null, undefined)).toBe(30);
  });

  it('applies a page custom range to the widget date predicate', () => {
    const range = {
      from: Date.parse('2026-06-10T00:00:00.000Z'),
      to: Date.parse('2026-06-20T23:59:59.999Z'),
    };
    const period = widgetPeriodValue(30, range);

    expect(period.range).toEqual(range);
    expect(period.inRange('2026-06-10T00:00:00.000Z')).toBe(true);
    expect(period.inRange('2026-06-20T23:59:59.999Z')).toBe(true);
    expect(period.inRange('2026-06-09T23:59:59.999Z')).toBe(false);
    expect(period.inRange(null)).toBe(false);
  });

  it('treats archive day keys as local calendar days instead of UTC instants', () => {
    const from = new Date(2026, 4, 5).getTime();
    const range = { from, to: endOfLocalDay(new Date(2026, 4, 15).getTime()) };
    const period = widgetPeriodValue(30, range);

    expect(periodDateTimestamp('2026-05-05')).toBe(from);
    expect(period.inRange('2026-05-05')).toBe(true);
    expect(period.inRange('2026-05-15')).toBe(true);
    expect(period.inRange('2026-05-04')).toBe(false);
    expect(period.inRange('2026-05-16')).toBe(false);
  });
});

describe('calendar windows', () => {
  const custom = {
    from: Date.parse('2026-06-10T00:00:00.000Z'),
    to: Date.parse('2026-06-12T23:59:59.999Z'),
  };
  const rows = [
    '2026-06-07T00:00:00.000Z',
    '2026-06-08T00:00:00.000Z',
    '2026-06-09T00:00:00.000Z',
    '2026-06-10T00:00:00.000Z',
    '2026-06-11T00:00:00.000Z',
    '2026-06-12T00:00:00.000Z',
  ];

  it('prefers the exact custom range over the days fallback', () => {
    expect(calendarWindowForPeriod(widgetPeriodValue(30, custom), NOW)).toEqual(custom);
    expect(calendarWindowForDays(7, NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW });
    expect(calendarWindowForDays(0, NOW)).toBeNull();
  });

  it('selects an inclusive range and the immediately preceding equal calendar window', () => {
    const selected = splitCalendarRows(rows, custom, (row) => Date.parse(row));
    expect(selected.current).toEqual(rows.slice(3));
    expect(selected.previous).toEqual(rows.slice(0, 3));
  });

  it('exposes the exact preceding bounds used by calendar window comparisons', () => {
    const range = {
      from: new Date(2026, 5, 15).setHours(0, 0, 0, 0),
      to: new Date(2026, 5, 21).setHours(23, 59, 59, 999),
    };
    expect(previousCalendarWindow(range)).toEqual({
      from: new Date(2026, 5, 8).setHours(0, 0, 0, 0),
      to: new Date(2026, 5, 14).setHours(23, 59, 59, 999),
    });
  });

  it('keeps equal local calendar-day windows for bare archive keys', () => {
    const range = {
      from: new Date(2026, 4, 5).getTime(),
      to: endOfLocalDay(new Date(2026, 4, 15).getTime()),
    };
    const archiveDays = Array.from({ length: 22 }, (_, index) => {
      const date = new Date(2026, 3, 24 + index);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${date.getFullYear()}-${month}-${day}`;
    });
    const selected = splitCalendarRows(archiveDays, range, periodDateTimestamp);

    expect(selected.previous).toEqual(archiveDays.slice(0, 11));
    expect(selected.current).toEqual(archiveDays.slice(11));
  });

  it('withholds the comparison when history does not cover the full previous window', () => {
    const selected = splitCalendarRows(rows.slice(1), custom, (row) => Date.parse(row));
    expect(selected.current).toEqual(rows.slice(3));
    expect(selected.previous).toBeNull();
  });

  it('keeps undated rows but marks a bounded series as not windowable', () => {
    expect(splitCalendarRows([1, 2, 3], custom, () => Number.NaN)).toEqual({
      current: [1, 2, 3],
      previous: null,
      windowable: false,
    });
  });
});

describe('hasDataWithin', () => {
  it('is false when recency is unknown (bounded and all-time)', () => {
    expect(hasDataWithin(null, 30, NOW)).toBe(false);
    expect(hasDataWithin(null, 0, NOW)).toBe(false);
  });
  it('treats «Всё» as always in range given any data', () => {
    expect(hasDataWithin(ago(999), 0, NOW)).toBe(true);
  });
  it('accepts data inside the window and rejects older', () => {
    expect(hasDataWithin(ago(3), 7, NOW)).toBe(true);
    expect(hasDataWithin(ago(10), 7, NOW)).toBe(false);
    expect(hasDataWithin(ago(10), 30, NOW)).toBe(true);
  });
});

describe('recommendPeriod', () => {
  it('falls back to the default when recency is unknown', () => {
    expect(recommendPeriod(null, NOW)).toBe(30);
  });
  it('picks the smallest preset covering the newest data', () => {
    expect(recommendPeriod(ago(2), NOW)).toBe(7);
    expect(recommendPeriod(ago(20), NOW)).toBe(30);
    expect(recommendPeriod(ago(80), NOW)).toBe(90);
  });
  it('returns «Всё» (0) once the newest data is older than 90д (the dormant-channel case)', () => {
    expect(recommendPeriod(ago(95), NOW)).toBe(0);
  });
});

describe('resolveEffectivePeriod', () => {
  it('is a no-op when recency is unknown (outside the feed)', () => {
    expect(resolveEffectivePeriod(7, null, NOW)).toBe(7);
  });
  it('keeps the requested window when it holds data', () => {
    expect(resolveEffectivePeriod(7, ago(3), NOW)).toBe(7);
    expect(resolveEffectivePeriod(0, ago(999), NOW)).toBe(0);
  });
  it('widens an empty window to the smallest one with data', () => {
    // requested 7д, newest post 20д old → widen to 30д
    expect(resolveEffectivePeriod(7, ago(20), NOW)).toBe(30);
  });
  it('widens to «Всё» for a dormant channel (all data >90д old)', () => {
    // tydaaya case: pref 7д / 90д, newest post ~95д old → «Всё»
    expect(resolveEffectivePeriod(7, ago(95), NOW)).toBe(0);
    expect(resolveEffectivePeriod(90, ago(95), NOW)).toBe(0);
  });
});
