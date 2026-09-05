import type { ChannelsResponse, HistoryData, TgFull } from '@/api/schemas';
import { fmt, pluralRu, timeAxisLabels as weekdayAxis } from '@/lib/format';
import { normalizeTgPosts } from '@/lib/posts';
import type { NormalizedPost } from '@/lib/posts';
import type { DateRange, PeriodDays } from '@/lib/period';
import {
  NO_BASIS_ALL_TIME,
  NO_BASIS_CUSTOM_RANGE,
  NO_BASIS_SHORT_ARCHIVE,
  avgReachWindows,
  pctDelta,
  splitDailyWindows,
  subscriberBaseline,
  subscriberChange,
  subscriberDelta,
  sumPostWindows,
} from '@/lib/delta';
import type { DailyWindowPair, MetricDelta } from '@/lib/delta';
import { windowRangeLabel } from '@/lib/metricSeries';
import type { DeltaBasis } from '@/components/DeltaPill';

/** A daily metric series: aligned day labels + values (sparklines, drills, metric pages).
    `null` = пропуск измерения (день окна без публикаций у avg-метрик): линия рвётся, столбец
    получает штрихованную подложку «0 ≠ n/a» — НЕ ноль. */
export interface DailySeries {
  labels: string[];
  values: Array<number | null>;
  /** Временна́я ось (timeAxisCore): буквы дней короткого окна / EN-месяцы длинного вместо дат.
      Только ПОДПИСИ ОСИ — `labels` остаются полными датами для тултипа/читалки. */
  axisLabels?: string[];
  /** Сырые day-key'и точек — для пересчёта оси после визуального капа (LTTB теряет индексы). */
  dayKeys?: string[];
}


/** KPI metrics that have a dedicated metric page (subset of MetricKey shown as a KPI). */
export type DrillKey = 'views' | 'subscribers' | 'avgReach' | 'reactions' | 'forwards' | 'er';
export const DRILL_KEYS: readonly DrillKey[] = ['views', 'subscribers', 'avgReach', 'reactions', 'forwards', 'er'];

export function isDrillKey(raw: string | undefined): raw is DrillKey {
  return DRILL_KEYS.includes(raw as DrillKey);
}

/** The NormalizedPost field a post-attributed metric sums over. */
export type PostMetricField = keyof Pick<NormalizedPost, 'reach' | 'likes' | 'shares' | 'eng'>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Zero-filled daily sums over an inclusive [from..to] window (UTC day buckets, like the KPIs). */
export function filledDailySeries(
  posts: NormalizedPost[],
  field: PostMetricField,
  fromMs: number,
  toMs: number,
): DailySeries {
  const byDay = new Map<string, number>();
  for (const post of posts) {
    if (!post.date) continue;
    const t = Date.parse(post.date);
    if (!Number.isFinite(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(post[field] ?? 0));
  }
  const labels: string[] = [];
  const values: number[] = [];
  const dayKeys: string[] = [];
  const start = fromMs - (fromMs % DAY_MS);
  for (let t = start; t <= toMs; t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10);
    dayKeys.push(key);
    labels.push(fmt.day(key));
    values.push(byDay.get(key) ?? 0);
  }
  return { labels, values, axisLabels: weekdayAxis(dayKeys, dayKeys.length) };
}

/** Sparse daily sums (no zero-fill) — for the unbounded «Всё» window. */
export function sparseDailySeries(posts: NormalizedPost[], field: PostMetricField): DailySeries {
  const byDay = new Map<string, number>();
  for (const post of posts) {
    if (!post.date) continue;
    const t = Date.parse(post.date);
    if (!Number.isFinite(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(post[field] ?? 0));
  }
  const entries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { labels: entries.map(([k]) => fmt.day(k)), values: entries.map(([, v]) => v) };
}

/**
 * Every KPI aggregate/window/series in one pure pass — shared by the Overview KPI grid and the
 * metric pages so a headline and its page always reconcile (same math, same sources).
 *
 * Displayed subscriber count comes from the channels list (server-derived from the latest
 * channel_daily row), falling back to the live /api/tg/full count. The trend pill + sparkline
 * read that archive via /api/history (a separate endpoint / cache), so the shown Δ is
 * directional context, not exact (headline − baseline) arithmetic. The live `members`
 * stays the ER/avg divisor (parity with the legacy formula).
 */
export function deriveKpis(
  data: TgFull | undefined,
  history: HistoryData | undefined,
  channelsData: ChannelsResponse | undefined,
  channelId: number | null,
  days: PeriodDays,
  range: DateRange | null,
  inRange: (dateISO: string | null | undefined) => boolean,
) {
  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const current = channelsData?.channels.find((c) => c.id === channelId);
  const displayMembers = current?.memberCount ?? members;
  const posts = (data?.posts ?? []).filter((post) => inRange(post.date));
  const totalViews = posts.reduce((sum, post) => sum + Number(post.views ?? post.view_count ?? 0), 0);
  const totalReactions = posts.reduce(
    (sum, post) => sum + Number(post.reactions ?? post.reactions_count ?? 0),
    0,
  );
  const totalForwards = posts.reduce((sum, post) => sum + Number(post.forwards ?? 0), 0);
  const totalReplies = posts.reduce((sum, post) => sum + Number(post.replies ?? post.comments_count ?? 0), 0);
  const postsAnalyzed = posts.length;
  const avgViews = postsAnalyzed > 0 ? totalViews / postsAnalyzed : 0;
  const er = members > 0 ? ((totalReactions + totalReplies + totalForwards) / members) * 100 : 0;
  const subscriberTrend = subscriberDelta(history?.rows ?? [], days);
  const windowTotals = sumPostWindows(
    (data?.posts ?? []).map((post) => ({
      date: post.date,
      views: Number(post.views ?? post.view_count ?? 0),
      reactions: Number(post.reactions ?? post.reactions_count ?? 0),
      forwards: Number(post.forwards ?? 0),
      replies: Number(post.replies ?? post.comments_count ?? 0),
    })),
    days,
  );
  const currentEngagement = windowTotals
    ? windowTotals.current.reactions + windowTotals.current.forwards + windowTotals.current.replies
    : null;
  const previousEngagement = windowTotals
    ? windowTotals.previous.reactions + windowTotals.previous.forwards + windowTotals.previous.replies
    : null;

  const historyRows = history?.rows ?? [];
  // «Просмотры» — КАНАЛЬНЫЕ, из дневного архива (channel_daily.views, персист из GetBroadcastStats
  // views_graph): честные «просмотры канала за период». Пост-сумма (`totalViews`) меряет УЖЕ —
  // только просмотры постов, ОПУБЛИКОВАННЫХ в окне — и расходится в разы (на проде 10.8k vs 1.8k);
  // она остаётся базой для avg-reach-на-пост ниже и фолбэком, когда архива нет (без БД / малый
  // канал без stats / day 1). Тренд уже канальный (viewsPair по historyRows.views).
  const viewsArchiveRows = historyRows
    .filter((r) => r.views != null && inRange(r.day))
    .sort((a, b) => a.day.localeCompare(b.day));
  const hasChannelViews = viewsArchiveRows.length > 0;
  const channelViews = hasChannelViews
    ? viewsArchiveRows.reduce((sum, r) => sum + Number(r.views), 0)
    : totalViews;
  // ПАРА ОКОН, а не голый процент (было `dailyWindowDelta`, который внутри делает ровно это же):
  // пилюле нужны ещё ГРАНИЦЫ и СУММА базы, иначе основание пришлось бы считать вторым проходом
  // по тем же строкам — и оно смогло бы разойтись с процентом, под которым напечатано.
  const archivePair = (pick: (r: (typeof historyRows)[number]) => number) =>
    splitDailyWindows(historyRows, pick, days);
  const viewsPair = archivePair((r) => Number(r.views ?? 0));
  const reactionsPair = archivePair((r) => Number(r.reactions ?? 0));
  const forwardsPair = archivePair((r) => Number(r.forwards ?? 0));
  const erPair = archivePair((r) => Number(r.reactions ?? 0) + Number(r.forwards ?? 0));
  const pairTrend = <T,>(pair: DailyWindowPair<T> | null): MetricDelta | null =>
    pair ? pctDelta(pair.current.total, pair.previous.total) : null;
  const viewsTrend =
    pairTrend(viewsPair)
    ?? (windowTotals ? pctDelta(windowTotals.current.views, windowTotals.previous.views) : null);
  const reactionsTrend =
    pairTrend(reactionsPair)
    ?? (windowTotals ? pctDelta(windowTotals.current.reactions, windowTotals.previous.reactions) : null);
  const forwardsTrend =
    pairTrend(forwardsPair)
    ?? (windowTotals ? pctDelta(windowTotals.current.forwards, windowTotals.previous.forwards) : null);
  const erTrend =
    pairTrend(erPair)
    ?? (members > 0 && currentEngagement != null && previousEngagement != null
      ? pctDelta(currentEngagement / members, previousEngagement / members)
      : null);
  const avgReachPosts = (data?.posts ?? []).map((post) => ({
    date: post.date,
    views: Number(post.views ?? post.view_count ?? 0),
  }));
  // Paired-window average reach (same windows as the trend) — feeds the compact Overview
  // avg-reach card's current/previous bars. Preset windows only (a custom range has no paired
  // previous), so `range` suppresses it exactly like the ledger deltas below.
  const avgReachPair = range ? null : avgReachWindows(avgReachPosts, days);
  const avgReachTrend = avgReachPair ? pctDelta(avgReachPair.current, avgReachPair.previous) : null;

  // Длина активного окна в ДНЯХ для временно́й оси (timeAxisLabels): пресет несёт её напрямую,
  // кастомный диапазон — по своим границам; «Всё» передаёт 0 — хелпер меряет окно размахом серии.
  const windowDays = range
    ? Math.round((range.to - range.from) / DAY_MS) + 1
    : days;

  // Кап фетча (100 постов): когда выборка на капе, дни СТАРШЕ самого старого зафетченного поста
  // «не измерены», а не «без публикаций» — разворачивать сетку (и штриховку «нет публикаций»)
  // на них было бы ложью. Честная левая граница публикационной сетки = старейший пост выборки.
  const fetchedCount = data?.posts?.length ?? 0;
  const postsAtFetchCap = !range && fetchedCount >= 100 && posts.length >= fetchedCount;
  const oldestFetchedTs = postsAtFetchCap
    ? posts.reduce<number>((acc, post) => {
        const t = post.date ? Date.parse(post.date) : Number.NaN;
        return Number.isFinite(t) && t < acc ? t : acc;
      }, Number.POSITIVE_INFINITY)
    : null;

  // Per-metric daily series for the inline sparklines (within the active window). Carries the
  // day labels alongside the values so the interactive read-out can name the hovered point.
  const dailySeries = (value: (post: (typeof posts)[number]) => number): DailySeries => {
    const byDay = new Map<string, number>();
    posts.forEach((post) => {
      if (!post.date) return;
      const timestamp = Date.parse(post.date);
      if (!Number.isFinite(timestamp)) return;
      const key = new Date(timestamp).toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + value(post));
    });
    const entries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
    return {
      labels: entries.map(([k]) => fmt.day(k)),
      values: entries.map(([, v]) => v),
      axisLabels: weekdayAxis(entries.map(([k]) => k), windowDays),
      dayKeys: entries.map(([k]) => k),
    };
  };
  // Active-window sparklines for the three compact TG comparison cards (Ср. охват / Реакции /
  // Вовлечённость): an HONEST publication-date timeline, keyed by UTC publication day over the
  // posts already filtered by the top-bar period/range — the chart depends ONLY on the active
  // window, never on previous-window coverage. Sorted ascending by UTC day:
  //   • Ср. охват — mean views per post published that day (день без постов = ПРОПУСК, не ноль)
  //   • Реакции — Σ reactions for posts published that day (день без постов = честный ноль)
  //   • Вовлечённость — 100·(reactions + replies/comments + forwards) ÷ member count, that day
  // Divisor is the live `members` (parity with the ER headline). Not shared with Instagram.
  // История канона: 2026-07 серии были sparse by construction (без сфабрикованных нулей);
  // 2026-08-14 владелец развернул их на ПОЛНОЕ окно («выбрал 7 дней — вижу 7 дней», как
  // конфиг-виджеты) — честность держат null-пропуски и нули по семантике метрики, см. ниже.
  const pubDayBuckets = new Map<string, { views: number; reactions: number; replies: number; forwards: number; count: number }>();
  posts.forEach((post) => {
    if (!post.date) return;
    const timestamp = Date.parse(post.date);
    if (!Number.isFinite(timestamp)) return;
    const key = new Date(timestamp).toISOString().slice(0, 10);
    const bucket = pubDayBuckets.get(key) ?? { views: 0, reactions: 0, replies: 0, forwards: 0, count: 0 };
    bucket.views += Number(post.views ?? post.view_count ?? 0);
    bucket.reactions += Number(post.reactions ?? post.reactions_count ?? 0);
    bucket.replies += Number(post.replies ?? post.comments_count ?? 0);
    bucket.forwards += Number(post.forwards ?? 0);
    bucket.count += 1;
    pubDayBuckets.set(key, bucket);
  });
  // РАЗВОРОТ НА ПОЛНОЕ ОКНО (решение владельца 2026-08-14, «вариант 2»; прежний sparse-канон
  // 2026-07 снят): «выбрал 7 дней — вижу 7 дней». Кандидаты — UTC-дни окна (пресет = rolling
  // Date.now(), диапазон = его границы), ОБЪЕДИНЁННЫЕ с фактическими бакетами: пост на кромке
  // rolling-окна, чей UTC-день старше кандидатов, не теряется. «Всё» (days=0 без range)
  // безгранично — остаётся разреженным, как раньше.
  const pubDayKeys = (() => {
    const bucketKeys = [...pubDayBuckets.keys()];
    if (!range && days === 0) return bucketKeys.sort((a, b) => a.localeCompare(b));
    const toMs = range ? range.to : Date.now();
    // На капе фетча левая граница сетки — старейший зафетченный пост: дни старше него «не
    // измерены» (см. postsAtFetchCap выше), их нельзя показывать ни нулём, ни «нет публикаций».
    const windowFromMs = range ? range.from : Date.now() - (days - 1) * DAY_MS;
    const fromMs = oldestFetchedTs != null ? Math.max(windowFromMs, oldestFetchedTs) : windowFromMs;
    const keys = new Set(bucketKeys);
    for (let t = fromMs; t <= toMs; t += DAY_MS) keys.add(new Date(t).toISOString().slice(0, 10));
    // Финальный день добавляется явно: шаг в 24 часа через смену сезонного времени внутри
    // кастомного диапазона мог бы не попасть в последний календарный день.
    keys.add(new Date(toMs).toISOString().slice(0, 10));
    return [...keys].sort((a, b) => a.localeCompare(b));
  })();
  const pubDays = pubDayKeys.map((key) => [key, pubDayBuckets.get(key)] as const);
  const pubDayLabels = pubDays.map(([k]) => fmt.day(k));
  const pubDayAxis = weekdayAxis(pubDayKeys, windowDays);
  const avgReachSpark: DailySeries = {
    labels: pubDayLabels,
    // День без публикаций — НЕ ноль охвата на пост (среднее от ничего — ложь), а честный
    // ПРОПУСК: BarChart рисует штрихованную подложку «0 ≠ n/a», тултип говорит «нет публикаций».
    values: pubDays.map(([, b]) => (b ? (b.count > 0 ? b.views / b.count : 0) : null)),
    axisLabels: pubDayAxis,
  };
  const reactionsSpark: DailySeries = {
    labels: pubDayLabels,
    // У счётного потока день без публикаций — честный ноль: реакций к постам этого дня нет.
    values: pubDays.map(([, b]) => (b ? b.reactions : 0)),
    axisLabels: pubDayAxis,
  };
  // Знаменатель ER — аудитория ТОГО ДНЯ, из дневного архива, а не сегодняшнее число подписчиков.
  // С константой в знаменателе ER выходил РОВНО пропорционален вовлечению: erSpark = reactions ×
  // (100/members). А `Sparkline` нормализует ряд по min–max, поэтому постоянный множитель форму не
  // меняет вообще — карточки «Реакции» и «Вовлечённость» рисовали одну и ту же кривую (замерено на
  // проде: корреляция 0.996, расхождение нормализованных форм 5.4% высоты плота). Деление на
  // аудиторию своего дня возвращает ряду собственный смысл: за 30 дней база менялась на сотни
  // подписчиков, и ER растёт медленнее вовлечения, когда канал растёт. Дня нет в архиве — падаем
  // на живое число (прежнее поведение), это честнее, чем выбросить точку.
  const membersByDay = new Map<string, number>();
  for (const row of historyRows) {
    const value = Number(row.subscribers ?? 0);
    if (value > 0) membersByDay.set(row.day, value);
  }
  const erSpark: DailySeries = {
    labels: pubDayLabels,
    values: pubDays.map(([day, b]) => {
      if (!b) return 0; // день без публикаций: нового вовлечения нет — честный ноль
      const base = membersByDay.get(day) ?? members;
      return base > 0 ? ((b.reactions + b.replies + b.forwards) / base) * 100 : 0;
    }),
    axisLabels: pubDayAxis,
  };
  // Sparkline matches the (channel-wide) headline: daily channel views from the archive when we
  // have it, else the post-derived daily series (fallback path).
  const viewsSpark: DailySeries = hasChannelViews
    ? {
        labels: viewsArchiveRows.map((r) => fmt.day(r.day)),
        values: viewsArchiveRows.map((r) => Number(r.views)),
        axisLabels: weekdayAxis(viewsArchiveRows.map((r) => r.day), windowDays),
        dayKeys: viewsArchiveRows.map((r) => r.day),
      }
    : dailySeries((post) => Number(post.views ?? post.view_count ?? 0));
  // Subscriber trend from the daily archive (reliable, unlike post-derived views).
  const subsRows = historyRows
    .filter((row) => row.subscribers != null && inRange(row.day))
    .sort((a, b) => a.day.localeCompare(b.day));
  const subsSpark: DailySeries = {
    labels: subsRows.map((row) => fmt.day(row.day)),
    values: subsRows.map((row) => Number(row.subscribers)),
    axisLabels: weekdayAxis(subsRows.map((row) => row.day), windowDays),
  };
  // Absolute subscriber change ("−108 за 30 дн.") — more legible than the % alone. Only for the
  // `days` presets: a custom date range overrides the preset window, so a preset-based number +
  // label would contradict the (range-filtered) sparkline → fall back to a neutral caption.
  const subChange = range ? null : subscriberChange(historyRows, days);
  const periodLabel = days === 0 ? 'всё время' : `${days} дн.`;
  const subCaption =
    subChange != null && subChange !== 0
      ? `${subChange > 0 ? '+' : '−'}${fmt.num(Math.abs(subChange))} за ${periodLabel}`
      : 'в канале';

  // Absolute "+N к пред. периоду" captions (current vs previous equal-length window). Like the
  // subscriber Δ, only for preset windows — a custom range overrides the preset, so the paired
  // window math wouldn't match the shown range. ER is expressed in percentage points.
  const signedAbs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;
  const vsPrev = (cur: number, prev: number): string | null =>
    range ? null : `${signedAbs(cur - prev)} к пред. периоду`;
  // Channel-wide views: the «+N к пред.» absolute is post-window math (windowTotals) and would
  // contradict the channel headline — drop it and lean on the (channel-based) % trend. Only the
  // post-sum fallback keeps the paired-window absolute.
  const viewsAbsCaption = !hasChannelViews && windowTotals ? vsPrev(windowTotals.current.views, windowTotals.previous.views) : null;
  const reactionsCaption = windowTotals ? vsPrev(windowTotals.current.reactions, windowTotals.previous.reactions) : null;
  const forwardsCaption = windowTotals ? vsPrev(windowTotals.current.forwards, windowTotals.previous.forwards) : null;
  const erPp =
    !range && members > 0 && currentEngagement != null && previousEngagement != null
      ? ((currentEngagement - previousEngagement) / members) * 100
      : null;
  const erCaption =
    erPp != null && Math.abs(erPp) >= 0.05 ? `${erPp > 0 ? '+' : '−'}${Math.abs(erPp).toFixed(1)} п.п.` : null;
  // Любое окно на деле упирается в fetch-лимит сервера (100 постов): когда выборка на капе И
  // всё загруженное попадает в окно (значит, более старые посты обрезаны), честно говорим «по
  // последним N постам», а не молча выдаём урезанный срез как полный — для ЛЮБОГО пресета, не
  // только «Всё».
  // Хойстнуто выше (postsAtFetchCap) — кап нужен уже публикационной сетке спарков.
  const atFetchCap = postsAtFetchCap;
  // «по N постам» описывает пост-базис — неверно для канальных просмотров (они по всему каналу,
  // не по постам окна). Оставляем этот caption только на фолбэке в пост-сумму.
  const viewsBase = !hasChannelViews && postsAnalyzed
    ? atFetchCap
      ? `по последним ${postsAnalyzed} ${pluralRu(postsAnalyzed, ['посту', 'постам', 'постам'])}`
      : `по ${postsAnalyzed} ${pluralRu(postsAnalyzed, ['посту', 'постам', 'постам'])}`
    : null;
  const viewsCaption = [viewsBase, viewsAbsCaption].filter(Boolean).join(' · ') || null;

  // Compact inline ledger deltas (Figma: signed-absolute next to subs/reactions, ER in п.п.; avg-reach
  // keeps the percent pill). Preset windows only — a custom range has no paired previous window.
  const subDelta = subChange != null && subChange !== 0 ? signedAbs(subChange) : null;
  const reactionsDiff = !range && windowTotals ? windowTotals.current.reactions - windowTotals.previous.reactions : null;
  const reactionsDelta = reactionsDiff ? signedAbs(reactionsDiff) : null;

  // Normalized posts: the full fetched set (baseline windows live BEFORE the active one) and
  // the active-window slice — the per-post attribution source for the metric pages. Uses the
  // same fields the KPI totals sum, so the breakdown reconciles with the headline.
  const normPostsAll = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {});
  const normPosts = normPostsAll.filter((post) => inRange(post.date));
  const drillMeta: Record<DrillKey, { total: string; trend?: MetricDelta | null; caption?: string | null }> = {
    views: { total: fmt.short(channelViews), trend: viewsTrend, caption: viewsCaption },
    subscribers: { total: fmt.num(displayMembers), trend: subscriberTrend, caption: subCaption },
    avgReach: { total: fmt.short(avgViews), trend: avgReachTrend, caption: null },
    reactions: { total: fmt.short(totalReactions), trend: reactionsTrend, caption: reactionsCaption },
    forwards: { total: fmt.short(totalForwards), trend: forwardsTrend, caption: forwardsCaption },
    // Единый абсолютный процент (fmt.pctAbs): drillMeta кормит хедлайн /metrics/er, строку сверки,
    // KPI отчёта и config-виджеты — карточка Обзора обязана печатать ровно то же число тем же
    // форматом, иначе клик по «28.9%» приводит на страницу с «28.92%».
    er: { total: er > 0 ? fmt.pctAbs(er) : '—', trend: erTrend, caption: erCaption },
  };

  // Previous-window absolutes for the compact Overview comparison cards (avg reach / reactions /
  // ER). Honest by construction: null whenever the paired previous window is unavailable
  // (custom range, sparse channel) so the card draws no comparison bars and quotes no fake prev.
  const avgViewsPrev = avgReachPair ? avgReachPair.previous : null;
  const reactionsPrev = !range && windowTotals ? windowTotals.previous.reactions : null;
  const erPrev =
    !range && members > 0 && previousEngagement != null ? (previousEngagement / members) * 100 : null;

  // ОСНОВАНИЕ ДЕЛЬТЫ — с чем сравнили и сколько там было. Процент без базы проверить нечем:
  // «↑4.5%» рядом со словом «пред. период» не говорил ни какие это дни, ни какое число взято
  // за единицу — читателю приходилось уходить со страницы, чтобы поверить карточке.
  //
  // Каждое основание описывает ТУ ЖЕ арифметику, что и напечатанная рядом дельта — или НАЗЫВАЕТ свою
  // единицу там, где она отличается от единицы заголовка (см. ER ниже), и возвращает null, как
  // только честно описать базу нечем.
  const noBasisReason = days === 0 ? NO_BASIS_ALL_TIME : range ? NO_BASIS_CUSTOM_RANGE : NO_BASIS_SHORT_ARCHIVE;
  const archiveBasis = <T,>(pair: DailyWindowPair<T> | null): DeltaBasis | null =>
    pair?.previous.range
      ? { label: windowRangeLabel(pair.previous.range), value: fmt.short(pair.previous.total) }
      : null;
  const postBasis = (value: number): DeltaBasis | null =>
    windowTotals ? { label: windowRangeLabel(windowTotals.ranges.previous), value: fmt.short(value) } : null;
  const subsBase = subscriberBaseline(historyRows, days);
  // База ER в единицах ER — только пост-окно (`erPrev`), и тем же форматом, что число карточки.
  const erPostBasis: DeltaBasis | null =
    erPrev != null && windowTotals
      ? { label: windowRangeLabel(windowTotals.ranges.previous), value: fmt.pctAbs(erPrev) }
      : null;
  const deltaBasis: Record<DrillKey, DeltaBasis | null> = {
    views: archiveBasis(viewsPair) ?? (windowTotals ? postBasis(windowTotals.previous.views) : null),
    // У подписчиков база — не окно, а ОДИН замер уровня: подпись называет день архива и значение.
    subscribers: subsBase ? { label: fmt.day(subsBase.day), value: fmt.num(subsBase.subscribers) } : null,
    avgReach: avgReachPair
      ? { label: windowRangeLabel(avgReachPair.ranges.previous), value: fmt.short(Math.round(avgReachPair.previous)) }
      : null,
    reactions: archiveBasis(reactionsPair) ?? (windowTotals ? postBasis(windowTotals.previous.reactions) : null),
    forwards: archiveBasis(forwardsPair) ?? (windowTotals ? postBasis(windowTotals.previous.forwards) : null),
    // На канале с архивом пилюля ER мерит НЕ ER, а дельту СУММЫ реакций и репостов (база
    // подписчиков в знаменателе за окно почти не меняется, и процент совпадает с точностью до неё).
    // Поэтому основание НАЗЫВАЕТ, чем именно является его число: «13.6k реакций и репостов» под
    // заголовком «28.9%» — это правда о проценте, а голое «13.6k» читалось бы как прошлый ER.
    er: erPair?.previous.range
      ? {
          label: windowRangeLabel(erPair.previous.range),
          value: `${fmt.short(erPair.previous.total)} реакций и репостов`,
        }
      : erPostBasis,
  };
  // Готовые строки-дельты («+531», «+1.2 п.п.») считаются НЕ по тому же источнику, что процентные
  // тренды (реакции — по окну постов, тренд — по дневному архиву), поэтому у них СВОЁ основание:
  // общее назвало бы читателю число, из которого видимая рядом разница не получается.
  const captionBasis = {
    reactions: reactionsPrev != null ? postBasis(reactionsPrev) : null,
    er: erPostBasis,
  };

  return {
    members, displayMembers, totalViews, channelViews, totalReactions, avgViews, er,
    subscriberTrend, viewsTrend, reactionsTrend, erTrend, avgReachTrend,
    viewsSpark, subsSpark, periodLabel, viewsCaption, subDelta, reactionsDelta, erCaption,
    avgReachSpark, reactionsSpark, erSpark,
    avgViewsPrev, reactionsPrev, erPrev,
    deltaBasis, captionBasis, noBasisReason,
    normPosts, normPostsAll, drillMeta,
    // Extras the metric pages need beyond the grid: paired-window totals for the
    // «Сравнение» ledger and the raw archive rows for subscriber window math.
    windowTotals, currentEngagement, previousEngagement, historyRows,
  };
}
