import { describe, expect, it } from 'vitest';
import {
  avgReachWindowDelta,
  avgReachWindows,
  dailyWindowDelta,
  pctDelta,
  splitDailyWindows,
  subscriberBaseline,
  subscriberChange,
  subscriberDelta,
  sumPostWindows,
} from '@/lib/delta';

const DAY = 24 * 60 * 60 * 1000;

describe('subscriberChange', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  const rows = [
    { day: '2026-05-20', subscribers: 5000 },
    { day: '2026-05-26', subscribers: 4950 }, // ~30d baseline
    { day: '2026-06-25', subscribers: 4892 }, // latest
  ];

  it('returns the signed latest-minus-baseline change over the window', () => {
    expect(subscriberChange(rows, 30, now)).toBe(4892 - 4950);
  });

  it('returns null for all-time (days<=0) or when an endpoint is missing', () => {
    expect(subscriberChange(rows, 0, now)).toBeNull();
    expect(subscriberChange([{ day: '2026-06-25', subscribers: 100 }], 30, now)).toBeNull();
  });
});

describe('pctDelta', () => {
  it('returns direction and absolute percentage', () => {
    expect(pctDelta(120, 100)).toEqual({ pct: 20, dir: 'up' });
    expect(pctDelta(75, 100)).toEqual({ pct: 25, dir: 'down' });
    expect(pctDelta(100, 100)).toEqual({ pct: 0, dir: 'flat' });
  });

  it('rejects a missing, zero or invalid baseline', () => {
    expect(pctDelta(10, undefined)).toBeNull();
    expect(pctDelta(10, 0)).toBeNull();
    expect(pctDelta(10, -1)).toBeNull();
    expect(pctDelta(Number.NaN, 10)).toBeNull();
  });
});

describe('sumPostWindows', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');

  it('sums current and previous windows when loaded posts cover both', () => {
    const totals = sumPostWindows(
      [
        { date: '2026-06-23T12:00:00.000Z', views: 100, reactions: 10, forwards: 2, replies: 3 },
        { date: '2026-06-17T12:00:00.000Z', views: 80, reactions: 8, forwards: 1, replies: 1 },
        { date: '2026-06-10T11:59:59.000Z', views: 5, reactions: 1, forwards: 0, replies: 0 },
      ],
      7,
      now,
    );

    expect(totals).toEqual({
      current: { views: 100, reactions: 10, forwards: 2, replies: 3 },
      previous: { views: 80, reactions: 8, forwards: 1, replies: 1 },
      // Границы отдаются ВМЕСТЕ с суммами: подпись под дельтой называет их, и разъехаться с
      // разложением постов они не могут — считаются из тех же currentStart/previousStart.
      ranges: {
        current: { from: now - 7 * DAY, to: now },
        previous: { from: now - 14 * DAY, to: now - 7 * DAY - 1 },
      },
    });
  });

  it('returns null when the loaded set does not reach the previous window start', () => {
    expect(
      sumPostWindows(
        [{ date: '2026-06-20T12:00:00.000Z', views: 100, reactions: 10, forwards: 2, replies: 3 }],
        7,
        now,
      ),
    ).toBeNull();
  });
});

describe('subscriberDelta', () => {
  it('compares the latest point with the point at the period boundary', () => {
    const now = Date.parse('2026-06-25T12:00:00.000Z');
    expect(
      subscriberDelta(
        [
          { day: '2026-05-25', subscribers: 900 },
          { day: '2026-05-26', subscribers: 1_000 },
          { day: '2026-06-25', subscribers: 1_100 },
        ],
        30,
        now,
      ),
    ).toEqual({ pct: 10, dir: 'up' });
  });
});

describe('dailyWindowDelta', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  const rows = [
    { day: '2026-06-24', views: 100 }, // current window
    { day: '2026-06-20', views: 50 }, //  current window
    { day: '2026-06-16', views: 40 }, //  previous window
    { day: '2026-06-12', views: 40 }, //  previous window
  ];

  it('sums a daily metric over current vs previous window', () => {
    // current = 150, previous = 80 → +87.5%
    expect(dailyWindowDelta(rows, (r) => Number(r.views), 7, now)).toEqual({ pct: 87.5, dir: 'up' });
  });

  it('returns null when a window has no data', () => {
    expect(dailyWindowDelta([{ day: '2026-06-24', views: 100 }], (r) => Number(r.views), 7, now)).toBeNull();
    expect(dailyWindowDelta(rows, (r) => Number(r.views), 0, now)).toBeNull(); // all-time
  });

  it('returns the exact rows behind the totals at a non-midnight boundary', () => {
    const pair = splitDailyWindows(
      [
        { day: '2026-06-25', views: 25 },
        { day: '2026-06-19', views: 75 },
        // Midnight is before the rolling 7-day boundary (Jun 18 12:00), so this belongs to
        // the previous window. Keeping that row in the returned slice prevents chart/rail drift.
        { day: '2026-06-18', views: 40 },
        { day: '2026-06-12', views: 60 },
      ],
      (row) => row.views,
      7,
      now,
    );

    expect(pair).not.toBeNull();
    expect(pair?.current.rows.map((row) => row.day)).toEqual(['2026-06-25', '2026-06-19']);
    expect(pair?.previous.rows.map((row) => row.day)).toEqual(['2026-06-18', '2026-06-12']);
    expect(pair?.current.total).toBe(100);
    expect(pair?.previous.total).toBe(100);
    expect(dailyWindowDelta(pair ? [...pair.current.rows, ...pair.previous.rows] : [], (row) => row.views, 7, now))
      .toEqual({ pct: 0, dir: 'flat' });
  });
});

describe('avgReachWindowDelta', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');

  it('compares average views/post across windows', () => {
    // current avg = (100+200)/2 = 150, previous avg = 100/1 = 100 → +50%
    const delta = avgReachWindowDelta(
      [
        { date: '2026-06-24T00:00:00.000Z', views: 100 },
        { date: '2026-06-20T00:00:00.000Z', views: 200 },
        { date: '2026-06-15T00:00:00.000Z', views: 100 },
      ],
      7,
      now,
    );
    expect(delta).toEqual({ pct: 50, dir: 'up' });
  });

  it('returns null when the previous window has no posts', () => {
    expect(
      avgReachWindowDelta([{ date: '2026-06-24T00:00:00.000Z', views: 100 }], 7, now),
    ).toBeNull();
  });
});

describe('avgReachWindows', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  const posts = [
    { date: '2026-06-24T00:00:00.000Z', views: 100 },
    { date: '2026-06-20T00:00:00.000Z', views: 200 },
    { date: '2026-06-15T00:00:00.000Z', views: 100 },
  ];

  it('returns the current and previous average views/post for the paired windows', () => {
    // current avg = (100+200)/2 = 150, previous avg = 100/1 = 100 (feeds the compact two-bar)
    expect(avgReachWindows(posts, 7, now)).toEqual({
      current: 150,
      previous: 100,
      ranges: {
        current: { from: now - 7 * DAY, to: now },
        previous: { from: now - 14 * DAY, to: now - 7 * DAY - 1 },
      },
    });
  });

  it('agrees with avgReachWindowDelta (single source for the delta and the bars)', () => {
    const windows = avgReachWindows(posts, 7, now)!;
    expect(avgReachWindowDelta(posts, 7, now)).toEqual(pctDelta(windows.current, windows.previous));
  });

  it('returns null for all-time or when a window is empty', () => {
    expect(avgReachWindows(posts, 0, now)).toBeNull();
    expect(avgReachWindows([{ date: '2026-06-24T00:00:00.000Z', views: 100 }], 7, now)).toBeNull();
  });
});


/**
 * R2 — ОСНОВАНИЕ ДЕЛЬТЫ. Процент без базы проверить нечем: «↑12.3%» рядом со словом «пред. период»
 * не говорил ни какие это дни, ни какое число взято за единицу. Границы теперь возвращаются рядом
 * с суммами, и здесь пришпилено, что они описывают ИМЕННО ТО разложение, по которому посчитана
 * дельта, а не арифметическое окно рядом с ним.
 *
 * Даты — ОТНОСИТЕЛЬНЫЕ от Date.now() (канон репо, гейт check:clockdrift): литеральные протухают
 * молча, зелёные сегодня и красные через полгода.
 */
describe('R2 — границы окон рядом с суммами', () => {
  const now = Date.now();
  const iso = (offset: number) => new Date(now - offset * DAY).toISOString();
  const key = (offset: number) => iso(offset).slice(0, 10);

  it('прошлое окно постов вплотную к текущему и той же длины', () => {
    const totals = sumPostWindows(
      [
        { date: iso(2), views: 100, reactions: 10, forwards: 2, replies: 3 },
        { date: iso(9), views: 80, reactions: 8, forwards: 1, replies: 1 },
        // выборка должна ДОСТАВАТЬ до начала прошлого окна, иначе сумма занижена и пары нет
        { date: iso(20), views: 1, reactions: 0, forwards: 0, replies: 0 },
      ],
      7,
      now,
    );
    // Полуинтервал: текущее окно ВКЛЮЧАЕТ свою левую границу, прошлое обрывается за миллисекунду
    // до неё — иначе граничный пост попал бы в обе суммы разом.
    expect(totals?.ranges.previous.to).toBe((totals as NonNullable<typeof totals>).ranges.current.from - 1);
    expect(totals?.ranges.previous.from).toBe((totals as NonNullable<typeof totals>).ranges.current.from - 7 * DAY);
  });

  it('границы дневных окон — РЕАЛЬНЫЕ крайние дни архива, а не края окна', () => {
    // Дырявый архив (бэкфилл не дошёл до краёв): арифметическая граница назвала бы дни, которых
    // в сумме нет. Порядок строк намеренно перемешан — сортировки на входе никто не обещал.
    const rows = [
      { day: key(9), views: 4 },
      { day: key(1), views: 5 },
      { day: key(13), views: 4 },
      { day: key(5), views: 5 },
    ];
    const pair = splitDailyWindows(rows, (r) => r.views, 7, now);
    expect(pair?.current.range).toEqual({ from: key(5), to: key(1) });
    expect(pair?.previous.range).toEqual({ from: key(13), to: key(9) });
    // И это те же окна, по которым посчитан процент.
    expect(dailyWindowDelta(rows, (r) => r.views, 7, now)).toEqual(
      pctDelta((pair as NonNullable<typeof pair>).current.total, (pair as NonNullable<typeof pair>).previous.total),
    );
  });

  it('база подписчиков — точка архива, от которой считаются и процент, и «+N»', () => {
    const rows = [
      { day: key(40), subscribers: 4800 },
      { day: key(31), subscribers: 4950 },
      { day: key(1), subscribers: 4892 },
    ];
    // Базовая точка — последняя НЕ ПОЗЖЕ границы окна: 31 день назад, а не самая старая строка.
    expect(subscriberBaseline(rows, 30, now)).toEqual({ day: key(31), subscribers: 4950 });
    expect(subscriberChange(rows, 30, now)).toBe(4892 - 4950);
    expect(subscriberDelta(rows, 30, now)).toEqual(pctDelta(4892, 4950));
    // «Всё» (days<=0) базы не имеет — и подписывать нечего.
    expect(subscriberBaseline(rows, 0, now)).toBeNull();
  });

  it('окна среднего охвата совпадают с окнами постов — одно окно на число и на его подпись', () => {
    const posts = [
      { date: iso(1), views: 100 },
      { date: iso(3), views: 200 },
      { date: iso(9), views: 100 },
      { date: iso(20), views: 1 },
    ];
    const windows = avgReachWindows(posts, 7, now);
    const totals = sumPostWindows(
      posts.map((p) => ({ ...p, reactions: 0, forwards: 0, replies: 0 })),
      7,
      now,
    );
    expect(windows?.ranges).toEqual(totals?.ranges);
  });
});
