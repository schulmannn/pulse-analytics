import { useEffect, useMemo, useRef, useState } from 'react';
import { useHistory, useVelocity, useTgFull } from '@/api/queries';
import type { TgFull } from '@/api/schemas';
import { lttbDownsample } from '@/lib/downsample';
import { BarChart } from '@/components/BarChart';
import { DivergingBars } from '@/components/DivergingBars';
import { LineChart } from '@/components/LineChart';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { fmt, ruAxisLabel, pluralRu } from '@/lib/format';
import { ChartSkeleton as DataChartSkeleton } from '@/components/ui/dataSkeleton';
import { useWidgetPeriod } from '@/lib/period';
import { useWidgetInView } from '@/lib/widgetViewport';

import { ChartCardBody, ChartSection } from '@/components/ChartWidget';
import { seriesBarValuesVariant } from '@/components/widgets/variants';
import { pctDelta } from '@/lib/delta';
import type { WidgetViz } from '@/lib/widgetMetrics';
import type { WidgetSize } from '@/lib/widgetPrefsStore';

interface HeatmapCell {
  n: number;
  ervSum: number;
  reachSum: number;
}

interface SubscriberRow {
  day: string;
  subscribers?: number | null;
}

function ddmm(dayStr: string) {
  const parts = dayStr.split('-');
  if (parts.length !== 3) return dayStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = months[Number(parts[1]) - 1] ?? '';
  // ruAxisLabel: «18 May» → «18 мая» — chart axes/tooltips must be Russian in the RU UI.
  return ruAxisLabel(`${Number(parts[2])} ${monthLabel}`);
}

export function SubscriberHistoryChart({ rows }: { rows: SubscriberRow[] }) {
  const sampled = lttbDownsample(rows, 140, (row) => Number(row.subscribers));
  const values = sampled.map((row) => Number(row.subscribers));
  const titles = sampled.map((row) => `${ddmm(row.day)}: ${fmt.num(row.subscribers)} ${pluralRu(Number(row.subscribers), ['подписчик', 'подписчика', 'подписчиков'])}`);
  // Full per-point labels: the axis-free card shows first/mid/last itself, the explorer
  // strides them into a real x-axis (a pre-picked 3-label array would starve the axis).
  const labels = sampled.map((row) => ddmm(row.day));

  // Standard 1×-tile chart height (the LineChart default, 200); the expanded overlay
  // supplies its own 400 via ExpandedChartHeightContext.
  return (
    <LineChart
      values={values}
      yMin={Math.min(...values)}
      yMax={Math.max(...values)}
      titles={titles}
      labels={labels}
      markAnomalies
      markExtremes
    />
  );
}

/** Day-over-day deltas of the RAW archive rows, downsampled to ≤60 bars AFTER differencing.
    The series is a LEVEL (~4800 подписчиков): zero-based bars of levels all render full
    height and a decline disappears — the bar presentation plots the daily CHANGE instead. */
function subscriberDeltas(rows: SubscriberRow[]) {
  const deltas = rows.slice(1).map((row, i) => ({
    day: row.day,
    delta: Number(row.subscribers) - Number(rows[i]?.subscribers),
  }));
  const sampled = lttbDownsample(deltas, 60, (r) => r.delta);
  return {
    values: sampled.map((r) => r.delta),
    labels: sampled.map((r) => ddmm(r.day)),
    titles: sampled.map((r) => `${ddmm(r.day)}: ${r.delta >= 0 ? '+' : ''}${fmt.num(r.delta)} за день`),
  };
}

/** Bar presentation of the same archive (widget «Тип: Столбцы») — diverging day-over-day deltas. */
export function SubscriberHistoryBars({ rows }: { rows: SubscriberRow[] }) {
  const d = subscriberDeltas(rows);
  // 200 = the standard 1×-tile chart height, matching the line presentation.
  return <DivergingBars values={d.values} labels={d.labels} titles={d.titles} height={200} />;
}

/**
 * Charts blocks own their OWN ChartSection. To reuse them on the personal /home surface without
 * double-wrapping (a card inside a card + a second ⋯ menu), the caller passes a home-scoped
 * `id`/`homeKey`: the block's existing ChartSection takes that id so its Home prefs (size/title/
 * period) are a distinct identity from the /analytics copy, and its menu shows «Убрать с главной».
 * Omitted on /analytics → the block keeps its title-derived id and no pin item.
 */
interface HomeBlockProps {
  /** Home-scoped ChartSection id (e.g. 'home-history'); omit on the source screen. */
  id?: string;
  /** Registry key enabling the «На главную»/«Убрать с главной» ⋯ item. */
  homeKey?: string;
}

import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';

export function HistoryChartBlock({ id, homeKey }: HomeBlockProps = {}) {
  // isPending (не isLoading): запрос выключен, пока канал не известен, — скелетон и там.
  const { data, isPending, isError, refetch } = useHistory(730);

  if (isPending) {
    return (
      <ChartSkeleton
        title="История подписчиков"
        id={id}
        homeKey={homeKey}
        defaultSize="half"
        drillTo="/metrics/subscribers"
      />
    );
  }
  // Честная ошибка в СВОЕЙ карточке (dense-flow затянул бы дыру соседями — пропажа незаметна).
  if (isError) {
    return (
      <ChartSection title="История подписчиков" defaultSize="half" id={id} homeKey={homeKey} drillTo="/metrics/subscribers">
        <ErrorState title="Не удалось загрузить историю" onRetry={() => refetch()} />
      </ChartSection>
    );
  }
  if (!data || !data.enabled) {
    return (
      <ChartSection title="История подписчиков" defaultSize="half" id={id} homeKey={homeKey} drillTo="/metrics/subscribers">
        <EmptyState compact title="История подписчиков пока недоступна" />
      </ChartSection>
    );
  }

  const rawRows = data.rows ?? [];
  const archiveRows = rawRows
    .filter((row) => row.subscribers != null)
    .sort((a, b) => a.day.localeCompare(b.day));
  if (archiveRows.length < 2) {
    return (
      <ChartSection title="История подписчиков" defaultSize="half" id={id} homeKey={homeKey} drillTo="/metrics/subscribers">
        <EmptyState compact title="История подписчиков пока пуста" />
      </ChartSection>
    );
  }

  return (
    <ChartSection
      title="История подписчиков"
      defaultSize="half"
      id={id}
      homeKey={homeKey}
      drillTo="/metrics/subscribers"
      periodControl
      expand={{
        renderExpanded: (days) => {
          const windowRows = days === 0 ? archiveRows : archiveRows.slice(-days);
          return <SubscriberHistoryChart rows={windowRows} />;
        },
        renderExpandedBar: (days) => {
          const windowRows = days === 0 ? archiveRows : archiveRows.slice(-days);
          return <SubscriberHistoryBars rows={windowRows} />;
        },
        statsFor: (days) =>
          (days === 0 ? archiveRows : archiveRows.slice(-days)).map((row) => Number(row.subscribers)),
        statsSum: false, // сумма УРОВНЕЙ подписчиков по дням не имеет смысла
      }}
      variants={(period) => {
        const rows = archiveRows.filter((row) => period.inRange(row.day));
        if (rows.length < 2) {
          return [
            {
              key: 'line',
              label: 'Линия',
              render: <EmptyState compact title="Нет истории за выбранный период" />,
            },
          ];
        }
        const isDownsampled = rows.length > 140;
        const periodCaption = `${rows.length} дн. в периоде${isDownsampled ? ' · сглажено' : ''}`;
        const deltas = subscriberDeltas(rows);
        const last = Number(rows[rows.length - 1]?.subscribers ?? 0);
        const first = Number(rows[0]?.subscribers ?? 0);
        const levelDelta = first > 0 ? pctDelta(last, first) : null;
        const caption = levelDelta ? `к началу периода · ${periodCaption}` : periodCaption;
        return [
          {
            key: 'line',
            label: 'Линия',
            render: (
              <ChartCardBody value={fmt.kpi(last)} delta={levelDelta} caption={caption}>
                <SubscriberHistoryChart rows={rows} />
              </ChartCardBody>
            ),
          },
          {
            key: 'bar',
            label: 'Столбцы',
            render: (
              <ChartCardBody value={fmt.kpi(last)} delta={levelDelta} caption={caption}>
                <SubscriberHistoryBars rows={rows} />
              </ChartCardBody>
            ),
          },
          seriesBarValuesVariant(deltas.values, deltas.labels, deltas.titles, {
            diverging: true,
            extraRows: [{ label: 'Сейчас', value: fmt.num(last) }],
            sum: true,
            sumLabel: 'Δ за период',
          }),
        ];
      }}
    />
  );
}

/** Bare, config-driven history body for Home. The surrounding ConfigWidget owns all card chrome. */
export function HistoryWidgetBody({ viz }: { viz: WidgetViz }) {
  // Прогрессивная загрузка Главной: офскрин-пин не фетчит (вне Главной контекст = true).
  const inView = useWidgetInView();
  const { data, isPending, isError, refetch } = useHistory(730, { enabled: inView });
  const { inRange } = useWidgetPeriod();

  if (isPending) return <ChartSkeletonBody />;
  if (isError) return <ErrorState title="Не удалось загрузить историю" onRetry={() => refetch()} />;
  if (!data || !data.enabled) return <EmptyState compact title="История подписчиков пока недоступна" />;

  const rows = (data.rows ?? []).filter((row) => row.subscribers != null && inRange(row.day));
  if (rows.length < 2) return <EmptyState compact title="История подписчиков пока пуста" />;

  const last = Number(rows[rows.length - 1]?.subscribers ?? 0);
  const first = Number(rows[0]?.subscribers ?? 0);
  const delta = first > 0 ? pctDelta(last, first) : null;
  const archiveCaption = `${rows.length} дн. в периоде${rows.length > 140 ? ' · сглажено' : ''}`;
  const caption = delta ? `к началу периода · ${archiveCaption}` : archiveCaption;

  return (
    <ChartCardBody value={fmt.kpi(last)} delta={delta} caption={caption}>
      {viz === 'bar' ? <SubscriberHistoryBars rows={rows} /> : <SubscriberHistoryChart rows={rows} />}
    </ChartCardBody>
  );
}

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface HeatmapBestSlot {
  weekday: number;
  hour: number;
  avgErv: number;
  n: number;
  reachSum: number;
}

/** Aggregate posts into the 7×24 ERV grid + the best slot. Pure — memoized by the block. */
function buildHeatmap(
  posts: NonNullable<TgFull['posts']>,
  inRange: (dateISO: string | null | undefined) => boolean,
): { grid: HeatmapCell[][]; maxErv: number; bestSlot: HeatmapBestSlot | null } {
  const grid: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ n: 0, ervSum: 0, reachSum: 0 })),
  );

  posts.forEach((p) => {
    if (!inRange(p.date) || !p.date) return;
    const d = new Date(p.date);
    if (isNaN(d.getTime())) return;

    const weekday = (d.getDay() + 6) % 7;
    const hour = d.getHours();

    const row = grid[weekday];
    if (!row) return;
    const cell = row[hour];
    if (!cell) return;

    const reach = Number(p.views ?? 0);
    const eng = Number(p.reactions ?? 0) + Number(p.forwards ?? 0) + Number(p.replies ?? 0);
    const erv = reach > 0 ? (eng / reach) * 100 : null;

    cell.n++;
    cell.reachSum += reach;
    if (erv !== null) cell.ervSum += erv;
  });

  let maxErv = 0;
  let bestSlot: HeatmapBestSlot | null = null;
  let maxScore = -1;

  for (let w = 0; w < 7; w++) {
    const row = grid[w];
    if (!row) continue;
    for (let hr = 0; hr < 24; hr++) {
      const cell = row[hr];
      if (cell && cell.n > 0) {
        const avgErv = cell.ervSum / cell.n;
        if (avgErv > maxErv) maxErv = avgErv;
        const score = avgErv * (cell.n >= 2 ? 1.15 : 1);
        if (score > maxScore) {
          maxScore = score;
          bestSlot = { weekday: w, hour: hr, avgErv, n: cell.n, reachSum: cell.reachSum };
        }
      }
    }
  }

  return { grid, maxErv, bestSlot };
}

export function HeatmapChartBlock({ id, homeKey }: HomeBlockProps = {}) {
  return (
    // The 7×24 grid is genuinely wide content → a full-row tile wherever the section lands in a
    // widget grid. periodControl opts into the resolved period: the feed top bar owns it on work
    // pages, while a Home widget keeps an independent saved value.
    <ChartSection title="Тепловая карта активности" defaultSize="full" periodControl id={id} homeKey={homeKey} drillTo="/metrics/tg-heatmap">
      <HeatmapWidgetBody />
    </ChartSection>
  );
}

/** Bare, self-fetching heatmap body shared by the source card and ConfigWidget. */
export function HeatmapWidgetBody() {
  // Прогрессивная загрузка Главной: офскрин-пин не фетчит (вне Главной контекст = true).
  const inView = useWidgetInView();
  const { data, isPending } = useTgFull(0, { enabled: inView });
  if (isPending) return <ChartSkeletonBody />;
  return <HeatmapBody posts={data?.posts ?? []} />;
}

/** Aggregates + renders the 7×24 ERV grid for the resolved feed/Home window. Hover/tooltip state
    lives further down in HeatmapSurface, so a mousemove never re-runs this aggregation. */
function HeatmapBody({ posts }: { posts: NonNullable<TgFull['posts']> }) {
  const { inRange } = useWidgetPeriod();
  const { grid, maxErv, bestSlot } = useMemo(() => buildHeatmap(posts, inRange), [posts, inRange]);
  // Пустые края суток не рисуем: 7д-окно на полной 0–23 решётке = 90% мёртвых клеток («у канала
  // нет жизни»). Диапазон = активные часы ±1 для контекста; шире 16 колонок не сжимаем (экономия
  // нечитаема); совсем пустая решётка — полные сутки (внизу честное «мало постов»).
  const hourRange = useMemo(() => {
    let from = 24;
    let to = -1;
    grid.forEach((row) =>
      row?.forEach((cell, hr) => {
        if (cell && cell.n > 0) {
          if (hr < from) from = hr;
          if (hr > to) to = hr;
        }
      }),
    );
    if (to < 0) return { from: 0, to: 23 };
    const f = Math.max(0, from - 1);
    const t = Math.min(23, to + 1);
    return t - f + 1 <= 16 ? { from: f, to: t } : { from: 0, to: 23 };
  }, [grid]);
  const trimmed = hourRange.from > 0 || hourRange.to < 23;
  return (
    <>
      <HeatmapSurface grid={grid} maxErv={maxErv} bestSlot={bestSlot} hourRange={hourRange} />
      <div className="mt-3 text-xs font-medium text-muted-foreground">
        {bestSlot ? (
          <span>
            лучший слот:{' '}
            <strong className="text-foreground">
              {DAY_NAMES[bestSlot.weekday] ?? ''} {bestSlot.hour}:00
            </strong>{' '}
            · ERV {bestSlot.avgErv.toFixed(1)}%
            {trimmed ? (
              <span className="text-muted-foreground"> · часы {hourRange.from}:00–{hourRange.to}:00</span>
            ) : null}
          </span>
        ) : (
          'Мало постов для тепловой карты.'
        )}
      </div>
    </>
  );
}

/** The interactive heatmap surface — owns the tooltip state so hovering re-renders only
    this leaf (cheap cell mapping), never the parent's aggregation. */
function HeatmapSurface({
  grid,
  maxErv,
  bestSlot,
  hourRange,
}: {
  grid: HeatmapCell[][];
  maxErv: number;
  bestSlot: HeatmapBestSlot | null;
  hourRange: { from: number; to: number };
}) {
  const [tip, setTip] = useState<TooltipState>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Тултип не должен зависать при прокрутке/потере фокуса — mouseleave при колесе не срабатывает
  // (канон BarChart/PieChart, дизайн-проход №3).
  const hasTip = tip !== null;
  useEffect(() => {
    if (!hasTip) return;
    const clear = () => setTip(null);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur-sm', clear);
    };
  }, [hasTip]);
  // Видимые часы (сжатый диапазон из HeatmapBody). Подпись — «6:00», не голое «6»: на сжатом
  // 7д-окне колонок мало и цифры без «:00» читались как непонятные числа/даты (проход №3).
  // Плотность подписей — по ширине формата: «6:00» шире голой цифры, каждый час подписываем
  // только на узких диапазонах.
  const hours = Array.from({ length: hourRange.to - hourRange.from + 1 }, (_, i) => hourRange.from + i);
  const cols = `30px repeat(${hours.length}, minmax(14px, 1fr))`;
  const labelStride = hours.length <= 8 ? 1 : hours.length <= 16 ? 2 : 3;

  return (
    <div ref={wrapRef} className="relative" onMouseLeave={() => setTip(null)}>
      <div className="overflow-x-auto pb-2">
        <div className="min-w-[420px] space-y-[2px]">
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: cols }}>
            <div />
            {hours.map((hr) => (
              <div key={hr} className="select-none whitespace-nowrap text-center text-2xs font-medium tabular-nums text-muted-foreground">
                {hr % labelStride === 0 ? `${hr}:00` : ''}
              </div>
            ))}
          </div>

          {DAY_NAMES.map((dayName, w) => {
            const currentRow = grid[w] ?? [];
            return (
              <div
                key={w}
                className="grid items-center gap-[2px]"
                style={{ gridTemplateColumns: cols }}
              >
                <div className="select-none text-2xs font-medium text-muted-foreground">{dayName}</div>
                {hours.map((hr) => {
                  const cell = currentRow[hr];
                  if (!cell || cell.n === 0) {
                    return (
                      <div
                        key={hr}
                        className="h-4 rounded-sm bg-muted/40"
                        onMouseMove={() => setTip(null)}
                      />
                    );
                  }
                  const avgErv = cell.ervSum / cell.n;
                  const opacity = maxErv > 0 ? Math.max(0.18, avgErv / maxErv) : 0;
                  const isBest = bestSlot && bestSlot.weekday === w && bestSlot.hour === hr;
                  const titleText = `${dayName} ${hr}:00 · ${cell.n} ${pluralRu(cell.n, ['пост', 'поста', 'постов'])} · ERV ${avgErv.toFixed(1)}% · ср.охват ${fmt.short(cell.reachSum / cell.n)}`;
                  return (
                    <div
                      key={hr}
                      className={`relative h-4 cursor-crosshair rounded-sm${isBest ? ' border-2 border-verdant' : ''}`}
                      style={{
                        backgroundColor: 'hsl(var(--brand-iris))',
                        opacity,
                      }}
                      onMouseMove={(event) => {
                        const rect = wrapRef.current?.getBoundingClientRect();
                        if (rect) setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, text: titleText });
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <ChartTooltip tip={tip} />
    </div>
  );
}

export function VelocityChartBlock({ id, homeKey }: HomeBlockProps = {}) {
  const { data, isPending } = useVelocity();

  if (isPending) {
    return (
      <ChartSkeleton
        title="Скорость набора просмотров"
        id={id}
        homeKey={homeKey}
        defaultSize="half"
        drillTo="/metrics/tg-velocity"
      />
    );
  }

  const available = data?.available ?? false;
  const byDay = data?.by_day ?? [];

  if (!available || byDay.length < 2) {
    return (
      <ChartSection title="Скорость набора просмотров" id={id} homeKey={homeKey} defaultSize="half" drillTo="/metrics/tg-velocity">
        <LineChart values={[]} />
      </ChartSection>
    );
  }

  const cum = byDay.map((p) => p.cum);
  const titles = byDay.map((p) => `${p.day + 1}-е сутки: накоплено ${p.cum}% · доля дня ${p.share}%`);
  const labels = byDay.map((p) => `${p.day + 1}д`);

  const day1 = data?.day1_share ?? cum[0] ?? 0;
  const captions: string[] = [];
  if (data?.t80_days != null) captions.push(`80% за ${data.t80_days} дн`);
  if (data?.posts_used != null) captions.push(`по ${data.posts_used} постам`);

  return (
    <ChartSection
      title="Скорость набора просмотров"
      id={id}
      homeKey={homeKey}
      defaultSize="half"
      drillTo="/metrics/tg-velocity"
      variants={[
        {
          key: 'line',
          label: 'Линия',
          render: (
            <ChartCardBody label="за 1-е сутки" value={`${day1}%`} caption={captions.length > 0 ? captions.join(' · ') : undefined}>
              <LineChart values={cum} yMin={0} yMax={Math.max(...cum, 1)} titles={titles} labels={labels} />
            </ChartCardBody>
          ),
        },
        {
          key: 'bar',
          label: 'Столбцы',
          render: (
            <ChartCardBody label="за 1-е сутки" value={`${day1}%`} caption={captions.length > 0 ? captions.join(' · ') : undefined}>
              <BarChart values={cum} labels={labels} titles={titles} />
            </ChartCardBody>
          ),
        },
        seriesBarValuesVariant(cum, labels, titles, { format: (v) => `${v}%` }),
      ]}
    />
  );
}

/** Bare, config-driven velocity body for Home. */
export function VelocityWidgetBody({ viz }: { viz: WidgetViz }) {
  // Прогрессивная загрузка Главной: офскрин-пин не фетчит (вне Главной контекст = true).
  const inView = useWidgetInView();
  const { data, isPending } = useVelocity({ enabled: inView });
  if (isPending) return <ChartSkeletonBody />;

  const byDay = data?.by_day ?? [];
  if (!(data?.available ?? false) || byDay.length < 2) return <LineChart values={[]} />;

  const values = byDay.map((point) => point.cum);
  const titles = byDay.map(
    (point) => `${point.day + 1}-е сутки: накоплено ${point.cum}% · доля дня ${point.share}%`,
  );
  const labels = byDay.map((point) => `${point.day + 1}д`);
  const day1 = data?.day1_share ?? values[0] ?? 0;
  const captions: string[] = [];
  if (data?.t80_days != null) captions.push(`80% за ${data.t80_days} дн`);
  if (data?.posts_used != null) captions.push(`по ${data.posts_used} постам`);

  return (
    <ChartCardBody
      label="за 1-е сутки"
      value={`${day1}%`}
      caption={captions.length > 0 ? captions.join(' · ') : undefined}
    >
      {viz === 'bar' ? (
        <BarChart values={values} labels={labels} titles={titles} />
      ) : (
        <LineChart values={values} yMin={0} yMax={Math.max(...values, 1)} titles={titles} labels={labels} />
      )}
    </ChartCardBody>
  );
}

function ChartSkeleton({
  title,
  id,
  homeKey,
  defaultSize,
  drillTo,
}: {
  title: string;
  id?: string;
  homeKey?: string;
  defaultSize?: WidgetSize;
  drillTo?: string;
}) {
  return (
    <ChartSection title={title} id={id} homeKey={homeKey} defaultSize={defaultSize} drillTo={drillTo}>
      <ChartSkeletonBody />
    </ChartSection>
  );
}

function ChartSkeletonBody() {
  return <DataChartSkeleton />;
}
