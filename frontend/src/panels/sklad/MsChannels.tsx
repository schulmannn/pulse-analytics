import { useContext, useMemo, useState } from 'react';
import { WidgetGrid } from '@/components/widgets/WidgetGrid';
import { ShareTrack } from '@/components/ShareRows';
import { useMsChannelSeries, useMsGeography, useMsSalesByChannel } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { MultiLineChart } from '@/components/MultiLineChart';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import { fmt, pluralRu, timeAxisFromDayKeys } from '@/lib/format';
import { formatMoney } from '@/lib/metricNumber';
import { usePagePeriod } from '@/lib/period';
import { msPreviousPeriod, useMsPagePeriod, type MsPeriod } from '@/lib/msPeriod';
import { useSelectedChannel } from '@/lib/channel-context';
import { msChannelFilterKey, normalizeMsChannelFilter } from '@/lib/msChannelFilter';
import { useSavedFilter } from '@/lib/widgetPrefsStore';
import {
  buildMsChannelContributionItems,
  msChannelContributionCurrent,
  msChannelContributionDelta,
  sortMsChannelContributionItems,
  type MsChannelContributionMetric,
  type MsSalesByChannelData,
} from '@/lib/msChannelContribution';
import {
  aggregatePlotPoints,
  bucketPoints,
  densifyDayPoints,
  fmtMetric,
  metricTotal,
  metricValue,
  pickIndexes,
  CHART_MAX_POINTS,
  GRAIN_BUCKET_WORD,
  METRIC_LABEL,
  type Grain,
  type Metric,
} from '@/lib/msSeries';

/**
 * «Каналы» МойСклада — откуда приходят продажи (salesChannel на заказе) + география доставки.
 * «Выручка по каналу» перешла со Steep-паттерна одного PillSelect на честный МУЛЬТИвыбор внутри
 * графика: по умолчанию все каналы агрегированы (фильтр = агрегация выбранных), можно выбрать
 * несколько, а «Разбить по каналам» рисует их отдельными сериями (bounded читаемым лимитом).
 * Развёрнутый режим переиспользует общий ChartExpandOverlay (фокус-трап, период/грануляция/линия-
 * столбцы) и добавляет MS-контролы через shared `expand.extraControls` — без MS-only модалки.
 */
export function MsChannels() {
  const pp = usePagePeriod();
  const { channelId } = useSelectedChannel();
  const period = useMsPagePeriod();
  const days = pp ? pp.days : 30;
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const channels = useMsSalesByChannel(period);
  const previousPeriod = useMemo(() => msPreviousPeriod(period), [period]);
  const previousChannels = useMsSalesByChannel(previousPeriod ?? period);
  const geo = useMsGeography(period);
  const channelOptions = useMemo(
    () => (channels.data?.rows ?? []).map((r) => ({ id: r.sales_channel_id, name: r.name ?? 'Канал без имени' })),
    [channels.data],
  );
  const savedFilter = useSavedFilter(msChannelFilterKey(channelId));
  const selectedChannels = useMemo(
    () => normalizeMsChannelFilter(savedFilter),
    [savedFilter],
  );

  if (channels.isError) {
    return (
      <ErrorState
        title="Не удалось получить каналы продаж"
        reason={channels.error instanceof Error ? channels.error.message : 'ошибка'}
        onRetry={() => channels.refetch()}
        retrying={channels.isFetching}
      />
    );
  }

  return (
    <WidgetGrid className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <MsChannelDynamicsCard
        period={period}
        windowLabel={windowLabel}
        options={channelOptions}
        selected={selectedChannels}
      />

      <ChartWidget id="ms-channel-contribution" title="Что изменило результат" fixedSize="full" drillTo="/metrics/ms-sales-channels">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : !channels.data || channels.data.total_orders === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <MsChannelContribution
            current={channels.data}
            previous={previousPeriod && !previousChannels.isError ? (previousChannels.data ?? null) : null}
            comparisonState={
              !previousPeriod ? 'unavailable' : previousChannels.isError ? 'error' : previousChannels.isPending ? 'pending' : 'ready'
            }
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-channels" title={`Продажи по каналам ${windowLabel}`} fixedSize="full" drillTo="/metrics/ms-sales-channels">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : !channels.data || channels.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <MsChannelRows
            rows={channels.data.rows}
            totalOrders={channels.data.total_orders}
            noChannel={channels.data.no_channel_orders}
            noChannelSum={channels.data.no_channel_sum}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-geography" title={`География заказов ${windowLabel}`} fixedSize="full" drillTo="/metrics/ms-geography">
        {geo.isPending ? (
          <ListSkeleton rows={5} />
        ) : geo.isError ? (
          <ErrorState
            compact
            size="table"
            title="Не удалось получить географию заказов"
            reason={geo.error instanceof Error ? geo.error.message : 'ошибка'}
            onRetry={() => geo.refetch()}
            retrying={geo.isFetching}
          />
        ) : !geo.data || geo.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет городов доставки за период." />
        ) : (
          <MsGeographyRows rows={geo.data.rows} noCity={geo.data.no_city_orders} totalOrders={geo.data.total_orders} />
        )}
      </ChartWidget>
    </WidgetGrid>
  );
}

// ── Метрики оси каналов ────────────────────────────────────────────────────────────────────
export type View = 'aggregate' | 'breakdown';
export type ChannelOption = { id: string; name: string };

// Отдельные серии breakdown ограничены читаемым лимитом (steep: пёстрый частокол не читается).
const MAX_BREAKDOWN_SERIES = 6;
// Категориальная палитра канона (--chart-1..6, Okabe-Ito) — серия = идентичность, не оценка.
const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `hsl(var(--chart-${n}))`);

function ListSkeleton({ rows }: { rows: number }) {
  return <TableSkeleton rows={rows} columns={4} className="py-2" />;
}

/**
 * «Выручка по каналу» — обзорная карточка с разворотом в общий explorer. Фильтр каналов намеренно
 * не редактируется внутри карточки: она читает сохранённый source-scoped выбор полноэкранной
 * страницы, а metric/view остаются быстрыми локальными переключателями представления.
 */
function MsChannelDynamicsCard({
  period,
  windowLabel,
  options,
  selected,
}: {
  period: MsPeriod;
  windowLabel: string;
  options: ChannelOption[];
  selected: string[];
}) {
  const [metric, setMetric] = useState<Metric>('revenue');
  const [view, setView] = useState<View>('aggregate');
  const breakdown = view === 'breakdown';
  const filterLabel = selected.length > 0 ? ` · ${selected.length} кан.` : '';

  return (
    <ChartWidget
      id="ms-channel-series"
      title={`${METRIC_LABEL[metric]} по каналам ${windowLabel}${filterLabel}`}
      fixedSize="full"
      drillTo="/metrics/ms-channels"
    >
      <div className="mb-3">
        <MsChannelControls
          metric={metric}
          onMetric={setMetric}
          view={view}
          onView={setView}
        />
      </div>
      <MsChannelChart period={period} metric={metric} breakdown={breakdown} selected={selected} options={options} kind="line" />
    </ChartWidget>
  );
}

/** Быстрые MS-контролы представления. Фильтр данных живёт отдельно в fullscreen rail. */
export function MsChannelControls({
  metric,
  onMetric,
  view,
  onView,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  view: View;
  onView: (v: View) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        ariaLabel="Метрика"
        value={metric}
        onChange={(m) => onMetric(m as Metric)}
        options={[
          { value: 'revenue', content: 'Выручка' },
          { value: 'orders', content: 'Заказы' },
          { value: 'aov', content: 'Средний чек' },
        ]}
      />
      <SegmentedControl
        ariaLabel="Вид"
        value={view}
        onChange={(v) => onView(v as View)}
        options={[
          { value: 'aggregate', content: 'Итог' },
          { value: 'breakdown', content: 'По каналам' },
        ]}
      />
    </div>
  );
}

/** График оси каналов: агрегат (одна линия/столбцы) или разбивка (до 6 линий). Сам тянет данные
    для своего окна — переиспользуется и в карточке, и в explorer'е (там своё окно из пилюль). */
export function MsChannelChart({
  period,
  metric,
  breakdown,
  selected,
  options,
  grain = 'day',
  kind,
}: {
  period: MsPeriod;
  metric: Metric;
  breakdown: boolean;
  selected: string[];
  options: ChannelOption[];
  grain?: Grain;
  kind: 'line' | 'bar';
}) {
  const series = useMsChannelSeries(period, { channels: selected, breakdown });
  const expandedHeight = useContext(ExpandedChartHeightContext);
  const nameById = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);

  // Тяжёлые дериваты окна (densify до 730 дн, у разбивки ×6 серий, бакетинг + подписи) — мемо по
  // данным/окну/грануляции/метрике, а не на каждый рендер; хук ДО early-return (React #310).
  const data = series.data;
  const model = useMemo(() => {
    if (!data) return null;
    // Разбивка по каналам: отдельные серии (ограничены читаемым лимитом, честно подписан остаток).
    if (breakdown && data.groups && data.groups.length > 0) {
      const groups = data.groups.slice(0, MAX_BREAKDOWN_SERIES);
      // Общее окно всех групп: для «Всё» (window зависит от первого дня) берём МИНИМАЛЬНЫЙ день по
      // всем группам, чтобы линии densify'ились в одну сетку и X совпадал. Затем densify → бакетинг.
      const firstDay = groups
        .flatMap((g) => g.series.map((p) => p.day))
        .reduce<string | undefined>((a, b) => (a && a < b ? a : b), undefined);
      const bucketed = groups.map((g) => bucketPoints(densifyDayPoints(g.series, period, firstDay), grain));
      const gridDays = bucketed[0] ? bucketed[0].map((p) => p.day) : [];
      const strideIdx = pickIndexes(gridDays.length, CHART_MAX_POINTS);
      return {
        kind: 'breakdown' as const,
        groupCount: groups.length,
        groupTotal: data.group_total ?? null,
        labels: strideIdx.map((i) => fmt.day(gridDays[i])),
        chartSeries: groups.map((g, gi) => ({
          name: nameById.get(g.sales_channel_id) ?? 'Канал',
          color: SERIES_COLORS[gi % SERIES_COLORS.length],
          values: strideIdx.map((i) => (bucketed[gi][i] ? metricValue(metric, bucketed[gi][i]) : null)),
        })),
      };
    }
    // Агрегат (все или выбранные каналы одной серией). Дозаполняем дневную сетку окна нулями,
    // ЗАТЕМ группируем по грануляции (порядок важен: бакетинг сырых редких дней потерял бы нули).
    const bucketed = bucketPoints(densifyDayPoints(data.series, period), grain);
    // Средний чек: рисуем ТОЛЬКО бакеты с заказами непрерывным рядом наблюдений (бакет без заказов
    // даёт неопределённый чек → null → общий LineChart рвёт линию в россыпь точек). Выручку/заказы
    // оставляем полной сеткой с честными нулями. Настоящие даты бакетов сохраняются.
    const points = aggregatePlotPoints(bucketed, metric, CHART_MAX_POINTS);
    return {
      kind: 'aggregate' as const,
      count: points.length,
      values: points.map((p) => metricValue(metric, p)),
      labels: points.map((p) => fmt.day(p.day)),
      // Временна́я ось (timeAxisCore): буквы короткого окна / EN-месяцы длинного.
      axisLabels: timeAxisFromDayKeys(points.map((p) => p.day), { monthsOnly: grain !== 'day' }),
      titles: points.map((p) => `${fmt.day(p.day)}: ${fmtMetric(metric, metricValue(metric, p))}`),
      total: metricTotal(data.series, metric),
    };
  }, [data, period, grain, metric, breakdown, nameById]);

  if (series.isPending) return <ChartSkeleton className="py-2" />;
  if (series.isError) {
    return (
      <ErrorState
        compact
        size="chart"
        title="Не удалось получить динамику каналов"
        reason={series.error instanceof Error ? series.error.message : 'ошибка'}
        onRetry={() => series.refetch()}
        retrying={series.isFetching}
      />
    );
  }
  if (!model) return null;

  if (model.kind === 'breakdown') {
    const hiddenTotal = model.groupTotal ?? selected.length;
    return (
      <div>
        <MultiLineChart
          series={model.chartSeries}
          labels={model.labels}
          height={expandedHeight ?? 200}
          format={(v) => fmtMetric(metric, v ?? null)}
          bridgeGaps={metric === 'aov'}
          ariaLabel={`${METRIC_LABEL[metric]} по каналам`}
          legend={`${METRIC_LABEL[metric]}${metric === 'aov' ? ' · только периоды с заказами' : ''}`}
        />
        {hiddenTotal > model.groupCount && (
          <p className="mt-2 text-2xs text-muted-foreground">
            Показаны первые {model.groupCount} каналов из {hiddenTotal} — разбивка ограничена для читаемости.
          </p>
        )}
        {breakdown && selected.length === 0 && (
          <p className="mt-2 text-2xs text-muted-foreground">Выберите каналы, чтобы разбить график по каждому.</p>
        )}
      </div>
    );
  }

  if (breakdown && selected.length === 0) {
    return <EmptyState compact size="chart" title="Выберите каналы, чтобы разбить график по каждому." />;
  }

  if (model.count < 2) {
    return (
      <EmptyState
        compact
        size="chart"
        title={metric === 'aov'
          ? 'Недостаточно бакетов с заказами для среднего чека за период.'
          : 'Недостаточно данных по каналу за период.'}
        reason={metric === 'aov'
          ? undefined
          : 'Если каналы пусты — запустите повторную загрузку истории на «Подключении».'}
      />
    );
  }
  const { values, labels, axisLabels, titles, total } = model;
  const channelCaption =
    selected.length === 0 ? 'Все каналы' : `${selected.length} ${pluralRu(selected.length, ['канал', 'канала', 'каналов'])}`;
  // Средний чек агрегируется по бакетам с заказами — подписываем это честно (день/неделя/месяц).
  const caption = metric === 'aov' ? `${channelCaption} · по ${GRAIN_BUCKET_WORD[grain]} с заказами` : channelCaption;

  return (
    <ChartCardBody value={fmtMetric(metric, total)} caption={caption}>
      {kind === 'bar' ? (
        <BarChart values={values.map((v) => v ?? 0)} labels={labels} axisLabels={axisLabels} titles={titles} height={expandedHeight ?? undefined} />
      ) : (
        <LineChart values={values} labels={labels} axisLabels={axisLabels} titles={titles} yMin={0} height={expandedHeight ?? undefined} />
      )}
    </ChartCardBody>
  );
}

/** Компактный мультисерийный SVG (до 6 линий) в категориальной палитре. preserveAspectRatio=none
    растягивает viewBox неравномерно → обводки обязаны нести non-scaling-stroke (канон графиков). */

// Тип канала МС → короткий русский ярлык (тихий, muted): группирует источники, не кричит.
const CHANNEL_TYPE_LABEL: Record<string, string> = {
  ECOMMERCE: 'Сайт',
  DIRECT_SALES: 'Прямые',
  MARKETPLACE: 'Маркетплейс',
  SOCIAL_NETWORK: 'Соцсети',
  OTHER: 'Другое',
};

type SalesRow = { sales_channel_id: string; name: string | null; type: string | null; orders: number; sum: number };
type SortKey = 'revenue' | 'orders' | 'aov' | 'name';

/** Каналы продаж с явной сортировкой (выручка/заказы/средний чек/имя), долей выручки и средним
    чеком по строке. Свёрнуто — топ-8, разворот — все; строку без канала бэк выносит в noChannel. */
export function MsChannelRows({
  rows,
  totalOrders,
  noChannel,
  noChannelSum,
}: {
  rows: SalesRow[];
  totalOrders: number;
  noChannel: number;
  noChannelSum: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [sort, setSort] = useState<SortKey>('revenue');
  const aov = (r: SalesRow) => (r.orders > 0 ? r.sum / r.orders : 0);
  const totalSum = useMemo(() => rows.reduce((a, r) => a + r.sum, noChannelSum), [rows, noChannelSum]);
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      if (sort === 'name') return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      if (sort === 'orders') return b.orders - a.orders || b.sum - a.sum;
      if (sort === 'aov') return aov(b) - aov(a);
      return b.sum - a.sum || b.orders - a.orders;
    });
    return arr;
  }, [rows, sort]);
  const shown = expanded ? sorted : sorted.slice(0, 8);
  const restOrders = (expanded ? [] : sorted.slice(8)).reduce((acc, r) => acc + r.orders, 0) + noChannel;

  return (
    <div className="space-y-2.5 pt-1">
      <div className="flex items-center gap-2">
        <span className="text-2xs text-muted-foreground">Сортировать:</span>
        <SegmentedControl
          ariaLabel="Сортировка каналов"
          value={sort}
          onChange={(s) => setSort(s as SortKey)}
          options={[
            { value: 'revenue', content: 'Выручка' },
            { value: 'orders', content: 'Заказы' },
            { value: 'aov', content: 'Ср. чек' },
            { value: 'name', content: 'Имя' },
          ]}
        />
      </div>
      {shown.map((r) => {
        const share = totalSum > 0 ? Math.round((r.sum / totalSum) * 100) : 0;
        return (
          <div key={r.sales_channel_id}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-baseline gap-2 text-foreground">
                <span className="truncate">{r.name ?? 'Канал без имени'}</span>
                {r.type && CHANNEL_TYPE_LABEL[r.type] && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{CHANNEL_TYPE_LABEL[r.type]}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{formatMoney(r.sum, 'axis')}</span> · {share}% · {fmt.num(r.orders)}{' '}
                {pluralRu(r.orders, ['заказ', 'заказа', 'заказов'])} · ср. {formatMoney(aov(r), 'axis')}
              </span>
            </div>
            {/* Доля от ЦЕЛОГО, а не от лидера: канал с 40% выручки и должен занимать 40% дорожки. */}
            <div className="mt-1 flex">
              <ShareTrack pct={totalSum > 0 ? (r.sum / totalSum) * 100 : 0} height="h-1.5" />
            </div>
          </div>
        );
      })}
      {restOrders > 0 && (
        <p className="text-2xs text-muted-foreground">
          {expanded ? 'Из них' : 'Ещё'} {fmt.num(restOrders)}{' '}
          {noChannel > 0 ? `заказов (без канала ${fmt.num(noChannel)} · ${formatMoney(noChannelSum, 'axis')})` : 'заказов'} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}

// ── Вклад каналов: текущее окно против равного предыдущего ────────────────────────────────────

/**
 * Величина вклада БЕЗ знака: направление в этой строке уже сказано стрелкой.
 *
 * Было «↑+99.3k ₽₽» — три ошибки в одной строке: стрелка и плюс говорили одно и то же, а знак
 * валюты дописывался поверх строки, которая его уже несёт (аудит #554, D4). Знак валюты
 * добавляет ТОЛЬКО formatMoney (см. lib/metricNumber).
 */
function unsignedValue(delta: number, metric: MsChannelContributionMetric): string {
  return metric === 'revenue'
    ? formatMoney(Math.abs(delta), 'axis')
    : fmt.num(Math.abs(delta));
}

/**
 * Decision view rather than another ranking: current share and signed absolute change against the
 * exactly equal previous window. Positive and negative deltas reconcile to the overall change;
 * previous-only channels and the explicit «Без канала» row remain visible.
 */
export function MsChannelContribution({
  current,
  previous,
  comparisonState,
  metric: metricProp,
  onMetric,
}: {
  current: MsSalesByChannelData;
  previous: MsSalesByChannelData | null;
  comparisonState: 'ready' | 'pending' | 'error' | 'unavailable' | 'disabled';
  /** Optional controlled binding for the canonical full metric page; compact cards stay local. */
  metric?: MsChannelContributionMetric;
  onMetric?: (metric: MsChannelContributionMetric) => void;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [metricState, setMetricState] = useState<MsChannelContributionMetric>('revenue');
  const metric = metricProp ?? metricState;
  const setMetric = onMetric ?? setMetricState;
  const comparable = comparisonState === 'ready' && previous != null;
  const items = useMemo(
    () => buildMsChannelContributionItems(current, comparable ? previous : null),
    [current, previous, comparable],
  );
  const sorted = useMemo(
    () => sortMsChannelContributionItems(items, metric, comparable),
    [items, metric, comparable],
  );
  const shown = useMemo(() => {
    if (expanded || sorted.length <= 8) return sorted;
    const synthetic = sorted.find((item) => item.synthetic);
    const regular = sorted.filter((item) => !item.synthetic).slice(0, synthetic ? 7 : 8);
    return synthetic ? [...regular, synthetic] : regular;
  }, [expanded, sorted]);
  const shownIds = useMemo(() => new Set(shown.map((item) => item.id)), [shown]);
  const hidden = sorted.filter((item) => !shownIds.has(item.id));
  const total = items.reduce((sum, item) => sum + msChannelContributionCurrent(item, metric), 0);
  const hiddenValue = hidden.reduce((sum, item) => sum + msChannelContributionCurrent(item, metric), 0);

  return (
    <div className="space-y-2.5 pt-1">
      <SegmentedControl
        ariaLabel="Метрика вклада каналов"
        value={metric}
        onChange={(value) => setMetric(value as MsChannelContributionMetric)}
        options={[
          { value: 'revenue', content: 'Выручка' },
          { value: 'orders', content: 'Заказы' },
        ]}
      />
      {comparisonState === 'unavailable' && (
        <p className="text-2xs text-muted-foreground">
          Для окна «Всё» нет равного предыдущего периода — показана только текущая доля.
        </p>
      )}
      {comparisonState === 'pending' && <p className="text-2xs text-muted-foreground">Загружаем равный предыдущий период…</p>}
      {comparisonState === 'error' && (
        <p role="status" className="text-2xs text-muted-foreground">
          Сравнение с предыдущим периодом недоступно. Текущие значения показаны без подстановки нулей.
        </p>
      )}
      {shown.map((it) => {
        const currentValue = msChannelContributionCurrent(it, metric);
        const share = total > 0 ? (currentValue / total) * 100 : 0;
        const delta = msChannelContributionDelta(it, metric);
        return (
          <div key={it.id}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-baseline gap-2 text-foreground">
                <span className={`truncate ${it.synthetic ? 'text-muted-foreground' : ''}`}>{it.name}</span>
                {it.type && CHANNEL_TYPE_LABEL[it.type] && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{CHANNEL_TYPE_LABEL[it.type]}</span>
                )}
              </span>
              <span className="flex shrink-0 items-baseline gap-2 tabular-nums text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground">
                    {metric === 'revenue' ? `${formatMoney(currentValue, 'axis')}` : fmt.num(currentValue)}
                  </span>{' '}
                  · {fmt.pctFixed(share, 1)}
                </span>
                {/* Тихий регистр дельты (канон DeltaPill): направление — в знаке/стрелке, не в
                    оценочном цвете — «ничего не кричит». */}
                {comparable && delta != null && (
                  <span
                    className="inline-flex items-center gap-0.5 text-2xs text-muted-foreground"
                    title="Изменение против равного предыдущего окна"
                  >
                    {/* Направление несёт СТРЕЛКА; знак «+/−» внутри значения был бы вторым
                        голосом об одном и том же («↑+99.3k»). */}
                    <span aria-hidden="true">{delta > 0 ? '↑' : delta < 0 ? '↓' : '•'}</span>
                    {unsignedValue(delta, metric)}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 flex">
              <ShareTrack pct={currentValue === 0 ? 0 : share} height="h-1.5" muted={it.synthetic} />
            </div>
          </div>
        );
      })}
      {hiddenValue > 0 && (
        <p className="text-2xs text-muted-foreground">
          Ещё {metric === 'revenue' ? `${formatMoney(hiddenValue, 'axis')}` : `${fmt.num(hiddenValue)} ${pluralRu(hiddenValue, ['заказ', 'заказа', 'заказов'])}`} в свёрнутых каналах.
        </p>
      )}
      {comparable && (
        <p className="text-2xs text-muted-foreground">
          Положительные и отрицательные изменения каналов, включая «Без канала», в сумме дают общее изменение.
        </p>
      )}
    </div>
  );
}

/** Топ городов доставки: compact показывает пять строк и честный хвост; разворот — все города. */
export function MsGeographyRows({
  rows,
  noCity,
  totalOrders,
}: {
  rows: Array<{ city: string; orders: number; sum: number }>;
  noCity: number;
  totalOrders: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 5);
  const hiddenCities = expanded ? 0 : Math.max(0, rows.length - shown.length);
  const cityRows = shown.map((r) => (
    <div key={r.city}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-foreground">{r.city}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{fmt.num(r.orders)}</span> · {formatMoney(r.sum, 'axis')}
        </span>
      </div>
      <div className="mt-1 flex">
        <ShareTrack pct={totalOrders > 0 ? (r.orders / totalOrders) * 100 : 0} height="h-1.5" />
      </div>
    </div>
  ));
  return (
    <div className={expanded ? 'space-y-2.5 pt-1' : 'space-y-1.5'}>
      {expanded ? (
        cityRows
      ) : (
        // Full-width карточка: на md+ города встают в две колонки, сноска остаётся на всю ширину
        // под ними; мобайл — прежняя одна колонка с тем же вертикальным ритмом.
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">{cityRows}</div>
      )}
      {!expanded && (hiddenCities > 0 || noCity > 0) && (
        <p className="truncate text-2xs text-muted-foreground">
          {hiddenCities > 0 && (
            <>Ещё {fmt.num(hiddenCities)} {pluralRu(hiddenCities, ['город', 'города', 'городов'])} в отчёте</>
          )}
          {hiddenCities > 0 && noCity > 0 && ' · '}
          {noCity > 0 && <>Без города: {fmt.num(noCity)} из {fmt.num(totalOrders)}</>}
        </p>
      )}
      {expanded && noCity > 0 && (
        <p className="text-2xs text-muted-foreground">
          Без города доставки (самовывоз / не указан): {fmt.num(noCity)} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}
