import { describe, expect, it } from 'vitest';
import type { IgHistoryRow, IgInsights, IgProfile } from '@/api/schemas';
import { archiveOrLive, fmtDay, liveDailySeries, windowIgSeries, windowPair, type Point } from '@/lib/igMetrics';
import { igOverviewCharts, igWindowMetrics, type IgWindowSeries } from '@/lib/igWindowMetrics';

const DAY_MS = 24 * 60 * 60 * 1000;
const baseMs = Date.parse('2026-07-01T00:00:00.000Z');
const day = (i: number) => new Date(baseMs + i * DAY_MS).toISOString().slice(0, 10);
const sum = (vals: number[]) => vals.reduce((acc, value) => acc + value, 0);
const prev = <T,>(vals: T[]) => vals.slice(0, 7);
const cur = <T,>(vals: T[]) => vals.slice(7, 14);

const reachVals = [410, 620, 580, 505, 470, 305, 690, 845, 900, 610, 720, 655, 515, 980];
const viewVals = [980, 454, 463, 471, 467, 380, 417, 845, 381, 691, 314, 250, 242, 166];
const tiVals = [58, 41, 34, 36, 39, 22, 51, 67, 42, 61, 40, 18, 24, 33];
const likeVals = [32, 20, 19, 21, 23, 14, 25, 39, 24, 36, 19, 9, 12, 20];
const saveVals = [8, 7, 5, 4, 5, 3, 6, 9, 7, 8, 5, 2, 3, 5];
const commentVals = [4, 3, 2, 3, 2, 1, 4, 5, 3, 4, 2, 1, 2, 3];
const shareVals = [14, 11, 8, 8, 9, 4, 16, 14, 8, 13, 14, 6, 7, 5];
const followVals = [8, 11, 7, 10, 6, 5, 12, 9, 6, 7, 10, 4, 8, 13];
const unfollowVals = [4, 5, 5, 6, 5, 4, 7, 11, 9, 5, 8, 7, 6, 10];
const followerLevels = [12440, 12446, 12448, 12452, 12453, 12454, 12459, 12457, 12454, 12456, 12458, 12455, 12457, 12460];

function metric(name: string, vals: number[]): NonNullable<IgInsights['data']>[number] {
  return {
    name,
    period: 'day',
    values: vals.map((value, i) => ({ value, end_time: day(i) })),
  };
}

function windowMetric(name: string, previous: number, current: number): NonNullable<IgInsights['data']>[number] {
  return {
    name,
    period: 'day',
    values: [
      { value: previous, end_time: day(6) },
      { value: current, end_time: day(13) },
    ],
  };
}

function fixedRaw() {
  const insights: IgInsights = {
    data: [
      metric('reach', reachVals),
      windowMetric('reach_window', sum(prev(reachVals)), sum(cur(reachVals))),
      metric('views', viewVals),
      metric('total_interactions', tiVals),
      metric('likes', likeVals),
      metric('saves', saveVals),
      metric('comments', commentVals),
      metric('shares', shareVals),
      metric('accounts_engaged', tiVals.map((v) => Math.round(v * 1.5))),
      metric('profile_views', viewVals.map((v) => Math.round(v * 0.1))),
      metric('follows', followVals),
      metric('unfollows', unfollowVals),
      metric('follower_count', followerLevels),
    ],
  };
  const historyRows: IgHistoryRow[] = reachVals.map((reach, i) => ({
    day: day(i),
    followers: followerLevels[i],
    reach,
    views: viewVals[i],
    total_interactions: tiVals[i],
    likes: likeVals[i],
    saves: saveVals[i],
    comments: commentVals[i],
    shares: shareVals[i],
    follows: followVals[i],
    unfollows: unfollowVals[i],
  }));
  const profile: IgProfile = { followers_count: 12460 };
  const since = Date.parse(day(7));
  const until = Date.parse(day(14));
  return { profile, insights, historyRows, since, until };
}

describe('igWindowMetrics', () => {
  it('builds canonical IG window scalars, deltas and daily series from raw payloads', () => {
    const metrics = igWindowMetrics(fixedRaw());
    const reachCur = sum(cur(reachVals));
    const viewsCur = sum(cur(viewVals));
    const tiCur = sum(cur(tiVals));
    const netCur = sum(cur(followVals)) - sum(cur(unfollowVals));

    expect(metrics.pairs.reach.cur).toBe(reachCur);
    expect(metrics.values.reach.previous).toBe(sum(prev(reachVals)));
    expect(metrics.values.views.value).toBe(viewsCur);
    expect(metrics.values.totalInteractions.value).toBe(tiCur);
    expect(metrics.followerNet.cur).toBe(netCur);
    expect(metrics.followersLevel).toBe(12460);
    expect(metrics.erReach).toBe((tiCur / reachCur) * 100);
    expect(metrics.values.views.delta?.dir).toBe('down');
    expect(metrics.daily.followerNet.map((p) => p.value)).toEqual(followVals.map((v, i) => v - unfollowVals[i]));
  });

  it('keeps KPI path equal to narrative daily-window path for reach, followerNet, views and total interactions', () => {
    const metrics = igWindowMetrics(fixedRaw());
    const narrativeReach = windowIgSeries(metrics.daily.reach, 7, 'reach').total;
    const narrativeFollowerNet = windowIgSeries(metrics.daily.followerNet, 7, 'followers').total;
    const narrativeViews = windowIgSeries(metrics.daily.views, 7, 'views').total;
    const narrativeTi = windowIgSeries(metrics.daily.totalInteractions, 7, 'interactions').total;

    expect(metrics.values.reach.value).toBe(narrativeReach);
    expect(metrics.values.followerNet.value).toBe(narrativeFollowerNet);
    expect(metrics.values.views.value).toBe(narrativeViews);
    expect(metrics.values.totalInteractions.value).toBe(narrativeTi);
  });

  it('exposes overviewCharts from the canonical daily series over the active window', () => {
    const metrics = igWindowMetrics(fixedRaw());
    // fixedRaw window = day(7)..day(14): the last 7 daily points (indices 7..13).
    expect(metrics.overviewCharts.views.values).toEqual(viewVals.slice(7));
    expect(metrics.overviewCharts.interactions.values).toEqual(tiVals.slice(7));
    expect(metrics.overviewCharts.engagement.values).toEqual(
      tiVals.slice(7).map((ti, i) => (ti / reachVals.slice(7)[i]) * 100),
    );
  });

  it('uses the explicit mock follower level series when demo mode has no DB history', () => {
    const raw = fixedRaw();
    const metrics = igWindowMetrics({
      ...raw,
      profile: { ...raw.profile, mock: true },
      insights: { ...raw.insights, mock: true },
      historyRows: [],
    });

    expect(metrics.series.followerLevel.map((point) => point.value)).toEqual(followerLevels);
  });

  it('does not treat live follower_count as canonical history for real accounts', () => {
    const raw = fixedRaw();
    const metrics = igWindowMetrics({ ...raw, historyRows: [] });

    expect(metrics.series.followerLevel).toEqual([]);
  });
});

/**
 * The three compact IG Overview sparklines (Просмотры / Взаимодействия / Вовлечённость) build ONLY
 * on the canonical account daily series filtered to the exact active window. Pin: daily ER
 * alignment, sorting/sparse dates, zero/missing reach, exact window filtering and the synthetic-
 * aggregate gate (a 1–2 point total_value aggregate must never pass as a chartable series).
 */
describe('igOverviewCharts', () => {
  const pts = (rows: Array<[string, number]>): Point[] => rows.map(([day, value]) => ({ day, value }));
  const makeSeries = (o: Partial<Record<'views' | 'ti' | 'reach', Point[]>>): IgWindowSeries => {
    const e: Point[] = [];
    return {
      reach: o.reach ?? e, reachWindow: e, views: o.views ?? e, ti: o.ti ?? e, engaged: e,
      follower: e, followerLevel: e, saves: e, likes: e, comments: e, shares: e,
      profileViews: e, follows: e, unfollows: e,
    };
  };
  // Inclusive window [08 .. 14] July 2026 (bounds at UTC midnight, like the daily archive days).
  const SINCE = Date.parse('2026-07-08');
  const UNTIL = Date.parse('2026-07-14');
  const d = (n: number) => `2026-07-${String(n).padStart(2, '0')}`;

  it('daily ER = 100·interactions ÷ reach aligned by calendar day; views/interactions pass through', () => {
    const series = makeSeries({
      views: pts([[d(8), 100], [d(9), 200], [d(10), 300]]),
      ti: pts([[d(8), 10], [d(9), 30], [d(10), 25]]),
      reach: pts([[d(8), 100], [d(9), 200], [d(10), 50]]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.views.values).toEqual([100, 200, 300]);
    expect(c.interactions.values).toEqual([10, 30, 25]);
    // 100·10/100=10, 100·30/200=15, 100·25/50=50
    expect(c.engagement.labels).toEqual([fmtDay(d(8)), fmtDay(d(9)), fmtDay(d(10))]);
    expect(c.engagement.values[0]).toBeCloseTo(10, 10);
    expect(c.engagement.values[1]).toBeCloseTo(15, 10);
    expect(c.engagement.values[2]).toBeCloseTo(50, 10);
  });

  it('aligns full ISO live-reach dates with bare archive interaction days', () => {
    const series = makeSeries({
      ti: pts([[d(8), 10], [d(9), 30], [d(10), 25]]),
      reach: pts([
        [`${d(8)}T07:00:00.000Z`, 100],
        [`${d(9)}T07:00:00.000Z`, 200],
        [`${d(10)}T07:00:00.000Z`, 50],
      ]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.engagement.labels).toEqual([fmtDay(d(8)), fmtDay(d(9)), fmtDay(d(10))]);
    expect(c.engagement.values[0]).toBeCloseTo(10, 10);
    expect(c.engagement.values[1]).toBeCloseTo(15, 10);
    expect(c.engagement.values[2]).toBeCloseTo(50, 10);
  });

  it('sorts oldest→newest and never zero-fills sparse days', () => {
    const series = makeSeries({
      views: pts([[d(12), 300], [d(8), 100], [d(10), 200]]), // out of order, gaps at 09 & 11
      ti: pts([[d(12), 3], [d(8), 1], [d(10), 2]]),
      reach: pts([[d(12), 100], [d(8), 100], [d(10), 100]]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.views.labels).toEqual([fmtDay(d(8)), fmtDay(d(10)), fmtDay(d(12))]);
    expect(c.views.values).toEqual([100, 200, 300]); // exactly three buckets, no filled zeros
    expect(c.engagement.values).toHaveLength(3);
    [1, 2, 3].forEach((expected, i) => {
      expect(c.engagement.values[i]).toBeCloseTo(expected, 10);
    });
  });

  it('engagement skips days without a positive reach or without a real interaction point', () => {
    const series = makeSeries({
      ti: pts([[d(8), 10], [d(9), 20], [d(10), 30], [d(11), 40]]),
      // 09 reach 0 → skip; 11 reach missing → skip; only 08 & 10 survive.
      reach: pts([[d(8), 100], [d(9), 0], [d(10), 50]]),
    });
    const c = igOverviewCharts(series, SINCE, UNTIL);
    expect(c.interactions.values).toEqual([10, 20, 30, 40]); // interactions unaffected by reach
    expect(c.engagement.labels).toEqual([fmtDay(d(8)), fmtDay(d(10))]);
    expect(c.engagement.values[0]).toBeCloseTo(10, 10); // 100·10/100
    expect(c.engagement.values[1]).toBeCloseTo(60, 10); // 100·30/50
  });

  it('filters to the exact active window, dropping points before/after', () => {
    const all = pts([[d(5), 1], [d(6), 2], [d(8), 3], [d(9), 4], [d(14), 5], [d(15), 6]]);
    const series = makeSeries({ views: all, ti: all, reach: all });
    const c = igOverviewCharts(series, SINCE, UNTIL); // keep 08, 09, 14 (14 is the inclusive bound)
    expect(c.views.labels).toEqual([fmtDay(d(8)), fmtDay(d(9)), fmtDay(d(14))]);
    expect(c.views.values).toEqual([3, 4, 5]);
  });

  it('rejects the synthetic total_value aggregate (1 total point or a 2-point prev/cur pair)', () => {
    const single = igOverviewCharts(makeSeries({ views: pts([['total', 5000]]), ti: pts([['total', 800]]) }), SINCE, UNTIL);
    expect(single.views.values).toEqual([]);
    expect(single.interactions.values).toEqual([]);
    // Two real dated points (the shape of the prev/cur aggregate) still fall short of the ≥3
    // canonical minimum → no chart, so the aggregate can't masquerade as a daily series.
    const pair = igOverviewCharts(makeSeries({ views: pts([[d(8), 100], [d(14), 200]]) }), SINCE, UNTIL);
    expect(pair.views.values).toEqual([]);
  });

  it('returns an empty chart when fewer than two canonical points fall inside the window', () => {
    // Canonical series (3 dated points overall), but only one lands in the active window.
    const series = makeSeries({ views: pts([[d(1), 1], [d(2), 2], [d(8), 3]]) });
    expect(igOverviewCharts(series, SINCE, UNTIL).views.values).toEqual([]);
  });
});

describe('igWindowCharts — буквенная ось короткого окна (владелец, 2026-08-14)', () => {
  it('окно ≤ 8 дней: overviewCharts несут axisLabels-буквы, labels остаются датами', () => {
    const metrics = igWindowMetrics(fixedRaw());
    // Окно day(7)..day(14) = 8 дней; в данных 7 точек: 2026-07-08 (среда) … 2026-07-14 (вторник).
    const letters = ['W', 'T', 'F', 'S', 'S', 'M', 'T'];
    expect(metrics.overviewCharts.views.axisLabels).toEqual(letters);
    expect(metrics.overviewCharts.interactions.axisLabels).toEqual(letters);
    expect(metrics.overviewCharts.engagement.axisLabels).toEqual(letters);
    // Полные даты не тронуты — тултип называет день.
    expect(metrics.overviewCharts.views.labels).toHaveLength(7);
    expect(metrics.overviewCharts.views.labels[0]).not.toBe('W');
  });

  it('длинное окно остаётся на датах (axisLabels нет)', () => {
    const raw = fixedRaw();
    const metrics = igWindowMetrics({ ...raw, since: Date.parse('2026-07-01'), until: Date.parse('2026-07-15') });
    expect(metrics.overviewCharts.views.axisLabels).toBeUndefined();
  });
});

// ── Архив ig_daily «как у TG» (OD-13): слияние рядов и архивные окна ─────────────────────────────

describe('archiveOrLive — ряд архивного окна: архив целиком, живой только без архива', () => {
  const archive: Point[] = [{ day: '2026-07-01', value: 10 }, { day: '2026-07-02', value: 20 }];

  it('шов не удваивает день: живая точка, закрывающая последний день архива, в ряд не попадает', () => {
    // Graph штампует дневную точку концом суток по PT (07:00Z СЛЕДУЮЩЕГО UTC-дня): точка за 07-02
    // приходит как 07-03T07:00 — по ключу это «новый» день, хотя значение то же, что в архиве.
    const live: Point[] = [
      { day: '2026-07-02T07:00:00+0000', value: 20 },
      { day: '2026-07-03T07:00:00+0000', value: 20 },
    ];
    const merged = archiveOrLive(archive, live);
    expect(merged.map((p) => p.value)).toEqual([10, 20]);
    expect(merged.reduce((acc, p) => acc + p.value, 0)).toBe(30);
  });

  it('пустой архив — живой ряд как есть (свежее подключение); пропуски не заполняются нулями', () => {
    const live: Point[] = [{ day: '2026-07-01', value: 1 }, { day: '2026-07-04', value: 4 }];
    expect(archiveOrLive([], live)).toEqual(live);
  });

  it('синтетический агрегат окна (total_value) в ряд не попадает никогда', () => {
    const insights: IgInsights = {
      data: [
        { name: 'views', period: 'day', values: [{ value: 100, end_time: day(3) }, { value: 150, end_time: day(10) }], total_value: { value: 150, breakdowns: [] } },
        metric('reach', [1, 2, 3]),
      ],
    };
    expect(liveDailySeries(insights, 'views')).toEqual([]);
    expect(liveDailySeries(insights, 'reach').map((p) => p.value)).toEqual([1, 2, 3]);
  });
});

describe('igWindowMetrics — архивное окно («Всё», свой период)', () => {
  // 540 дней архива с дырой: окно «Всё» обязано дать ТОЧНЫЕ суммы строк, без 90-дневного потолка.
  const N = 540;
  const rows: IgHistoryRow[] = Array.from({ length: N }, (_, i) => ({
    day: day(i - N),
    reach: 100 + (i % 7),
    views: 300 + (i % 5),
    total_interactions: 20 + (i % 3),
    likes: 10,
    follows: 3,
    unfollows: 1,
    accounts_engaged: 50,
  })).filter((_, i) => i !== 100);   // пропуск сбора — не ноль и не строка
  const liveReach = metric('reach', [7, 8, 9]);   // живой хвост: days 0..2 (после архива)
  const reachWindowAgg = windowMetric('reach_window', 111, 222);
  const all = (extra = {}) =>
    igWindowMetrics({
      profile: { followers_count: 500 },
      insights: { data: [liveReach, { ...reachWindowAgg, total_value: { value: 222, breakdowns: [] } }] },
      historyRows: rows,
      since: Date.parse(`${day(-N)}T00:00:00Z`),
      until: Date.parse(`${day(2)}T12:00:00Z`),
      mode: 'archive',
      fromDay: day(-N),
      toDay: day(2),
      ...extra,
    });

  it('суммы — ровно по строкам архива, живой хвост в числа не входит, охват — сумма по дням', () => {
    const m = all();
    expect(m.mode).toBe('archive');
    expect(m.reachBasis).toBe('dailySum');
    expect(m.liveFallback).toBe(false);
    expect(m.pairs.reach.cur).toBe(sum(rows.map((r) => r.reach ?? 0)));
    expect(m.pairs.views.cur).toBe(sum(rows.map((r) => r.views ?? 0)));
    expect(m.pairs.ti.cur).toBe(sum(rows.map((r) => r.total_interactions ?? 0)));
    expect(m.followerNet.cur).toBe(2 * rows.length);
    // ER — на одном основании: Σвзаимодействий ÷ Σохвата по одним и тем же дням.
    expect(m.erReach).toBeCloseTo((sum(rows.map((r) => r.total_interactions ?? 0)) / sum(rows.map((r) => r.reach ?? 0))) * 100, 10);
  });

  it('вовлечённые аккаунты не суммируются, прошлого периода нет, дельт нет', () => {
    const m = all();
    expect(m.pairs.engaged.hasCur).toBe(false);
    for (const pair of Object.values(m.pairs)) {
      expect(pair.hasPrev).toBe(false);
      expect(pair.prevRange ?? null).toBeNull();
    }
    expect(m.values.reach.delta).toBeNull();
    expect(m.values.erReach.delta).toBeNull();
    expect(m.erReachPrev).toBe(0);
  });

  it('свой период — только его календарные дни; окно без архива, но с живым рядом — фолбэк «догружается»', () => {
    const m = all({ fromDay: day(-10), toDay: day(-8) });
    expect(m.pairs.reach.cur).toBe(sum(rows.filter((r) => r.day >= day(-10) && r.day <= day(-8)).map((r) => r.reach ?? 0)));
    const fresh = all({ historyRows: [], fromDay: day(0), toDay: day(2) });
    expect(fresh.liveFallback).toBe(true);
    expect(fresh.pairs.reach.cur).toBe(7 + 8 + 9);
    expect(fresh.pairs.views.hasCur).toBe(false);
  });

  it('пропуск остаётся пропуском: пустое окно — hasCur=false, а не ноль', () => {
    const m = all({ historyRows: [], insights: { data: [] }, fromDay: day(-5), toDay: day(-3) });
    expect(m.pairs.reach.hasCur).toBe(false);
    expect(m.values.reach.hasValue).toBe(false);
    expect(m.erReach).toBe(0);
  });

  it('графики длинного окна прорежены до CHART_MAX_POINTS, а ряд — архив без живого хвоста (OD-8)', () => {
    const m = all();
    expect(m.series.reach.length).toBe(rows.length);
    expect(m.overviewCharts.views.values.length).toBeLessThanOrEqual(140);
    expect(m.overviewCharts.views.values.length).toBeGreaterThan(2);
  });

  it('живой пресет не изменился: агрегат окна остаётся хедлайном охвата', () => {
    const raw = fixedRaw();
    const withAgg: IgInsights = {
      data: [
        ...(raw.insights.data ?? []).filter((m) => m.name !== 'reach_window'),
        { ...windowMetric('reach_window', 1000, 2000), total_value: { value: 2000, breakdowns: [] } },
      ],
    };
    const live = igWindowMetrics({ ...raw, insights: withAgg });
    expect(live.mode).toBe('live');
    expect(live.reachBasis).toBe('window');
    expect(live.pairs.reach.cur).toBe(2000);
    expect(igWindowMetrics(raw).reachBasis).toBe('dailySum');   // без агрегата — честная сумма дневных
  });
});

describe('windowIgSeries — календарные дни, а не последние N точек', () => {
  it('дыра в архиве не утаскивает окно «7 дн.» в 8-й день', () => {
    const pts: Point[] = [0, 1, 2, 3, 4, 6, 7, 8].map((i) => ({ day: day(i), value: 10 + i }));
    const w = windowIgSeries(pts, 7, 'x');
    // окно = day(2)..day(8) (7 календарных дней, day(5) — пропуск): 6 точек, не 7.
    expect(w.values).toEqual([12, 13, 14, 16, 17, 18]);
    expect(w.prevTotal).toBeNull();   // прошлое окно day(-5)..day(1) архивом не покрыто
  });

  it('живые ISO-моменты и дни архива — один календарный ключ', () => {
    const pts: Point[] = [
      { day: day(0), value: 1 },
      { day: `${day(1)}T07:00:00+0000`, value: 2 },
    ];
    expect(windowIgSeries(pts, 7, 'x').total).toBe(3);
  });
});

describe('igWindowMetrics — живой пресет не смешивает архив с живым рядом (ревью)', () => {
  const NOW = Date.parse('2026-09-25T10:00:00Z');
  const key = (n: number) => new Date(NOW - n * DAY_MS).toISOString().slice(0, 10);
  const liveReach = (n: number): NonNullable<IgInsights['data']>[number] => ({
    name: 'reach',
    period: 'day',
    values: Array.from({ length: n }, (_, i) => ({ value: 100, end_time: `${key(n - i - 1)}T07:00:00+0000` })),
  });

  it('короткий архив (догрузка идёт) не обрезает длинный живой ряд графиков', () => {
    const historyRows: IgHistoryRow[] = [1, 2, 3].map((n) => ({ day: key(n), reach: 1 }));
    const m = igWindowMetrics({
      profile: undefined, insights: { data: [liveReach(90)] }, historyRows, since: NOW - 30 * DAY_MS, until: NOW, mode: 'live',
    });
    expect(m.series.reach).toHaveLength(90);
    expect(windowPair(m.series.reach, NOW - 30 * DAY_MS, NOW).cur).toBe(30 * 100);
    expect(m.daily.reach).toHaveLength(90);
  });

  it('длинный архив + живой ряд: день на шве не считается дважды', () => {
    const historyRows: IgHistoryRow[] = Array.from({ length: 120 }, (_, i) => ({ day: key(120 - i), reach: 100 }));
    const m = igWindowMetrics({
      profile: undefined, insights: { data: [liveReach(90)] }, historyRows, since: NOW - 30 * DAY_MS, until: NOW, mode: 'live',
    });
    expect(m.series.reach).toHaveLength(120);
    // Архив кончается вчера (key(1)); живая точка key(0)T07:00 — это тот же вчерашний день по PT.
    expect(m.series.reach.some((p) => p.day.startsWith(key(0)))).toBe(false);
  });
});
