import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ShareTrack } from '@/components/ShareRows';
import { ChartBand } from '@/components/ChartBand';
import { Link, useNavigate } from 'react-router-dom';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { observeSize } from '@/lib/observeSize';
import { useMsFunnel, useMsReturns, useMsSummary } from '@/api/queries';
import { MsTopProductsCard } from '@/panels/sklad/MsTopProducts';
import { MsStockCard } from '@/panels/sklad/MsStock';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import { DeltaPill } from '@/components/DeltaPill';
import { RadialShare } from '@/components/RadialShare';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Sparkline } from '@/components/Sparkline';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { lttbDownsample } from '@/lib/downsample';
import { fmt, weekdayAxisFromDayKeys } from '@/lib/format';
import { usePagePeriod, useCardShowsPeriod } from '@/lib/period';
import { msPreviousPeriod, useMsPagePeriod, type MsPeriod } from '@/lib/msPeriod';
import {
  aggregatePlotPoints,
  bucketPoints,
  densifyDayPoints,
  fmtMetric,
  metricTotal,
  metricValue,
  CHART_MAX_POINTS,
  GRAIN_BUCKET_WORD,
  type DayPoint,
  type Grain,
  type Metric,
} from '@/lib/msSeries';

/**
 * Обзор «МойСклада» — первый не-социальный источник. Все числа приходят СЕРВЕР-АГРЕГИРОВАННЫМИ
 * (plotseries/profit МойСклада, уже в рублях после /100 на нашем бэке) — миллионы заказов в БД
 * для этой страницы не нужны. Величины (выручка ₽, заказы) — свои и никогда не смешиваются с
 * просмотрами/охватом соцсетей (канон TG-views ≠ IG-reach).
 */

/**
 * Тело story-карточки Обзора склада: hero-число слева, ряд по дням справа. Вынесено из трёх
 * инлайновых копий, чтобы «Линия»/«Столбцы» объявлялись один раз. Контрол типа графика — не новый:
 * EditWidgetDialog показывает карусель, как только карточка объявит больше одного варианта.
 */
function MsStoryBody({
  label,
  value,
  delta,
  caption,
  values,
  labels,
  axisLabels,
  formatValue,
  emptyTitle,
  drillTo,
  drillLabel,
  viz = 'line',
}: {
  label?: string;
  value: string;
  delta?: MetricDelta | null;
  caption?: string;
  values: number[];
  labels: string[];
  /** Ось букв короткого дневного окна (канон weekdayAxisFromDayKeys). */
  axisLabels?: string[];
  formatValue: (v: number) => string;
  emptyTitle: string;
  drillTo: string;
  drillLabel: string;
  viz?: 'line' | 'bar';
}) {
  const navigate = useNavigate();
  return (
    <ChartCardBody
      hero
      label={label}
      value={value}
      delta={delta}
      caption={caption}
      onValueClick={() => navigate(drillTo)}
      drillLabel={drillLabel}
    >
      {values.length <= 1 ? (
        <EmptyState compact size="chart" title={emptyTitle} />
      ) : viz === 'bar' ? (
        <ChartBand>
          <BarChart
            values={values}
            labels={labels}
            axisLabels={axisLabels}
            titles={values.map((v, i) => `${labels[i] ?? ''}: ${formatValue(v)}`)}
            formatValue={formatValue}
          />
        </ChartBand>
      ) : (
        <Sparkline
          values={values}
          labels={labels}
          axisLabels={axisLabels}
          area
          strokeWidth={2}
          interactive
          caption=""
          formatValue={formatValue}
          className="h-full min-h-14 w-full"
        />
      )}
    </ChartCardBody>
  );
}

export function MsOverview() {
  const pp = usePagePeriod();
  // «Всё» (0) обслуживается из нашего дневного архива ms_daily (слайс 2а), живые окна — 7/30/90;
  // точный диапазон топбара honored единым сериализатором (useMsPagePeriod → from/to).
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const showPeriod = useCardShowsPeriod();
  const summary = useMsSummary(period);
  // Канон карточки-метрики: число + дельта к ПРЕДЫДУЩЕМУ равному окну (паттерн YmOverview).
  // У «Всё» честного предшественника нет (msPreviousPeriod → null) — запрос не уходит, и
  // previous.data при выключенном запросе НЕ читаем: fallback-ключ совпал бы с текущим окном.
  const previousPeriod = useMemo(() => msPreviousPeriod(period), [period]);
  const previous = useMsSummary(previousPeriod ?? period, { enabled: previousPeriod != null });
  const navigate = useNavigate();
  // «Всё» (0) бэк со слайса 4 считает честно: полный диапазон от старейшего заказа архива
  // (страничная добивка отчёта + кэш 1 час) — подмена 0→30 больше не нужна.
  const [funnelMetric, setFunnelMetric] = useState<'orders' | 'revenue'>('orders');
  const funnel = useMsFunnel(period);
  const returns = useMsReturns(period);
  // Прошлое окно возвратов — только при живом previousPeriod (та же грабля fallback-ключа).
  const previousReturns = useMsReturns(previousPeriod ?? period, { enabled: previousPeriod != null });

  if (summary.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[264px] rounded-2xl border border-border bg-card p-5 lg:col-span-3">
            <ChartSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (summary.isError) {
    const status = (summary.error as { status?: number } | null)?.status;
    if (status === 401) {
      // Токен отозван на стороне МойСклада — честный reconnect-CTA вместо «недоступен».
      return (
        <EmptyState
          title="Токен МойСклада отозван"
          reason="Источник перестал принимать наш токен — создайте новый в МойСкладе и переподключите."
          action={{ to: '/connect', label: 'Переподключить МойСклад' }}
        />
      );
    }
    if (status === 404) {
      // Канал есть, а токена МойСклада на нём нет — честный onboarding вместо пустых карточек.
      return (
        <EmptyState
          title="МойСклад не подключён"
          reason="Укажите токен API — и здесь появятся выручка, заказы и топ товаров."
          action={{ to: '/connect', label: 'Подключить МойСклад' }}
        />
      );
    }
    return (
      <ErrorState
        title="Не удалось получить данные МойСклада"
        reason={summary.error instanceof Error ? summary.error.message : 'ошибка'}
        onRetry={() => summary.refetch()}
        retrying={summary.isFetching}
      />
    );
  }

  const { revenue, orders } = summary.data;
  // Канон графиков: длинные серии (окно «Всё» после лет архива ms_daily) даунсэмплятся до ~140
  // точек ПЕРЕД рендером — как в Charts/MsClients; labels/titles строятся из той же выборки,
  // чтобы тултипы совпадали с точками. Оконные 7/30/90 короче порога и проходят как есть.
  const revSeries = lttbDownsample(revenue.series, 140, (p) => p.value);
  const ordSeries = lttbDownsample(orders.series, 140, (p) => p.count);
  const revLabels = revSeries.map((p) => fmt.day(p.day));
  const revValues = revSeries.map((p) => p.value);
  const ordLabels = ordSeries.map((p) => fmt.day(p.day));
  const ordValues = ordSeries.map((p) => p.count);
  // Средний чек — непрерывный ряд НАБЛЮДЕНИЙ по дням С заказами: день без заказов даёт
  // неопределённый чек, а общий LineChart трактует такой null как пропуск сбора и рвёт линию в
  // россыпь точек. Фильтруем пустые дни ДО рендера (реальные даты сохраняются), затем даунсэмплим.
  const avgSampled = lttbDownsample(
    orders.series.filter((p) => p.count > 0),
    140,
    (p) => p.sum / p.count,
  );
  const avgLabels = avgSampled.map((p) => fmt.day(p.day));
  const avgValues = avgSampled.map((p) => p.sum / p.count);
  const avgTotal = orders.totalCount > 0 ? orders.totalSum / orders.totalCount : null;
  // Дельты — только при живом прошлом окне (см. previousPeriod выше); один prev-фетч кормит все
  // три story-карточки. Средний чек сравнивается с чеком прошлого окна той же формулой.
  const prev = previousPeriod != null ? previous.data : undefined;
  const revenueDelta = prev ? pctDelta(revenue.total, prev.revenue.total) : null;
  const ordersDelta = prev ? pctDelta(orders.totalCount, prev.orders.totalCount) : null;
  const prevAvg = prev && prev.orders.totalCount > 0 ? prev.orders.totalSum / prev.orders.totalCount : null;
  const avgDelta = avgTotal != null && prevAvg != null ? pctDelta(avgTotal, prevAvg) : null;

  // На ленте окно уже стоит полосой в шапке страницы — подпись карточки его не повторяет
  // (владелец). На Главной страничного периода нет, там подпись вернётся сама.
  const periodInLabel = showPeriod ? windowLabel : undefined;
  // Пропсы story-тел вынесены: «Линия» и «Столбцы» это ОДНА карточка в двух подачах,
  // дублировать её данные в двух вариантах — прямой путь к их расхождению.
  const revStory = { label: periodInLabel, value: `${fmt.short(revenue.total)} ₽`, delta: revenueDelta, values: revValues, labels: revLabels, axisLabels: weekdayAxisFromDayKeys(revSeries.map((p) => p.day)), formatValue: (v: number) => `${fmt.num(Math.round(v))} ₽`, emptyTitle: 'Недостаточно дней для графика.', drillTo: '/metrics/ms-revenue', drillLabel: 'Выручка' };
  const ordStory = { label: periodInLabel, value: fmt.num(orders.totalCount), delta: ordersDelta, caption: `на ${fmt.short(orders.totalSum)} ₽`, values: ordValues, labels: ordLabels, axisLabels: weekdayAxisFromDayKeys(ordSeries.map((p) => p.day)), formatValue: fmt.num, emptyTitle: 'Недостаточно дней для графика.', drillTo: '/metrics/ms-orders', drillLabel: 'Заказы' };
  const avgStory = { label: periodInLabel, value: avgTotal != null ? `${fmt.short(avgTotal)} ₽` : '—', delta: avgDelta, caption: 'по дням с заказами', values: avgValues, labels: avgLabels, axisLabels: weekdayAxisFromDayKeys(avgSampled.map((p) => p.day)), formatValue: (v: number) => `${fmt.num(Math.round(v))} ₽`, emptyTitle: 'Недостаточно дней с заказами для графика.', drillTo: '/metrics/ms-aov', drillLabel: 'Средний чек' };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      {/* Story-карточки — та же грамматика, что у Обзоров TG/IG/Метрики (steep story card):
          подпись окна, hero-число, дельта к прошлому периоду и area-спарклайн без осей. Полные
          оси и тултипы по датам живут на /metrics/ms-* (MsSummaryExplorer ниже в этом файле).
          Тонирована ОДНА карточка доски — «Выручка»; остальные нейтральны с канонным акцентом. */}
      <ChartWidget id="ms-revenue" title="Выручка" fixedSize="half" defaultColor={1} defaultTinted drillTo="/metrics/ms-revenue"
        variants={[
          // Столбцы на story-плитке склада не помещаются в 264px без внутреннего скролла
          // (гейт плотности), поэтому лицо карточки ведёт искрой; «Столбцы» остаются вариантом,
          // а в конструкторе виджетов дефолт метрики — bar (widgetMetrics).
          { key: 'line', label: 'Линия', render: <MsStoryBody {...revStory} /> },
          { key: 'bar', label: 'Столбцы', render: <MsStoryBody {...revStory} viz="bar" /> },
        ]}
      />

      <ChartWidget id="ms-orders" title="Заказы" fixedSize="half" drillTo="/metrics/ms-orders"
        variants={[
          // Столбцы на story-плитке склада не помещаются в 264px без внутреннего скролла
          // (гейт плотности), поэтому лицо карточки ведёт искрой; «Столбцы» остаются вариантом,
          // а в конструкторе виджетов дефолт метрики — bar (widgetMetrics).
          { key: 'line', label: 'Линия', render: <MsStoryBody {...ordStory} /> },
          { key: 'bar', label: 'Столбцы', render: <MsStoryBody {...ordStory} viz="bar" /> },
        ]}
      />

      <ChartWidget id="ms-avg-check" title="Средний чек" fixedSize="half" drillTo="/metrics/ms-aov"
        variants={[
          { key: 'line', label: 'Линия', render: <MsStoryBody {...avgStory} /> },
          { key: 'bar', label: 'Столбцы', render: <MsStoryBody {...avgStory} viz="bar" /> },
        ]}
      />

      <ChartWidget id="ms-funnel" title="Статусы заказов" fixedSize="half" drillTo="/metrics/ms-funnel">
        <div className="mb-1 flex justify-end">
          <SegmentedControl
            ariaLabel="Показатель распределения заказов по статусам"
            size="sm"
            value={funnelMetric}
            onChange={setFunnelMetric}
            options={[
              { value: 'orders', content: 'Заказы' },
              { value: 'revenue', content: 'Выручка' },
            ]}
          />
        </div>
        {funnel.isPending ? (
          <TableSkeleton rows={4} columns={3} className="py-2" />
        ) : funnel.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить статусы заказов"
            reason={funnel.error instanceof Error ? funnel.error.message : 'ошибка'}
            onRetry={() => funnel.refetch()}
            retrying={funnel.isFetching}
          />
        ) : !funnel.data ? (
          <EmptyState compact size="table" title="Нет данных о статусах за период." />
        ) : funnel.data.rows.length === 0 ? (
          funnel.data.no_state_orders > 0 ? (
            // Заказы есть, а статусов нет: state_id появился в слайсе 3 — старые строки заполнит
            // повторная загрузка истории (идемпотентная), честно ведём туда.
            <p className="py-4 text-xs text-muted-foreground">
              У загруженных заказов ещё нет статусов — запустите{' '}
              <Link className="text-primary underline-offset-2 hover:underline" to="/connect">
                загрузку истории
              </Link>{' '}
              повторно, и статусы появятся в аналитике.
            </p>
          ) : (
            <EmptyState compact size="table" title="Нет заказов за период." />
          )
        ) : (
          <MsFunnelRows
            rows={funnel.data.rows}
            totalOrders={funnel.data.total_orders}
            noState={funnel.data.no_state_orders}
            noStateSum={funnel.data.no_state_sum}
            metric={funnelMetric}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-top-products" title="Товары" fixedSize="half" drillTo="/metrics/ms-products">
        <MsTopProductsCard period={period} />
      </ChartWidget>

      <ChartWidget id="ms-returns" title="Возвраты" fixedSize="half" drillTo="/metrics/ms-returns">
        {returns.isPending ? (
          <ChartSkeleton />
        ) : returns.isError ? (
          <ErrorState
            compact
            size="chart"
            className="py-4"
            title="Не удалось получить возвраты"
            reason={returns.error instanceof Error ? returns.error.message : 'ошибка'}
            onRetry={() => returns.refetch()}
            retrying={returns.isFetching}
          />
        ) : !returns.data ? (
          <EmptyState compact size="chart" title="Нет данных о возвратах за период." />
        ) : (
          <MsReturnsCardBody
            data={returns.data}
            period={period}
            windowLabel={windowLabel}
            delta={
              previousPeriod != null && previousReturns.data && previousReturns.data.count > 0
                ? pctDelta(returns.data.count, previousReturns.data.count)
                : null
            }
            onDrill={() => navigate('/metrics/ms-returns')}
          />
        )}
      </ChartWidget>

      {/* Остатки «что заканчивается»: карточка self-fetch (свои loading/error/empty), «Всё»
          внутри подменяется конечным 30-дневным окном — см. msStockPeriod. */}
      <ChartWidget id="ms-stock" title="Остатки" fixedSize="half" drillTo="/metrics/ms-stock">
        <MsStockCard period={period} />
      </ChartWidget>
    </div>
  );
}

/** Тело карточки «Возвраты» — вертикальная компоновка вместо горизонтального ChartCardBody:
    число + подпись сразу под заголовком, график в середине, сноски приглушённым текстом внизу
    (горизонтальная раскладка прижимала число к левому низу, а дисклеймер уносила вверх, оставляя
    диагональную пустоту). */
function MsReturnsCardBody({
  data,
  period,
  windowLabel,
  delta,
  onDrill,
}: {
  data: NonNullable<ReturnType<typeof useMsReturns>['data']>;
  period: MsPeriod;
  windowLabel: string;
  /** Дельта числа возвратов к пред. равному окну (канон п.7). */
  delta?: MetricDelta | null;
  /** Дрилл на /metrics/ms-returns — число становится настоящей кнопкой (канон п.2). */
  onDrill?: () => void;
}) {
  // Реальная дневная линия числа возвратов: архивную серию (только дни с возвратами)
  // дозаполняем календарными нулями по окну, затем даунсэмплим до канона ~140 точек.
  const dense = densifyDayPoints(
    data.series.map((r) => ({ day: r.day, orders: r.count, sum: r.sum })),
    period,
  );
  const sampled = lttbDownsample(dense, 140, (p) => p.orders);
  const expanded = useContext(ChartExpandedContext);
  // Высоту svg считаем от ФАКТИЧЕСКОЙ высоты слота (паттерн band-измерения WidgetRenderer), а не
  // от бюджета «тело минус оценка шапки/сносок»: оценка расходилась с фактом на единицы px и
  // рвала overflow-hidden слот. 26 = ряд X-подписей LineChart (~22px) + зазор.
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [slotHeight, setSlotHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const measure = () => setSlotHeight(el.clientHeight);
    measure();
    return observeSize(el, measure);
  }, []);
  const chartHeight = slotHeight != null && slotHeight > 0 ? Math.max(slotHeight - 26, 48) : null;
  return (
    <div className="flex h-full min-h-0 flex-col pt-1">
      <div className="shrink-0">
        <div className="flex items-baseline gap-2.5">
          {onDrill ? (
            <button
              type="button"
              aria-label="Разбор: Возвраты"
              title="Подробный разбор"
              onClick={onDrill}
              className="kpi-accent rounded text-left text-3xl font-medium leading-[1.15] tabular-nums tracking-tight transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {fmt.num(data.count)}
            </button>
          ) : (
            <span className="kpi-accent text-3xl font-medium leading-[1.15] tabular-nums tracking-tight">
              {fmt.num(data.count)}
            </span>
          )}
          <DeltaPill delta={delta} />
        </div>
        <div className="mt-1.5 text-2xs text-muted-foreground">{`на ${fmt.short(data.sum)} ₽ ${windowLabel}`}</div>
      </div>
      {/* overflow-hidden — страховка на кадр между измерением слота и ре-рендером графика. */}
      <div ref={slotRef} className="mt-2 min-h-0 flex-1 overflow-hidden">
        {data.complete && data.count === 0 ? (
          <EmptyState compact title="Возвратов за период нет." className="min-h-0 py-2" />
        ) : sampled.length > 1 ? (
          expanded ? (
            <ExpandedChartHeightContext.Provider value={chartHeight}>
              <LineChart
                values={sampled.map((p) => p.orders)}
                labels={sampled.map((p) => fmt.day(p.day))}
                axisLabels={weekdayAxisFromDayKeys(sampled.map((p) => p.day))}
                titles={sampled.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.orders)} · ${fmt.short(p.sum)} ₽`)}
                yMin={0}
              />
            </ExpandedChartHeightContext.Provider>
          ) : (
            // Тайл: минимальная высота LineChart (svg 80 + ряд подписей 22) не влезает в остаток
            // 264px-колонки — здесь канонный компакт-примитив Sparkline, полный график в развороте.
            <div className="flex h-full items-center">
              <Sparkline
                values={sampled.map((p) => p.orders)}
                labels={sampled.map((p) => fmt.day(p.day))}
                color="hsl(var(--chart-role-primary))"
                area
                interactive
                formatValue={(v) => fmt.num(v)}
                className="h-12 w-full"
              />
            </div>
          )
        ) : (
          <EmptyState compact title="Недостаточно дней для графика." className="min-h-0 py-2" />
        )}
      </div>
      <div className="mt-2 shrink-0 space-y-1 text-2xs text-muted-foreground">
        {!data.complete && (
          <p>
            Архив возвратов ещё загружается. Показаны только уже сохранённые документы
            {data.total_estimate == null
              ? '.'
              : `: ${fmt.num(data.archived_count)} из примерно ${fmt.num(data.total_estimate)}.`}
          </p>
        )}
        <p>Возвраты считаются отдельно и из выручки не вычитаются.</p>
      </div>
    </div>
  );
}

/** Полноэкранный график одной метрики обзора. Агрегация по бакету: выручка=сумма, заказы=сумма,
    средний чек=sum(выручка)/sum(заказы) (НЕ среднее дневных чеков и никогда чек=0 для бакета без
    заказов — пустые бакеты среднего чека отфильтрованы, ряд остаётся непрерывным по датам).
    Экспортируется для полностраничного `/metrics/ms-*` explorer (panels/sklad/MsMetricPage). */
export function MsSummaryExplorer({
  metric,
  period,
  comparisonPeriod,
  grain = 'day',
  kind,
}: {
  metric: Metric;
  period: MsPeriod;
  comparisonPeriod?: MsPeriod | null;
  grain?: Grain;
  kind: 'line' | 'bar';
}) {
  const summary = useMsSummary(period);
  // Keep hook order stable. Without a comparison window React Query deduplicates this with the
  // current request; with one it fetches the exact preceding calendar range.
  const comparison = useMsSummary(comparisonPeriod ?? period);
  const expandedHeight = useContext(ExpandedChartHeightContext);

  if (summary.isPending) {
    return <ChartSkeleton className="py-2" />;
  }
  if (summary.isError) {
    return (
      <ErrorState
        compact
        size="chart"
        title="Не удалось получить данные МойСклада"
        reason={summary.error instanceof Error ? summary.error.message : 'ошибка'}
        onRetry={() => summary.refetch()}
        retrying={summary.isFetching}
      />
    );
  }

  const { revenue, orders } = summary.data;
  // Выручка — отдельный отчёт продаж (нет привязки к числу заказов); заказы/средний чек — из
  // серии заказов (sum + count). Каждая метрика берёт свой авторитетный ряд, а не суммирует чужой.
  const dayPoints: DayPoint[] =
    metric === 'revenue'
      ? revenue.series.map((p) => ({ day: p.day, orders: 0, sum: p.value }))
      : orders.series.map((p) => ({ day: p.day, orders: p.count, sum: p.sum }));

  const bucketed = bucketPoints(densifyDayPoints(dayPoints, period), grain);
  const points = aggregatePlotPoints(bucketed, metric, CHART_MAX_POINTS);
  if (points.length < 2) {
    return (
      <EmptyState
        compact
        size="chart"
        title={metric === 'aov'
          ? 'Недостаточно бакетов с заказами для среднего чека за период.'
          : 'Недостаточно данных за период.'}
      />
    );
  }

  const values = points.map((p) => metricValue(metric, p));
  const labels = points.map((p) => fmt.day(p.day));
  // Буквы короткого дневного окна; недельные/месячные корзины — датами (день якоря корзины лгал бы).
  const axisLabels = grain === 'day' ? weekdayAxisFromDayKeys(points.map((p) => p.day)) : undefined;
  const titles = points.map((p) => `${fmt.day(p.day)}: ${fmtMetric(metric, metricValue(metric, p))}`);
  const comparisonDayPoints: DayPoint[] | null =
    comparisonPeriod && comparison.data
      ? metric === 'revenue'
        ? comparison.data.revenue.series.map((p) => ({ day: p.day, orders: 0, sum: p.value }))
        : comparison.data.orders.series.map((p) => ({ day: p.day, orders: p.count, sum: p.sum }))
      : null;
  const comparisonPoints = comparisonDayPoints
    ? aggregatePlotPoints(
        bucketPoints(densifyDayPoints(comparisonDayPoints, comparisonPeriod!), grain),
        metric,
        CHART_MAX_POINTS,
      )
    : [];
  const ghostValues = comparisonPoints.map((p) => metricValue(metric, p));
  const ghostOk = ghostValues.length === values.length && ghostValues.length >= 2;
  const total = metricTotal(dayPoints, metric);
  const windowWord = period.custom && period.from && period.to
    ? `${fmt.day(period.from)} – ${fmt.day(period.to)}`
    : period.days === 0
      ? 'за всё время'
      : `за ${period.days} дн.`;
  const caption =
    metric === 'aov' ? `${windowWord} · по ${GRAIN_BUCKET_WORD[grain]} с заказами` : windowWord;
  const numeric = values.filter((value): value is number => value != null && Number.isFinite(value));
  const numericSum = numeric.reduce((sum, value) => sum + value, 0);
  const stats = numeric.length > 0
    ? [
        { label: 'Мин', value: fmtMetric(metric, Math.min(...numeric)) },
        { label: 'Макс', value: fmtMetric(metric, Math.max(...numeric)) },
        { label: 'Среднее', value: fmtMetric(metric, numericSum / numeric.length) },
        { label: metric === 'aov' ? 'Итог' : 'Сумма', value: total == null ? '—' : fmtMetric(metric, total) },
      ]
    : [];

  return (
    <>
      <ChartCardBody value={total != null ? fmtMetric(metric, total) : '—'} caption={caption}>
        {kind === 'bar' ? (
          <BarChart
            values={values.map((v) => v ?? 0)}
            ghost={ghostOk ? ghostValues.map((v) => v ?? 0) : undefined}
            ghostLabel="Пред. период"
            legendToggle={false}
            labels={labels}
            axisLabels={axisLabels}
            titles={titles}
            height={expandedHeight ?? undefined}
          />
        ) : (
          <LineChart
            values={values}
            ghost={ghostOk ? ghostValues : undefined}
            ghostLabel="Пред. период"
            ghostTitles={ghostOk ? comparisonPoints.map((p) => fmt.day(p.day)) : undefined}
            legendToggle={false}
            labels={labels}
            axisLabels={axisLabels}
            titles={titles}
            yMin={0}
            height={expandedHeight ?? undefined}
          />
        )}
      </ChartCardBody>
      {stats.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-4">
          {stats.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">{row.label}</span>
              <span className="text-sm font-medium tabular-nums">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Строки структуры: компактный топ-4 последних сохранённых статусов заказов окна + сводный хвост; разворот
    карточки показывает ВСЕ статусы. Цвета статусов из МС сознательно НЕ красим в бары (пёстрый
    набор пользовательских цветов кричал бы против канона тихих карточек) — цвет живёт
    точкой-меткой у имени. */
export function MsFunnelRows({
  rows,
  totalOrders,
  noState,
  noStateSum,
  metric,
}: {
  rows: Array<{ state_id: string; name: string | null; color: string | null; orders: number; sum: number }>;
  totalOrders: number;
  noState: number;
  noStateSum: number;
  metric: 'orders' | 'revenue';
}) {
  const expanded = useContext(ChartExpandedContext);
  const selectedValue = (row: { orders: number; sum: number }) => (metric === 'orders' ? row.orders : row.sum);
  const ranked = [...rows].sort(
    (a, b) => selectedValue(b) - selectedValue(a) || b.orders - a.orders || a.state_id.localeCompare(b.state_id),
  );
  const top = expanded ? ranked : ranked.slice(0, 4);
  const tail = expanded ? [] : ranked.slice(4);
  const restOrders = tail.reduce((acc, row) => acc + row.orders, 0) + noState;
  const restSum = tail.reduce((acc, row) => acc + row.sum, 0) + noStateSum;
  const totalSum = rows.reduce((acc, row) => acc + row.sum, 0) + noStateSum;
  // Знаменатель — целое по ВЫБРАННОЙ метрике (заказы или сумма), включая строки без статуса:
  // доля статуса считается от всего окна, а не от показанной четвёрки.
  const statusTotal =
    rows.reduce((acc, row) => acc + Math.max(0, selectedValue(row)), 0)
    + Math.max(0, metric === 'orders' ? noState : noStateSum);
  // Компакт карточки — составное полукольцо (выбор владельца, унификация с Возраст/Пол Метрики):
  // статусы окна — части целого, итог в центре, безстатусный остаток кольцо дорисует само из
  // total. Полный список с построчными числами остаётся на развороте и /metrics/ms-funnel.
  if (!expanded) {
    return (
      <RadialShare
        segments={ranked.map((r) => ({
          key: r.state_id,
          label: r.name ?? 'Статус без имени',
          value: Math.max(0, selectedValue(r)),
        }))}
        total={statusTotal}
        unitWord={metric === 'orders' ? 'заказов' : '₽'}
        centerCaption={metric === 'orders' ? 'заказов' : '₽ выручки'}
        format={metric === 'orders' ? fmt.num : (v) => fmt.short(v)}
        // Кольцо слева, легенда справа: в тайле над телом уже стоит переключатель Заказы/Выручка,
        // столбик «кольцо + легенда» по высоте не помещается. Топ-3 + хвост — по той же причине.
        layout="row"
        legendMax={3}
      />
    );
  }
  return (
    <div className={expanded ? 'space-y-2 pt-1' : 'space-y-1.5'}>
      {top.map((r) => (
        <div key={r.state_id}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              {r.color && (
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
              )}
              <span className="truncate">{r.name ?? 'Статус без имени'}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {metric === 'orders' ? (
                <><span className="font-medium text-foreground">{fmt.num(r.orders)}</span> · {fmt.short(r.sum)} ₽</>
              ) : (
                <><span className="font-medium text-foreground">{fmt.short(r.sum)} ₽</span> · {fmt.num(r.orders)}</>
              )}
            </span>
          </div>
          {/* Доля от ЦЕЛОГО окна, а не от крупнейшего статуса. */}
          <div className="mt-1 flex">
            <ShareTrack pct={statusTotal > 0 ? (Math.max(0, selectedValue(r)) / statusTotal) * 100 : 0} height="h-1.5" />
          </div>
        </div>
      ))}
      {(metric === 'orders' ? restOrders > 0 : restSum !== 0) && (
        <p className="text-2xs text-muted-foreground">
          {metric === 'orders' ? (
            <>Ещё {fmt.num(restOrders)} {noState > 0 ? `заказов (из них без статуса ${fmt.num(noState)})` : 'заказов'} из {fmt.num(totalOrders)}.</>
          ) : (
            <>Ещё {fmt.short(restSum)} ₽ {noStateSum !== 0 ? `(без статуса ${fmt.short(noStateSum)} ₽)` : 'выручки'} из {fmt.short(totalSum)} ₽.</>
          )}
        </p>
      )}
    </div>
  );
}

/** Метрика возвратов страницы `/metrics/ms-returns`: число документов или их сумма. */
export type MsReturnsMetric = 'count' | 'sum';

export const RETURNS_METRIC_OPTIONS: Array<{ value: MsReturnsMetric; content: string }> = [
  { value: 'count', content: 'Число' },
  { value: 'sum', content: 'Сумма' },
];

/** Формат значения выбранной метрики возвратов (число — штуки, сумма — рубли). */
export function fmtReturnsMetric(metric: MsReturnsMetric, value: number | null): string {
  if (value == null) return '—';
  return metric === 'count' ? fmt.num(value) : `${fmt.short(value)} ₽`;
}

/** Итог метрики возвратов за окно (сумма по дням серии). */
export function returnsMetricTotal(series: Array<{ count: number; sum: number }>, metric: MsReturnsMetric): number {
  return series.reduce((total, row) => total + (metric === 'count' ? row.count : row.sum), 0);
}

/**
 * Полноэкранный график возвратов одной метрики (число / сумма) — self-fetch по выбранному окну.
 * Дневную архивную серию (только дни с возвратами) дозаполняем календарными нулями, агрегируем по
 * бакету грануляции и накладываем призрак равного предыдущего окна. Возвраты СОЗНАТЕЛЬНО считаются
 * отдельно и из выручки заказов не вычитаются. Экспортируется для `/metrics/ms-returns`.
 */
export function MsReturnsExplorer({
  metric,
  period,
  comparisonPeriod,
  grain = 'day',
  kind,
}: {
  metric: MsReturnsMetric;
  period: MsPeriod;
  comparisonPeriod?: MsPeriod | null;
  grain?: Grain;
  kind: 'line' | 'bar';
}) {
  const returns = useMsReturns(period);
  const comparison = useMsReturns(comparisonPeriod ?? period);
  const expandedHeight = useContext(ExpandedChartHeightContext);

  if (returns.isPending) {
    return <ChartSkeleton className="py-2" />;
  }
  if (returns.isError) {
    return (
      <ErrorState
        compact
        size="chart"
        title="Не удалось получить возвраты"
        reason={returns.error instanceof Error ? returns.error.message : 'ошибка'}
        onRetry={() => returns.refetch()}
        retrying={returns.isFetching}
      />
    );
  }

  // Метрика возвратов ложится на общий DayPoint: число → orders, сумма → sum; график берёт
  // соответствующую роль msSeries ('orders'/'revenue') — та же арифметика бакетов и нулей.
  const seriesMetric: Metric = metric === 'count' ? 'orders' : 'revenue';
  const toPoints = (rows: Array<{ day: string; count: number; sum: number }>): DayPoint[] =>
    rows.map((r) => ({ day: r.day, orders: r.count, sum: r.sum }));

  const dayPoints = toPoints(returns.data.series);
  const bucketed = bucketPoints(densifyDayPoints(dayPoints, period), grain);
  const points = aggregatePlotPoints(bucketed, seriesMetric, CHART_MAX_POINTS);
  const total = metric === 'count' ? returns.data.count : returns.data.sum;
  if (points.length < 2) {
    return (
      <ChartCardBody value={fmtReturnsMetric(metric, total)} caption={windowWord(period)}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика за период." />
        {!returns.data.complete && <ReturnsArchiveNotice data={returns.data} />}
        <p className="mt-2 text-2xs text-muted-foreground">Возвраты считаются отдельно и из выручки не вычитаются.</p>
      </ChartCardBody>
    );
  }

  const values = points.map((p) => metricValue(seriesMetric, p));
  const labels = points.map((p) => fmt.day(p.day));
  const axisLabels = grain === 'day' ? weekdayAxisFromDayKeys(points.map((p) => p.day)) : undefined;
  const titles = points.map((p) => `${fmt.day(p.day)}: ${fmtReturnsMetric(metric, metricValue(seriesMetric, p))}`);
  const comparisonPoints = comparisonPeriod && comparison.data
    ? aggregatePlotPoints(
        bucketPoints(densifyDayPoints(toPoints(comparison.data.series), comparisonPeriod), grain),
        seriesMetric,
        CHART_MAX_POINTS,
      )
    : [];
  const ghostValues = comparisonPoints.map((p) => metricValue(seriesMetric, p));
  const ghostOk = returns.data.complete && comparison.data?.complete === true
    && ghostValues.length === values.length && ghostValues.length >= 2;

  return (
    <ChartCardBody value={fmtReturnsMetric(metric, total)} caption={windowWord(period)}>
      {kind === 'bar' ? (
        <BarChart
          values={values.map((v) => v ?? 0)}
          ghost={ghostOk ? ghostValues.map((v) => v ?? 0) : undefined}
          ghostLabel="Пред. период"
          legendToggle={false}
          labels={labels}
          axisLabels={axisLabels}
          titles={titles}
          height={expandedHeight ?? undefined}
        />
      ) : (
        <LineChart
          values={values}
          ghost={ghostOk ? ghostValues : undefined}
          ghostLabel="Пред. период"
          ghostTitles={ghostOk ? comparisonPoints.map((p) => fmt.day(p.day)) : undefined}
          legendToggle={false}
          labels={labels}
          axisLabels={axisLabels}
          titles={titles}
          yMin={0}
          height={expandedHeight ?? undefined}
        />
      )}
      {!returns.data.complete && <ReturnsArchiveNotice data={returns.data} />}
      <p className="mt-3 text-2xs text-muted-foreground">Возвраты считаются отдельно и из выручки не вычитаются.</p>
    </ChartCardBody>
  );
}

function ReturnsArchiveNotice({ data }: { data: ReturnType<typeof useMsReturns>['data'] }) {
  if (!data || data.complete) return null;
  return (
    <p className="mt-3 text-2xs text-muted-foreground">
      Архив возвратов ещё загружается. Показаны только уже сохранённые документы
      {data.total_estimate == null
        ? '.'
        : `: ${fmt.num(data.archived_count)} из примерно ${fmt.num(data.total_estimate)}.`}
    </p>
  );
}

/** Короткая подпись окна для caption'ов возвратов. */
function windowWord(period: MsPeriod): string {
  if (period.custom && period.from && period.to) return `${fmt.day(period.from)} – ${fmt.day(period.to)}`;
  return period.days === 0 ? 'за всё время' : `за ${period.days} дн.`;
}
