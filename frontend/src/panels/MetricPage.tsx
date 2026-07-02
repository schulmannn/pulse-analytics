import { useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import { deriveKpis, isDrillKey } from '@/lib/kpiDerive';
import type { DailySeries, DrillKey } from '@/lib/kpiDerive';
import { METRIC_DEFS } from '@/lib/metricDefs';
import type { MetricDef } from '@/lib/metricDefs';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { normalizeTgPosts } from '@/lib/posts';
import type { NormalizedPost } from '@/lib/posts';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DeltaPill } from '@/components/DeltaPill';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { Breakdown } from '@/components/Breakdown';
import { PostDetailModal } from '@/components/PostDetailModal';
import { ChartSection } from '@/components/instagram/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

// Which NormalizedPost field a metric attributes to. null = no per-post attribution (subscribers).
const FIELD: Partial<Record<DrillKey, keyof Pick<NormalizedPost, 'reach' | 'likes' | 'shares' | 'eng'>>> = {
  views: 'reach',
  avgReach: 'reach',
  reactions: 'likes',
  forwards: 'shares',
  er: 'eng',
};

const CONTRIB_LABEL: Partial<Record<DrillKey, string>> = {
  views: 'просмотрам',
  avgReach: 'охвату',
  reactions: 'реакциям',
  forwards: 'репостам',
  er: 'вовлечённости',
};

// Chart section heading. Ratio metrics (avgReach/ER) are derived from a sum, so the chart shows
// that underlying sum (reach / engagement), not the ratio itself — the heading says so.
const DAY_TITLE: Partial<Record<DrillKey, string>> = {
  subscribers: 'Подписчики по дням',
  avgReach: 'Просмотры по дням',
  er: 'Вовлечённость по дням',
};

// What a per-post contribution is a share OF (ratio metrics: the underlying sum, not the ratio).
const SHARE_LABEL: Partial<Record<DrillKey, string>> = {
  avgReach: '% охвата',
  er: '% вовлечённости',
};

/** Post format for the breakdown rows (same buckets as the Compare tab). */
function formatLabel(mediaType: string | null, albumSize: number): string {
  if (albumSize > 1) return 'Альбом';
  if (mediaType === 'photo') return 'Фото';
  if (mediaType === 'video') return 'Видео';
  if (mediaType === 'document') return 'Файл';
  return 'Текст';
}

// Volume metrics start the y-axis at zero (bar-like honesty for sums); the subscriber count is a
// stock metric where the zoomed band is the story, so it keeps the fitted scale.
const ZERO_BASED: Record<DrillKey, boolean> = {
  views: true,
  avgReach: true,
  reactions: true,
  forwards: true,
  er: true,
  subscribers: false,
};

/** Zero-filled daily sums over an inclusive [from..to] window (UTC day buckets, like the KPIs). */
function filledDaily(
  posts: NormalizedPost[],
  field: keyof Pick<NormalizedPost, 'reach' | 'likes' | 'shares' | 'eng'>,
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
  const start = fromMs - (fromMs % DAY_MS);
  for (let t = start; t <= toMs; t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10);
    labels.push(fmt.day(key));
    values.push(byDay.get(key) ?? 0);
  }
  return { labels, values };
}

/** Sparse daily sums (no zero-fill) — for the unbounded «Всё» window. */
function sparseDaily(
  posts: NormalizedPost[],
  field: keyof Pick<NormalizedPost, 'reach' | 'likes' | 'shares' | 'eng'>,
): DailySeries {
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
 * Metric page — the steep-style evolution of the old KPI drill modal: one metric on a full
 * screen. Headline (value + Δ + caption), a large daily chart with value labels / anomaly
 * markers / a dashed previous-period ghost, an Explore rail (period comparison + top
 * contributing posts) and a plain-language «О метрике» block from METRIC_DEFS. All numbers
 * come from the same deriveKpis pass as the Overview ledger, so headline and page reconcile.
 */
export function MetricPage() {
  const { key: rawKey } = useParams();
  const { days, range, inRange } = usePeriod();
  const { data, isPending, isError, error } = useTgFull(days);
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const [openPost, setOpenPost] = useState<NormalizedPost | null>(null);
  // Chart type lives in ?chart= (replace) — a shared link restores the view; line is default.
  const [params, setParams] = useSearchParams();
  const chartType: 'line' | 'bar' = params.get('chart') === 'bar' ? 'bar' : 'line';
  const setChartType = (next: 'line' | 'bar') => {
    setParams(
      (prev) => {
        const merged = new URLSearchParams(prev);
        if (next === 'line') merged.delete('chart');
        else merged.set('chart', next);
        return merged;
      },
      { replace: true },
    );
  };
  // The previous-period ghost is a toggle (steep's Compare row), on by default when available.
  const [showGhost, setShowGhost] = useState(true);

  const derived = useMemo(
    () => deriveKpis(data, history, channelsData, channelId, days, range, inRange),
    [data, history, channelsData, channelId, days, range, inRange],
  );

  // All fetched posts, unfiltered — the previous-period ghost needs the window BEFORE the
  // active one (deriveKpis' normPosts are already range-filtered).
  const allPosts = useMemo(
    () => normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}),
    [data],
  );

  if (!isDrillKey(rawKey)) return <Navigate to="/" replace />;
  const metricKey = rawKey;

  if (isPending) return <MetricSkeleton />;
  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить метрику: {error instanceof Error ? error.message : 'ошибка'}
        </CardContent>
      </Card>
    );
  }

  // Widened to MetricDef: the `satisfies` map narrows each entry, hiding optional fields.
  const def: MetricDef = METRIC_DEFS[metricKey];
  const meta = derived.drillMeta[metricKey];
  const field = FIELD[metricKey];
  const { normPosts, subsSpark, historyRows, windowTotals, currentEngagement, previousEngagement, members, periodLabel } = derived;

  // Active window bounds (custom range wins; «Всё» has none → sparse series, no ghost).
  const winTo = range ? range.to : Date.now();
  const winFrom = range ? range.from : days > 0 ? winTo - (days - 1) * DAY_MS : null;

  // Main daily series + the previous equal-length window for the ghost (presets only — a custom
  // range has no paired previous window, «Всё» has no window at all).
  let series: DailySeries;
  let ghost: number[] | undefined;
  if (metricKey === 'subscribers') {
    series = subsSpark;
    if (!range && days > 0) {
      const prevRows = historyRows
        .filter((row) => {
          if (row.subscribers == null) return false;
          const t = Date.parse(row.day);
          return Number.isFinite(t) && t >= winTo - 2 * days * DAY_MS && t < winTo - days * DAY_MS;
        })
        .sort((a, b) => a.day.localeCompare(b.day));
      const prevValues = prevRows.map((row) => Number(row.subscribers));
      if (prevValues.length === series.values.length && prevValues.length >= 2) ghost = prevValues;
    }
  } else if (field) {
    if (winFrom != null && (winTo - winFrom) / DAY_MS <= 366) {
      series = filledDaily(normPosts, field, winFrom, winTo);
      if (!range && days > 0) {
        const prevFrom = winFrom - days * DAY_MS;
        const prevTo = winFrom - 1;
        const prevPosts = allPosts.filter((post) => {
          if (!post.date) return false;
          const t = Date.parse(post.date);
          return Number.isFinite(t) && t >= prevFrom && t <= prevTo;
        });
        const prev = filledDaily(prevPosts, field, prevFrom, prevTo);
        if (prev.values.length === series.values.length && prev.values.some((v) => v > 0)) ghost = prev.values;
      }
    } else {
      series = sparseDaily(normPosts, field);
    }
  } else {
    series = { labels: [], values: [] };
  }

  const valueFmt = metricKey === 'subscribers' ? fmt.num : fmt.short;
  const titles = series.values.map((v, i) => `${series.labels[i]}: ${valueFmt(v)}`);

  // Top contributing posts (post-attributed metrics only) + the reconciliation footer.
  const contributors = field
    ? normPosts
        .filter((p) => Number(p[field] ?? 0) > 0)
        .sort((a, b) => Number(b[field] ?? 0) - Number(a[field] ?? 0))
        .slice(0, 8)
    : [];
  const fieldSumAll = field ? normPosts.reduce((s, p) => s + Number(p[field] ?? 0), 0) : 0;
  const contribTotal = field ? contributors.reduce((s, p) => s + Number(p[field] ?? 0), 0) : 0;
  let reconcile = '';
  if (field) {
    if (metricKey === 'er' && members > 0) {
      reconcile = `ER = ${fmt.short(fieldSumAll)} вовлечений ÷ ${fmt.num(members)} подписчиков × 100% = ${meta.total}`;
    } else if (metricKey === 'avgReach' && normPosts.length > 0) {
      reconcile = `Средний охват = ${fmt.short(fieldSumAll)} просмотров ÷ ${normPosts.length} постов = ${meta.total}`;
    } else if (contributors.length > 0 && contribTotal > 0 && fieldSumAll > 0) {
      reconcile = `Эти ${contributors.length} постов дали ${Math.round((contribTotal / fieldSumAll) * 100)}% от периода.`;
    }
  }

  // Format breakdown for the Explore rail (post-attributed metrics: sums of the metric's
  // underlying field per format — same buckets as the Compare tab).
  const breakdownItems = field
    ? (() => {
        const byFormat = new Map<string, number>();
        for (const post of normPosts) {
          const label = formatLabel(post.mediaType, post.albumSize);
          byFormat.set(label, (byFormat.get(label) ?? 0) + Number(post[field] ?? 0));
        }
        return [...byFormat.entries()]
          .filter(([, value]) => value > 0)
          .sort(([, a], [, b]) => b - a)
          .map(([label, value]) => ({ label, value, display: fmt.short(value) }));
      })()
    : [];

  // «Сравнение» ledger: current vs the previous equal-length window (presets only).
  const compare = buildCompare(metricKey, {
    range: range != null,
    days,
    windowTotals,
    currentEngagement,
    previousEngagement,
    members,
    subsSpark,
    historyRows,
    winTo,
  });

  return (
    <div className="space-y-8">
      {/* Breadcrumb back to the ledger the metric was opened from. */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span aria-hidden="true">←</span> Обзор
      </Link>

      {/* Headline — same value/Δ/caption as the Overview ledger cell (shared derive). */}
      <div>
        <div className="text-xs tracking-wide text-muted-foreground">
          {def.term} · {periodLabel}
        </div>
        <div className="mt-2 flex items-baseline gap-2.5">
          <span className="text-hero font-medium leading-none tabular-nums tracking-tight">{meta.total}</span>
          <DeltaPill delta={meta.trend} />
        </div>
        {meta.caption ? <div className="mt-2 text-xs text-muted-foreground">{meta.caption}</div> : null}
      </div>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Main column — the big daily chart + contributing posts. */}
        <div className="min-w-0 space-y-8">
          <section className="space-y-3">
            {/* ChartSection header + the chart-type switcher (steep's Explore icons) inline. */}
            <div className="flex items-center gap-3">
              <h3 className="whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">
                {DAY_TITLE[metricKey] ?? 'По дням'}
              </h3>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              <div role="group" aria-label="Тип графика" className="flex overflow-hidden rounded border border-border">
                <ChartTypeButton kind="line" active={chartType === 'line'} onSelect={setChartType} />
                <ChartTypeButton kind="bar" active={chartType === 'bar'} onSelect={setChartType} />
              </div>
            </div>
            {chartType === 'line' ? (
              <>
                <LineChart
                  values={series.values}
                  labels={series.labels}
                  titles={titles}
                  height={280}
                  markExtremes
                  markAnomalies={metricKey === 'views' || metricKey === 'subscribers'}
                  showPoints={series.values.length > 1 && series.values.length <= 45}
                  ghost={showGhost ? ghost : undefined}
                  yMin={ZERO_BASED[metricKey] && series.values.length > 1 ? 0 : undefined}
                />
                {ghost && showGhost ? (
                  <p className="text-2xs text-muted-foreground">Пунктир — прошлый период той же длины.</p>
                ) : null}
              </>
            ) : (
              /* Expanded context switches BarChart into its rich mode (y ticks + value labels). */
              <ChartExpandedContext.Provider value={true}>
                <BarChart values={series.values} labels={series.labels} titles={titles} height={280} />
              </ChartExpandedContext.Provider>
            )}
          </section>

          {field && (
            <ChartSection title={`Топ постов по ${CONTRIB_LABEL[metricKey] ?? 'метрике'}`}>
              {contributors.length > 0 ? (
                <ul>
                  {contributors.map((post, i) => {
                    const value = Number(post[field] ?? 0);
                    const share = fieldSumAll > 0 ? Math.round((value / fieldSumAll) * 100) : 0;
                    const text = post.caption ? markdownToPlainText(post.caption) : 'Без подписи';
                    return (
                      <li key={post.id ?? i} className="border-t border-border first:border-t-0">
                        <button
                          type="button"
                          onClick={() => setOpenPost(post)}
                          className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-hover-row"
                        >
                          <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">
                            {i + 1}
                          </span>
                          {post.thumb ? (
                            <img
                              src={`${post.thumb}?size=sm`}
                              alt=""
                              referrerPolicy="no-referrer"
                              className="h-9 w-9 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-2xs text-muted-foreground">
                              текст
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{text}</span>
                          <span className="shrink-0 text-right">
                            <span className="block text-sm font-medium tabular-nums">{fmt.short(value)}</span>
                            {share > 0 && (
                              <span className="block text-2xs text-muted-foreground">
                                {share}
                                {SHARE_LABEL[metricKey] ?? '% периода'}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">Недостаточно данных за период.</div>
              )}
              {reconcile && <p className="text-xs text-muted-foreground">{reconcile}</p>}
            </ChartSection>
          )}
        </div>

        {/* Explore rail — breakdown + comparison + the plain-language definition (steep). */}
        <aside className="space-y-8">
          {breakdownItems.length > 0 && (
            <ChartSection title="Разбивка по формату">
              <Breakdown items={breakdownItems} />
            </ChartSection>
          )}

          <ChartSection title="Сравнение">
            {ghost && chartType === 'line' ? (
              <button
                type="button"
                role="switch"
                aria-checked={showGhost}
                onClick={() => setShowGhost((v) => !v)}
                className="mb-3 flex w-full items-center justify-between gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>Прошлый период на графике</span>
                <span
                  aria-hidden="true"
                  className={
                    showGhost
                      ? 'rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary'
                      : 'rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground'
                  }
                >
                  {showGhost ? 'вкл' : 'выкл'}
                </span>
              </button>
            ) : null}
            {compare ? (
              <div className="space-y-2 text-sm">
                <CompareRow label="Текущий период" value={compare.current} strong />
                <CompareRow label="Прошлый период" value={compare.previous} />
                {compare.note ? <p className="pt-1 text-2xs text-muted-foreground">{compare.note}</p> : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {metricKey === 'avgReach'
                  ? 'Парное сравнение для среднего не считается — Δ в заголовке идёт по дневному архиву охвата.'
                  : range
                    ? 'Для произвольного диапазона нет парного прошлого окна — выберите пресет (7д/30д/90д).'
                    : days === 0
                      ? 'Для окна «Всё» прошлого периода не существует.'
                      : 'В выборке нет данных за прошлое окно — сравнить периоды не с чем.'}
              </p>
            )}
          </ChartSection>

          <ChartSection title="О метрике">
            <dl className="space-y-3 text-sm">
              {def.formula && <AboutRow label="Как считается" text={def.formula} />}
              {def.included && <AboutRow label="Что учитывается" text={def.included} />}
              {def.source && <AboutRow label="Источник" text={def.source} />}
            </dl>
          </ChartSection>

          <Link
            to="/analytics"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>

      {openPost && (
        <PostDetailModal
          post={openPost}
          rank={contributors.indexOf(openPost) + 1}
          reason={null}
          onClose={() => setOpenPost(null)}
        />
      )}
    </div>
  );
}

interface CompareView {
  current: string;
  previous: string;
  note?: string | null;
}

/** Current-vs-previous readout per metric; null when there is no paired previous window. */
function buildCompare(
  metricKey: DrillKey,
  ctx: {
    range: boolean;
    days: number;
    windowTotals: { current: { views: number; reactions: number; forwards: number }; previous: { views: number; reactions: number; forwards: number } } | null;
    currentEngagement: number | null;
    previousEngagement: number | null;
    members: number;
    subsSpark: DailySeries;
    historyRows: { day: string; subscribers?: number | null }[];
    winTo: number;
  },
): CompareView | null {
  if (ctx.range || ctx.days <= 0) return null;
  const { windowTotals } = ctx;
  switch (metricKey) {
    case 'views':
      return windowTotals
        ? { current: fmt.short(windowTotals.current.views), previous: fmt.short(windowTotals.previous.views) }
        : null;
    case 'reactions':
      return windowTotals
        ? { current: fmt.short(windowTotals.current.reactions), previous: fmt.short(windowTotals.previous.reactions) }
        : null;
    case 'forwards':
      return windowTotals
        ? { current: fmt.short(windowTotals.current.forwards), previous: fmt.short(windowTotals.previous.forwards) }
        : null;
    case 'er': {
      if (ctx.members <= 0 || ctx.currentEngagement == null || ctx.previousEngagement == null) return null;
      const cur = (ctx.currentEngagement / ctx.members) * 100;
      const prev = (ctx.previousEngagement / ctx.members) * 100;
      return { current: `${cur.toFixed(2)}%`, previous: `${prev.toFixed(2)}%` };
    }
    case 'subscribers': {
      // Change WITHIN each window (end − start), from the daily archive.
      const change = (values: number[]) =>
        values.length >= 2 ? values[values.length - 1] - values[0] : null;
      const curChange = change(ctx.subsSpark.values);
      const prevRows = ctx.historyRows
        .filter((row) => {
          if (row.subscribers == null) return false;
          const t = Date.parse(row.day);
          return Number.isFinite(t) && t >= ctx.winTo - 2 * ctx.days * DAY_MS && t < ctx.winTo - ctx.days * DAY_MS;
        })
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((row) => Number(row.subscribers));
      const prevChange = change(prevRows);
      if (curChange == null || prevChange == null) return null;
      const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;
      return {
        current: signed(curChange),
        previous: signed(prevChange),
        note: 'Изменение внутри окна (конец − начало), по дневному архиву.',
      };
    }
    case 'avgReach':
      // Per-window post counts aren't part of the shared window math — the Δ pill in the
      // headline (daily-archive based) already carries the direction.
      return null;
  }
}

/** One cell of the line/bar chart-type switcher (steep's Explore icons, bounded segment). */
function ChartTypeButton({
  kind,
  active,
  onSelect,
}: {
  kind: 'line' | 'bar';
  active: boolean;
  onSelect: (k: 'line' | 'bar') => void;
}) {
  const label = kind === 'line' ? 'Линия' : 'Столбцы';
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      aria-label={`Тип графика: ${label}`}
      onClick={() => onSelect(kind)}
      className={`flex h-7 w-8 items-center justify-center transition-colors first:border-r first:border-border ${
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {kind === 'line' ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M1.5 11.5 5.5 7l3 2.5 5.5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
          <rect x="2" y="8" width="3" height="6" rx="0.5" />
          <rect x="6.5" y="4" width="3" height="10" rx="0.5" />
          <rect x="11" y="6" width="3" height="8" rx="0.5" />
        </svg>
      )}
    </button>
  );
}

function CompareRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={strong ? 'font-medium tabular-nums text-foreground' : 'tabular-nums text-ink2'}>{value}</span>
    </div>
  );
}

function AboutRow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-foreground">{text}</dd>
    </div>
  );
}

function MetricSkeleton() {
  // Mirrors the real layout (breadcrumb + hero + chart + rail) — no card/ledger swap on load.
  return (
    <div className="space-y-8">
      <Skeleton className="h-3 w-16" />
      <div>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-2 h-11 w-36" />
      </div>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Skeleton className="h-[280px] w-full" />
        <div className="space-y-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}
