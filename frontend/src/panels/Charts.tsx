import { lazy, Suspense, useMemo } from 'react';
import { useHistory, useVelocity, useTgFull } from '@/api/queries';
import type { TgFull } from '@/api/schemas';
import { CHART_MAX_POINTS, lttbDownsample } from '@/lib/downsample';
import { BarChart } from '@/components/BarChart';
import { LineChart } from '@/components/LineChart';
import { fmt, pluralRu, timeAxisFromDayKeys } from '@/lib/format';
import { ChartSkeleton as DataChartSkeleton } from '@/components/ui/dataSkeleton';
import { useWidgetPeriod } from '@/lib/period';
import { useWidgetInView } from '@/lib/widgetViewport';

import { ChartCardBody, ChartSection } from '@/components/ChartWidget';
import { seriesBarValuesVariant } from '@/components/widgets/variants';
import { pctDelta } from '@/lib/delta';
import type { WidgetViz } from '@/lib/widgetMetrics';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { buildHeatmap, TG_DAY_NAMES } from '@/lib/tgHeatmap';
import { HeatmapVerdict } from '@/components/HeatmapVerdict';

interface SubscriberRow {
  day: string;
  subscribers?: number | null;
}

/**
 * `expanded` — та же развилка, что у WidgetRenderer: числовые подписи максимума и последней точки
 * это мебель ПОВЕРХНОСТИ ДОКАЗАТЕЛЬСТВА. На лице карточки они налезают на кривую и дублируют
 * хедлайн (владелец: «показываются числа на графиках, убрать»); в развороте, где есть место и оси,
 * они полезны. Один и тот же компонент рисует оба вида, поэтому это проп, а не удаление.
 */
export function SubscriberHistoryChart({ rows, expanded = false }: { rows: SubscriberRow[]; expanded?: boolean }) {
  const sampled = lttbDownsample(rows, CHART_MAX_POINTS, (row) => Number(row.subscribers));
  const values = sampled.map((row) => Number(row.subscribers));
  const titles = sampled.map((row) => `${fmt.day(row.day)}: ${fmt.num(row.subscribers)} ${pluralRu(Number(row.subscribers), ['подписчик', 'подписчика', 'подписчиков'])}`);
  // Full per-point labels: the axis-free card shows first/mid/last itself, the explorer
  // strides them into a real x-axis (a pre-picked 3-label array would starve the axis).
  const labels = sampled.map((row) => fmt.day(row.day));

  // Standard 1×-tile chart height (the LineChart default, 200); the expanded overlay
  // supplies its own 400 via ExpandedChartHeightContext.
  return (
    <LineChart
      values={values}
      yMin={Math.min(...values)}
      yMax={Math.max(...values)}
      titles={titles}
      labels={labels}
      axisLabels={timeAxisFromDayKeys(sampled.map((row) => row.day))}
      markAnomalies
      markExtremes={expanded}
    />
  );
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
          return <SubscriberHistoryChart rows={windowRows} expanded />;
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
        ];
      }}
    />
  );
}

/** Bare, config-driven history body for Home. The surrounding ConfigWidget owns all card chrome. */
export function HistoryWidgetBody() {
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
      <SubscriberHistoryChart rows={rows} />
    </ChartCardBody>
  );
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

const ActivityCalendarBody = lazy(
  lazyWithReload(() => import('@/panels/ActivityCalendar').then((module) => ({ default: module.ActivityCalendarBody }))),
);
const HeatmapSurface = lazy(
  lazyWithReload(() => import('@/panels/HeatmapSurface').then((module) => ({ default: module.HeatmapSurface }))),
);

export function CalendarChartBlock({ id, homeKey }: HomeBlockProps = {}) {
  return (
    <ChartSection title="Календарь активности" defaultSize="full" id={id} homeKey={homeKey}>
      <CalendarWidgetBody />
    </ChartSection>
  );
}

/** Fixed-year body shared by Analytics and the pinnable Home card. It deliberately ignores the
    page/widget period: this view always answers the same trailing-365-day question. */
export function CalendarWidgetBody() {
  return (
    <Suspense fallback={<ChartSkeletonBody />}>
      <ActivityCalendarBody />
    </Suspense>
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
  const { grid, maxErv, bestSlot, quietSlot } = useMemo(() => buildHeatmap(posts, inRange), [posts, inRange]);
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
      {/* Вердикт ВЫШЕ сетки: ответ раньше доказательства (см. HeatmapVerdict). Заодно снимается
          дубль — тот же факт печатался и строкой снизу, и внутри aria-label самой сетки. */}
      <HeatmapVerdict
        peak={bestSlot ? { day: TG_DAY_NAMES[bestSlot.weekday] ?? '', hour: bestSlot.hour, value: ervVerdictValue(bestSlot.avgErv, bestSlot.n) } : null}
        quiet={quietSlot ? { day: TG_DAY_NAMES[quietSlot.weekday] ?? '', hour: quietSlot.hour, value: ervVerdictValue(quietSlot.avgErv, quietSlot.n) } : null}
      />
      <Suspense fallback={<ChartSkeletonBody />}>
        <HeatmapSurface grid={grid} maxErv={maxErv} bestSlot={bestSlot} hourRange={hourRange} />
      </Suspense>
      {/* Снизу остаётся только то, что относится к САМОЙ сетке: обрезанные края суток и честное
          «данных мало». Вердикта здесь больше нет — он наверху. */}
      {bestSlot ? (
        trimmed ? (
          <div className="mt-3 text-xs text-muted-foreground">
            Показаны часы {hourRange.from}:00–{hourRange.to}:00
          </div>
        ) : null
      ) : (
        <div className="mt-3 text-xs text-muted-foreground">Мало постов для тепловой карты.</div>
      )}
    </>
  );
}

/** «ERV 4.8% по 6 постам» — среднее слота вместе с тем, на скольких постах оно измерено: без `n`
    вердикт по одному посту выглядел бы так же уверенно, как по десяти. */
const ervVerdictValue = (avgErv: number, n: number) =>
  `ERV ${fmt.pctFixed(avgErv)} по ${n} ${pluralRu(n, ['посту', 'постам', 'постам'])}`;

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
