import type { IgHistoryRow, IgInsights, IgProfile } from '@/api/schemas';
import { prepareChartSeries } from '@/lib/chartSeries';
import { pctDelta, type MetricDelta, type WindowRange } from '@/lib/delta';
import { timeAxisLabels } from '@/lib/format';
import type { IgWindowMode } from '@/lib/igArchiveWindow';
import {
  canonicalDayKey,
  fmtDay,
  followerLevelSeries,
  hasDailySeries,
  archiveOrLive,
  histSeries,
  liveDailySeries,
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
  /**
   * Границы прошлого окна СЕРВЕРНЫХ агрегатов (`total_value`). Сервер режет их сам по `days`
   * запроса и снапит его к 7/30/90 (server/routes/ig.js), поэтому клиентские `since/until`
   * совпадают с ними только на ПРЕСЕТНОМ окне — на «своём периоде» серверное окно другое, и
   * подписывать агрегат клиентскими датами значило бы назвать не те дни. Вызывающий передаёт
   * границы только там, где они доказуемо те же, иначе `null` — и подписи не будет вовсе.
   */
  aggPrevRange?: WindowRange | null;
  /**
   * Режим окна (lib/igArchiveWindow): `live` — пресет 7/30/90, числа из серверных агрегатов, как
   * было; `archive` — «Всё» и свой период, числа — суммы строк архива ig_daily по календарным дням
   * [fromDay..toDay]. По умолчанию live.
   */
  mode?: IgWindowMode;
  /** Календарные границы архивного окна `YYYY-MM-DD` (включительно; `fromDay: null` — без начала). */
  fromDay?: string | null;
  toDay?: string | null;
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

/** Как посчитан охват окна: дедуплицированный агрегат Graph или сумма дневных (архивное окно,
    фолбэк без агрегата) — последнюю честно подписывают «сумма по дням». */
export type IgReachBasis = 'window' | 'dailySum';

export interface IgWindowMetrics {
  mode: IgWindowMode;
  reachBasis: IgReachBasis;
  /** Архивное окно без единой точки архива — числа от живых дневных рядов (свежее подключение). */
  liveFallback: boolean;
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

/** Windowed, ascending daily points: drop the synthetic `total`/non-finite dates, keep only days
    inside [since, until], normalize to a shared calendar key, then sort oldest→newest. */
/** Окно графика: по моменту [since, until] (пресет) либо по календарному ключу (архивное окно). */
export type IgChartWindow = { since: number; until: number; inDay?: (day: string) => boolean };

function windowedDaily(series: Point[], win: IgChartWindow): Point[] {
  return series
    .flatMap((p) => {
      if (p.day === 'total') return [];
      const t = Date.parse(p.day);
      const day = canonicalDayKey(p.day);
      if (!day || !Number.isFinite(t)) return [];
      const inside = win.inDay ? win.inDay(day) : t >= win.since && t <= win.until;
      return inside ? [{ day, value: p.value }] : [];
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

// A sparkline needs ≥2 points; fewer → empty (the card says «Недостаточно дневных данных…»).
// Короткое окно (≤ 8 дней) несёт ось буквами дней недели (канон timeAxisLabels) — буквы
// только на оси, тултип держит полные даты из `labels`.
// Длинное окно (архив «Всё», свой период на годы) — через общую политику прореживания
// prepareChartSeries (кап CHART_MAX_POINTS, LTTB у линии без пропусков): иначе сотни точек в
// карточке — суб-пиксельная мазня. Короткий ряд она не трогает, подписи остаются нашими.
function toChart(points: Point[], windowDays?: number): IgOverviewChart {
  if (points.length < 2) return EMPTY_CHART;
  const { sampledIdx } = prepareChartSeries({ points, viz: 'line', kind: 'flow', unit: 'number' });
  const shown = sampledIdx.flatMap((i) => {
    const point = points[i];
    return point ? [point] : [];
  });
  return {
    labels: shown.map((p) => fmtDay(p.day)),
    values: shown.map((p) => p.value),
    axisLabels: timeAxisLabels(shown.map((p) => p.day), windowDays),
  };
}

/**
 * The three compact IG Overview sparklines, all from the canonical account daily series already in
 * the window bundle — never from post-publication metrics that don't reconcile with the account
 * headline. Honest by construction: each needs a real multi-day series (≥3 dated points, so the live
 * total_value aggregate can't pass) AND ≥2 points inside the exact active window, else it returns an
 * empty chart. The graph depends only on the active window, never on previous-window coverage. Not
 * shared with Telegram (its cards carry a separate publication-date series).
 */
export function igOverviewCharts(
  series: IgWindowSeries,
  since: number,
  until: number,
  inDay?: (day: string) => boolean,
): IgOverviewCharts {
  const win: IgChartWindow = { since, until, inDay };
  const viewsCanon = hasDailySeries(series.views, CHART_CANON_MIN);
  const tiCanon = hasDailySeries(series.ti, CHART_CANON_MIN);
  const tiDaily = tiCanon ? windowedDaily(series.ti, win) : [];
  // Длина активного окна в днях — включительные границы [since, until] (см. useIgData).
  const windowDays = Math.round((until - since) / 86_400_000) + 1;

  // ER needs BOTH a real daily interactions series and a real daily reach series. Align by calendar
  // day and keep only days with a positive reach denominator — a day with reach 0 or a missing reach
  // point is skipped (never a divide-by-zero or a fabricated value), matching the canonical erReach
  // «real zero vs missing» decision.
  let engagement = EMPTY_CHART;
  if (tiCanon && hasDailySeries(series.reach, 2)) {
    const reachByDay = new Map<string, number>();
    for (const p of windowedDaily(series.reach, win)) reachByDay.set(p.day, p.value);
    const erPoints: Point[] = [];
    for (const p of tiDaily) {
      const reach = reachByDay.get(p.day);
      if (reach != null && reach > 0) erPoints.push({ day: p.day, value: (p.value / reach) * 100 });
    }
    engagement = toChart(erPoints, windowDays);
  }

  return {
    views: viewsCanon ? toChart(windowedDaily(series.views, win), windowDays) : EMPTY_CHART,
    interactions: toChart(tiDaily, windowDays),
    engagement,
  };
}

/** Ряды ЖИВОГО пресета 7/30/90 — ровно как до архива: для каждой метрики целиком ОДИН источник
    (longerSeries: архив или живой ряд, что длиннее), без смешения по дням. Смешение живого хвоста с
    архивом давало на шве двойной день (живой `end_time` ложится на следующий UTC-ключ), а короткий
    архив в первые дни догрузки обрезал длинный живой ряд. */
function liveSeries(insights: IgInsights | undefined, historyRows: IgHistoryRow[] | undefined, followerLevel: Point[]): IgWindowSeries {
  return {
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
    followerLevel,
    saves: longerSeries(metricSeries(insights, 'saves'), histSeries(historyRows, 'saves')),
    likes: longerSeries(metricSeries(insights, 'likes'), histSeries(historyRows, 'likes')),
    comments: longerSeries(metricSeries(insights, 'comments'), histSeries(historyRows, 'comments')),
    shares: longerSeries(metricSeries(insights, 'shares'), histSeries(historyRows, 'shares')),
    profileViews: metricSeries(insights, 'profile_views'),
    // Gross movement endpoints. Window net = follows - unfollows.
    follows: metricSeries(insights, 'follows'),
    unfollows: metricSeries(insights, 'unfollows'),
  };
}

/** ER архивного окна на ОДНОМ основании: Σвзаимодействий ÷ Σохвата только по дням, где есть обе
    величины (день с взаимодействиями, но без охвата — частый случай: комбинированный вызов
    reach,follower_count падает целиком — в числитель не идёт). Общая для панели и виджета. */
export function pairedDailyEr(ti: Point[], reach: Point[]): { ti: number; reach: number; er: number } {
  const reachByDay = new Map(reach.map((p) => [canonicalDayKey(p.day), p.value]));
  let tiSum = 0;
  let reachSum = 0;
  for (const p of ti) {
    const r = reachByDay.get(canonicalDayKey(p.day));
    if (r == null) continue;
    tiSum += p.value;
    reachSum += r;
  }
  return { ti: tiSum, reach: reachSum, er: reachSum > 0 ? (tiSum / reachSum) * 100 : 0 };
}

const scalarFromPair = (pair: WindowPair): IgWindowScalar => ({
  value: pair.cur,
  previous: pair.hasPrev ? pair.prev : null,
  delta: pairDelta(pair),
  hasValue: pair.hasCur,
  hasPrevious: pair.hasPrev,
});

export function igWindowMetrics(raw: IgWindowRaw): IgWindowMetrics {
  const { profile, insights, historyRows, since, until, aggPrevRange = null, mode = 'live' } = raw;
  const canonicalFollowerLevel = followerLevelSeries(historyRows, profile?.followers_count ?? null);
  // Demo mode intentionally disables DB history queries. Its fixture exposes an explicit mock
  // follower_count level series so the sample UI can still demonstrate the audience chart; real
  // accounts never take this fallback and remain anchored/reconstructed from ig_daily.
  const mockFollowerLevel = profile?.mock || insights?.mock ? metricSeries(insights, 'follower_count') : [];
  // Архивное окно («Всё», свой период): ряды — архив ig_daily целиком; живой ряд — только пока
  // архив пуст (archiveOrLive, без смешения источников: OD-8). Синтетический агрегат окна в ряды не
  // попадает. Живой пресет 7/30/90 — ровно прежнее правило (liveSeries ниже): «Live mode is unchanged».
  const merged = (col: keyof IgHistoryRow, live: string): Point[] =>
    archiveOrLive(histSeries(historyRows, col), liveDailySeries(insights, live));
  const series: IgWindowSeries = mode === 'archive'
    ? {
      reach: merged('reach', 'reach'),
      reachWindow: metricSeries(insights, 'reach_window'),
      views: merged('views', 'views'),
      ti: merged('total_interactions', 'total_interactions'),
      // Уникальные вовлечённые аккаунты по дням не складываются — архивного ряда у них нет.
      engaged: liveDailySeries(insights, 'accounts_engaged'),
      follower: merged('followers', 'follower_count'),
      followerLevel: canonicalFollowerLevel.length >= 2 ? canonicalFollowerLevel : mockFollowerLevel,
      saves: merged('saves', 'saves'),
      likes: merged('likes', 'likes'),
      comments: merged('comments', 'comments'),
      shares: merged('shares', 'shares'),
      profileViews: merged('profile_views', 'profile_views'),
      follows: merged('follows', 'follows'),
      unfollows: merged('unfollows', 'unfollows'),
    }
    : liveSeries(insights, historyRows, canonicalFollowerLevel.length >= 2 ? canonicalFollowerLevel : mockFollowerLevel);

  if (mode === 'archive') return archiveWindowMetrics(raw, series);

  // Синтетические агрегаты читаются ПОЗИЦИОННО, а не фильтром по дате: их точки штампуются
  // временем серверного окна и всегда оказываются позже клиентской границы `until` (она округлена
  // вниз до минуты). Прежний date-фильтр выбрасывал текущую точку на каждом рендере — охват молча
  // откатывался на сумму дневных и завышался втрое. См. aggregatePair.
  // Границы агрегата известны только вызывающему (см. IgWindowRaw.aggPrevRange) — проставляем
  // их здесь, чтобы `aggregatePair` не начал угадывать окно по синтетическим `end_time`.
  const withAggRange = (pair: WindowPair): WindowPair => ({ ...pair, prevRange: aggPrevRange });
  const reachWin = withAggRange(aggregatePair(insights, 'reach_window'));
  const reachDaily = windowPair(series.reach, since, until);
  /** Агрегат окна, если бэкенд его отдал; иначе — прежний путь по дневным. */
  const agg = (name: string, daily: Point[]): WindowPair => {
    const pair = aggregatePair(insights, name);
    return pair.hasCur ? withAggRange(pair) : windowPair(daily, since, until);
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
    // Обе составляющие пришли из одного окна — оно же у разности.
    prevRange: pairs.follows.prevRange ?? pairs.unfollows.prevRange ?? null,
  };
  const followersLevel = profile?.followers_count ?? 0;
  const erReach = pairs.reach.cur > 0 ? (pairs.ti.cur / pairs.reach.cur) * 100 : 0;
  const erReachPrev = pairs.reach.prev > 0 ? (pairs.ti.prev / pairs.reach.prev) * 100 : 0;

  return {
    mode: 'live',
    reachBasis: reachWin.hasCur ? 'window' : 'dailySum',
    liveFallback: false,
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

// ── Архивное окно: «Всё» и свой период (OD-13) ────────────────────────────────────────────────────

const NO_PAIR: WindowPair = { cur: 0, prev: 0, hasCur: false, hasPrev: false, prevRange: null };

/** Сумма окна без прошлого периода: у «Всё» его нет, у своего периода парного окна нет. */
function sumPair(points: Point[]): WindowPair {
  let cur = 0;
  for (const p of points) cur += p.value;
  return { cur, prev: 0, hasCur: points.length > 0, hasPrev: false, prevRange: null };
}

/**
 * Числа архивного окна — суммы строк АРХИВА по календарным дням [fromDay..toDay], как у TG
 * (useHistory/inRange). Живой хвост в суммы не добавляется: смысл дня у живого ряда и у архива
 * ещё не сведён (OD-8), и граничный день мог бы посчитаться дважды. Пропуск — пропуск: день без
 * строки в сумму не входит и нулём не становится.
 *   • охват — СУММА дневных (reachBasis 'dailySum'): уникального охвата за произвольный период
 *     Instagram не отдаёт; подпись обязана это сказать;
 *   • вовлечённые аккаунты — уникальная величина, не складывается: hasCur=false;
 *   • ER = Σвзаимодействий ÷ Σохвата по дням, где есть ОБЕ величины — одно основание;
 *   • движение базы = Σfollows − Σunfollows; прошлого периода нет.
 * В окне нет ни одной точки архива (свежее подключение, догрузка ещё идёт) — числа от живых
 * дневных рядов (`liveFallback`), подпись говорит «догружается».
 */
function archiveWindowMetrics(raw: IgWindowRaw, series: IgWindowSeries): IgWindowMetrics {
  const { profile, historyRows, since, until } = raw;
  const fromDay = raw.fromDay ?? null;
  const toDay = raw.toDay ?? null;
  const inDay = (day: string) => (fromDay == null || day >= fromDay) && (toDay == null || day <= toDay);
  const rows = (historyRows ?? []).filter((r) => inDay(r.day));
  const hasArchive = rows.some((r) => r.reach != null || r.views != null || r.total_interactions != null);
  const pick = (col: keyof IgHistoryRow, s: Point[]): Point[] =>
    hasArchive ? histSeries(rows, col) : s.filter((p) => { const k = canonicalDayKey(p.day); return k != null && inDay(k); });
  const pairs: IgWindowPairs = {
    reach: sumPair(pick('reach', series.reach)),
    views: sumPair(pick('views', series.views)),
    ti: sumPair(pick('total_interactions', series.ti)),
    engaged: NO_PAIR,
    follower: sumPair(pick('followers', series.follower)),
    saves: sumPair(pick('saves', series.saves)),
    likes: sumPair(pick('likes', series.likes)),
    comments: sumPair(pick('comments', series.comments)),
    shares: sumPair(pick('shares', series.shares)),
    profileViews: sumPair(pick('profile_views', series.profileViews)),
    follows: sumPair(pick('follows', series.follows)),
    unfollows: sumPair(pick('unfollows', series.unfollows)),
  };
  const followerNet: WindowPair = {
    cur: pairs.follows.cur - pairs.unfollows.cur,
    prev: 0,
    hasCur: pairs.follows.hasCur || pairs.unfollows.hasCur,
    hasPrev: false,
    prevRange: null,
  };
  // ER на одном основании: только дни, где есть и взаимодействия, и охват.
  const erReach = pairedDailyEr(pick('total_interactions', series.ti), pick('reach', series.reach)).er;
  const followersLevel = profile?.followers_count ?? 0;
  const noPrev = (pair: WindowPair): IgWindowScalar => ({
    value: pair.cur, previous: null, delta: null, hasValue: pair.hasCur, hasPrevious: false,
  });
  return {
    mode: 'archive',
    reachBasis: 'dailySum',
    liveFallback: !hasArchive,
    series,
    pairs,
    overviewCharts: igOverviewCharts(series, since, until, inDay),
    daily: {
      reach: dated(series.reach),
      followerNet: dated(netFollowerDaily(historyRows)),
      views: dated(series.views),
      totalInteractions: dated(series.ti),
      likes: dated(series.likes),
      saves: dated(series.saves),
    },
    values: {
      reach: noPrev(pairs.reach),
      views: noPrev(pairs.views),
      totalInteractions: noPrev(pairs.ti),
      likes: noPrev(pairs.likes),
      saves: noPrev(pairs.saves),
      comments: noPrev(pairs.comments),
      shares: noPrev(pairs.shares),
      followerNet: noPrev(followerNet),
      followersLevel: {
        value: followersLevel,
        previous: null,
        delta: null,
        hasValue: profile?.followers_count != null,
        hasPrevious: false,
      },
      erReach: { value: erReach, previous: null, delta: null, hasValue: erReach > 0, hasPrevious: false },
    },
    followerNet,
    followersLevel,
    erReach,
    erReachPrev: 0,
  };
}
