import type { IgHistoryRow, IgInsights, IgProfile } from '@/api/schemas';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { weekdayAxisLabels } from '@/lib/format';
import {
  fmtDay,
  followerLevelSeries,
  hasDailySeries,
  histSeries,
  longerSeries,
  metricSeries,
  netFollowerDaily,
  pairDelta,
  aggregatePair,
  windowPair,
  type Point,
  type WindowPair,
} from '@/lib/igMetrics';

export interface IgWindowRaw {
  profile: IgProfile | undefined;
  insights: IgInsights | undefined;
  historyRows: IgHistoryRow[] | undefined;
  since: number;
  until: number;
}

export interface IgWindowSeries {
  reach: Point[];
  reachWindow: Point[];
  views: Point[];
  ti: Point[];
  engaged: Point[];
  follower: Point[];
  /** Абсолютный уровень базы по дням (якоря followers_total + реконструкция от живого значения). */
  followerLevel: Point[];
  saves: Point[];
  likes: Point[];
  comments: Point[];
  shares: Point[];
  profileViews: Point[];
  follows: Point[];
  unfollows: Point[];
}

export interface IgWindowPairs {
  reach: WindowPair;
  views: WindowPair;
  ti: WindowPair;
  engaged: WindowPair;
  follower: WindowPair;
  saves: WindowPair;
  likes: WindowPair;
  comments: WindowPair;
  shares: WindowPair;
  profileViews: WindowPair;
  follows: WindowPair;
  unfollows: WindowPair;
}

export interface IgWindowScalar {
  value: number;
  previous: number | null;
  delta: MetricDelta | null;
  hasValue: boolean;
  hasPrevious: boolean;
}

export interface IgWindowDaily {
  reach: Point[];
  followerNet: Point[];
  views: Point[];
  totalInteractions: Point[];
  likes: Point[];
  saves: Point[];
}

/** One compact Overview sparkline: ascending day labels (fmtDay) aligned with values. An empty
    chart (`values.length < 2`) means «no canonical daily series» — the card keeps its headline and
    says «Недостаточно дневных данных для графика» instead of drawing. */
export interface IgOverviewChart {
  labels: string[];
  values: number[];
  /** Ось короткого окна (≤ 8 дневных точек): однобуквенные дни недели (fmt.weekday) вместо дат.
      Только подписи ОСИ — `labels` остаются полными датами для тултипа. */
  axisLabels?: string[];
}

export interface IgOverviewCharts {
  /** Daily account views over the exact window. */
  views: IgOverviewChart;
  /** Daily total interactions over the exact window. */
  interactions: IgOverviewChart;
  /** Daily ER = 100·interactions ÷ reach, aligned by calendar day (skips days without a positive
      reach denominator or without a real interaction point). */
  engagement: IgOverviewChart;
}

export interface IgWindowMetrics {
  series: IgWindowSeries;
  pairs: IgWindowPairs;
  daily: IgWindowDaily;
  /** Compact Overview sparklines (views / interactions / engagement), all from the canonical
      account daily series filtered to the active window. */
  overviewCharts: IgOverviewCharts;
  values: {
    reach: IgWindowScalar;
    views: IgWindowScalar;
    totalInteractions: IgWindowScalar;
    likes: IgWindowScalar;
    saves: IgWindowScalar;
    comments: IgWindowScalar;
    shares: IgWindowScalar;
    followerNet: IgWindowScalar;
    followersLevel: IgWindowScalar;
    erReach: IgWindowScalar;
  };
  followerNet: WindowPair;
  followersLevel: number;
  erReach: number;
  erReachPrev: number;
}

const dated = (series: Point[]): Point[] =>
  series.filter((p) => p.day !== 'total' && Number.isFinite(Date.parse(p.day)));

// Minimum real dated samples for a metric to count as a canonical daily series rather than the live
// 1–2 point total_value aggregate (`day:'total'` synthetic + the prev/current pair). Matches the
// viewsHasDaily/tiHasDaily gate (min=3) in useIgData — the compact Overview charts draw ONLY a real
// multi-day series, never the aggregate masquerading as two daily points.
const CHART_CANON_MIN = 3;
const EMPTY_CHART: IgOverviewChart = { labels: [], values: [] };

/** Normalize a dated Graph point and a bare DB archive day to the same UTC calendar key. The live
    reach series uses full ISO `end_time` values, while persisted additive metrics use YYYY-MM-DD;
    comparing the raw strings leaves an otherwise valid daily ER series with no matching dates. */
function canonicalDayKey(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

/** Windowed, ascending daily points: drop the synthetic `total`/non-finite dates, keep only days
    inside [since, until], normalize to a shared calendar key, then sort oldest→newest. */
function windowedDaily(series: Point[], since: number, until: number): Point[] {
  return series
    .flatMap((p) => {
      if (p.day === 'total') return [];
      const t = Date.parse(p.day);
      const day = canonicalDayKey(p.day);
      return Number.isFinite(t) && t >= since && t <= until && day ? [{ day, value: p.value }] : [];
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

// A sparkline needs ≥2 points; fewer → empty (the card says «Недостаточно дневных данных…»).
// Короткое окно (≤ 8 дней) несёт ось буквами дней недели (канон weekdayAxisLabels) — буквы
// только на оси, тултип держит полные даты из `labels`.
const toChart = (points: Point[], windowDays?: number): IgOverviewChart =>
  points.length >= 2
    ? {
        labels: points.map((p) => fmtDay(p.day)),
        values: points.map((p) => p.value),
        axisLabels: weekdayAxisLabels(points.map((p) => p.day), windowDays),
      }
    : EMPTY_CHART;

/**
 * The three compact IG Overview sparklines, all from the canonical account daily series already in
 * the window bundle — never from post-publication metrics that don't reconcile with the account
 * headline. Honest by construction: each needs a real multi-day series (≥3 dated points, so the live
 * total_value aggregate can't pass) AND ≥2 points inside the exact active window, else it returns an
 * empty chart. The graph depends only on the active window, never on previous-window coverage. Not
 * shared with Telegram (its cards carry a separate publication-date series).
 */
export function igOverviewCharts(series: IgWindowSeries, since: number, until: number): IgOverviewCharts {
  const viewsCanon = hasDailySeries(series.views, CHART_CANON_MIN);
  const tiCanon = hasDailySeries(series.ti, CHART_CANON_MIN);
  const tiDaily = tiCanon ? windowedDaily(series.ti, since, until) : [];
  // Длина активного окна в днях — включительные границы [since, until] (см. useIgData).
  const windowDays = Math.round((until - since) / 86_400_000) + 1;

  // ER needs BOTH a real daily interactions series and a real daily reach series. Align by calendar
  // day and keep only days with a positive reach denominator — a day with reach 0 or a missing reach
  // point is skipped (never a divide-by-zero or a fabricated value), matching the canonical erReach
  // «real zero vs missing» decision.
  let engagement = EMPTY_CHART;
  if (tiCanon && hasDailySeries(series.reach, 2)) {
    const reachByDay = new Map<string, number>();
    for (const p of windowedDaily(series.reach, since, until)) reachByDay.set(p.day, p.value);
    const erPoints: Point[] = [];
    for (const p of tiDaily) {
      const reach = reachByDay.get(p.day);
      if (reach != null && reach > 0) erPoints.push({ day: p.day, value: (p.value / reach) * 100 });
    }
    engagement = toChart(erPoints, windowDays);
  }

  return {
    views: viewsCanon ? toChart(windowedDaily(series.views, since, until), windowDays) : EMPTY_CHART,
    interactions: toChart(tiDaily, windowDays),
    engagement,
  };
}

const scalarFromPair = (pair: WindowPair): IgWindowScalar => ({
  value: pair.cur,
  previous: pair.hasPrev ? pair.prev : null,
  delta: pairDelta(pair),
  hasValue: pair.hasCur,
  hasPrevious: pair.hasPrev,
});

export function igWindowMetrics(raw: IgWindowRaw): IgWindowMetrics {
  const { profile, insights, historyRows, since, until } = raw;
  const canonicalFollowerLevel = followerLevelSeries(historyRows, profile?.followers_count ?? null);
  // Demo mode intentionally disables DB history queries. Its fixture exposes an explicit mock
  // follower_count level series so the sample UI can still demonstrate the audience chart; real
  // accounts never take this fallback and remain anchored/reconstructed from ig_daily.
  const mockFollowerLevel = profile?.mock || insights?.mock ? metricSeries(insights, 'follower_count') : [];
  const series: IgWindowSeries = {
    reach: longerSeries(metricSeries(insights, 'reach'), histSeries(historyRows, 'reach')),
    // Deduplicated windowed reach (prev+cur synthetic points from the backend total_value call).
    // Used for headline reach / ER denominator, with daily reach below kept for charts/narrative.
    reachWindow: metricSeries(insights, 'reach_window'),
    // Additive metrics: prefer the longer DB archive over the live synthetic aggregate when present.
    views: longerSeries(metricSeries(insights, 'views'), histSeries(historyRows, 'views')),
    ti: longerSeries(metricSeries(insights, 'total_interactions'), histSeries(historyRows, 'total_interactions')),
    engaged: metricSeries(insights, 'accounts_engaged'),
    // Level series, not gross follows. Kept for existing daily follower charts.
    follower: longerSeries(metricSeries(insights, 'follower_count'), histSeries(historyRows, 'followers')),
    // Настоящий уровень базы (как ТГ «Подписчики»): реальные якоря + реконструкция по net.
    followerLevel: canonicalFollowerLevel.length >= 2 ? canonicalFollowerLevel : mockFollowerLevel,
    saves: longerSeries(metricSeries(insights, 'saves'), histSeries(historyRows, 'saves')),
    likes: longerSeries(metricSeries(insights, 'likes'), histSeries(historyRows, 'likes')),
    comments: longerSeries(metricSeries(insights, 'comments'), histSeries(historyRows, 'comments')),
    shares: longerSeries(metricSeries(insights, 'shares'), histSeries(historyRows, 'shares')),
    profileViews: metricSeries(insights, 'profile_views'),
    // Gross movement endpoints. Window net = follows - unfollows.
    follows: metricSeries(insights, 'follows'),
    unfollows: metricSeries(insights, 'unfollows'),
  };

  // Синтетические агрегаты читаются ПОЗИЦИОННО, а не фильтром по дате: их точки штампуются
  // временем серверного окна и всегда оказываются позже клиентской границы `until` (она округлена
  // вниз до минуты). Прежний date-фильтр выбрасывал текущую точку на каждом рендере — охват молча
  // откатывался на сумму дневных и завышался втрое. См. aggregatePair.
  const reachWin = aggregatePair(insights, 'reach_window');
  const reachDaily = windowPair(series.reach, since, until);
  /** Агрегат окна, если бэкенд его отдал; иначе — прежний путь по дневным. */
  const agg = (name: string, daily: Point[]): WindowPair => {
    const pair = aggregatePair(insights, name);
    return pair.hasCur ? pair : windowPair(daily, since, until);
  };
  const pairs: IgWindowPairs = {
    // Дедуплицированный охват окна — то же число, что Instagram показывает как «Viewers».
    // Сумма дневных остаётся фолбэком для аккаунтов, где Graph агрегат не отдал.
    reach: reachWin.hasCur ? reachWin : reachDaily,
    // Просмотры и взаимодействия аддитивны, поэтому сумма дневных СЕМАНТИЧЕСКИ верна — но дневной
    // архив бывает неполным (пропуски бэкфилла), и тогда он занижает: на проде 235k против 264k у
    // Graph и 272k у самого Instagram. Авторитетным берём агрегат, дневные — фолбэк и график.
    views: agg('views', series.views),
    ti: agg('total_interactions', series.ti),
    engaged: agg('accounts_engaged', series.engaged),
    // follower_count — настоящий ДНЕВНОЙ ряд Graph, а не агрегат: только по дневным.
    follower: windowPair(series.follower, since, until),
    // Составляющие вовлечённости берутся оттуда же, откуда `ti`: смешивать агрегат в сумме с
    // архивом в слагаемых нельзя — разбивка перестала бы сходиться с собственным итогом.
    saves: agg('saves', series.saves),
    likes: agg('likes', series.likes),
    comments: agg('comments', series.comments),
    shares: agg('shares', series.shares),
    profileViews: agg('profile_views', series.profileViews),
    // У follows/unfollows дневного ряда НЕТ вовсе (Graph отдаёт только период), поэтому потерянная
    // текущая точка обнуляла прирост подписчиков целиком.
    follows: agg('follows', series.follows),
    unfollows: agg('unfollows', series.unfollows),
  };

  const followerNet: WindowPair = {
    cur: pairs.follows.cur - pairs.unfollows.cur,
    prev: pairs.follows.prev - pairs.unfollows.prev,
    hasCur: pairs.follows.hasCur || pairs.unfollows.hasCur,
    hasPrev: pairs.follows.hasPrev || pairs.unfollows.hasPrev,
  };
  const followersLevel = profile?.followers_count ?? 0;
  const erReach = pairs.reach.cur > 0 ? (pairs.ti.cur / pairs.reach.cur) * 100 : 0;
  const erReachPrev = pairs.reach.prev > 0 ? (pairs.ti.prev / pairs.reach.prev) * 100 : 0;

  return {
    series,
    pairs,
    overviewCharts: igOverviewCharts(series, since, until),
    daily: {
      reach: dated(series.reach),
      followerNet: dated(netFollowerDaily(historyRows)),
      views: dated(series.views),
      totalInteractions: dated(series.ti),
      likes: dated(series.likes),
      saves: dated(series.saves),
    },
    values: {
      reach: scalarFromPair(pairs.reach),
      views: scalarFromPair(pairs.views),
      totalInteractions: scalarFromPair(pairs.ti),
      likes: scalarFromPair(pairs.likes),
      saves: scalarFromPair(pairs.saves),
      comments: scalarFromPair(pairs.comments),
      shares: scalarFromPair(pairs.shares),
      followerNet: scalarFromPair(followerNet),
      followersLevel: {
        value: followersLevel,
        previous: null,
        delta: null,
        hasValue: profile?.followers_count != null,
        hasPrevious: false,
      },
      erReach: {
        value: erReach,
        previous: erReachPrev > 0 ? erReachPrev : null,
        delta: erReach > 0 && erReachPrev > 0 ? pctDelta(erReach, erReachPrev) : null,
        hasValue: erReach > 0,
        hasPrevious: erReachPrev > 0,
      },
    },
    followerNet,
    followersLevel,
    erReach,
    erReachPrev,
  };
}
