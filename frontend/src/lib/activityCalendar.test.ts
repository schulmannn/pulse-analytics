import { describe, expect, it } from 'vitest';
import { activityLevel, activityQuantiles, buildActivityCalendar } from '@/lib/activityCalendar';

describe('buildActivityCalendar', () => {
  it('keeps a Monday-first 53-week layout across a year boundary', () => {
    const model = buildActivityCalendar(
      [
        { day: '2025-12-31', views: 10 },
        { day: '2026-01-01', views: 20 },
      ],
      new Date(2026, 0, 2, 18, 30),
    );

    expect(model.weeks).toHaveLength(53);
    const yearBoundaryWeek = model.weeks.find((week) => week.days.some((cell) => cell?.day === '2026-01-01'));
    expect(yearBoundaryWeek?.days.map((cell) => cell?.day)).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      undefined,
      undefined,
    ]);
    expect(yearBoundaryWeek?.monthDay).toBe('2026-01-01');
  });

  it('returns an honest empty model when history is absent', () => {
    const model = buildActivityCalendar([], new Date(2026, 6, 13));
    expect(model.hasHistory).toBe(false);
    expect(model.total).toBe(0);
    expect(model.peak).toBeNull();
    expect(model.thresholds).toBeNull();
    expect(model.weeks.flatMap((week) => week.days).filter(Boolean)).toHaveLength(365);
  });

  it('handles one and two observed days without inventing intermediate observations', () => {
    const one = buildActivityCalendar([{ day: '2026-07-13', views: 7 }], new Date(2026, 6, 13));
    expect(one.total).toBe(7);
    expect(one.peak?.day).toBe('2026-07-13');
    expect(one.peak?.level).toBe(4);

    const two = buildActivityCalendar(
      [
        { day: '2026-07-12', views: 2 },
        { day: '2026-07-13', views: 10 },
      ],
      new Date(2026, 6, 13),
    );
    expect(two.total).toBe(12);
    expect(two.weeks.flatMap((week) => week.days).filter((cell) => cell?.value === 0)).toHaveLength(363);
    expect(two.weeks.flatMap((week) => week.days).find((cell) => cell?.day === '2026-07-12')?.level).toBe(1);
    expect(two.peak?.level).toBe(4);
  });
});

describe('activityQuantiles', () => {
  it('uses non-zero p25/p50/p75 so an outlier does not flatten ordinary days', () => {
    const thresholds = activityQuantiles([0, 1, 2, 3, 100]);
    expect(thresholds).toEqual([1.75, 2.5, 27.25]);
    expect([0, 1, 2, 3, 100].map((value) => activityLevel(value, thresholds))).toEqual([0, 1, 2, 3, 4]);
  });
});
