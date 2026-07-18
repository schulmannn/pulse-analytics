import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { useMsFunnel, useMsReturns, useMsSummary } from '@/api/queries';
import { MsTopProductsCard } from '@/panels/sklad/MsTopProducts';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentedControl } from '@/components/SegmentedControl';
import { lttbDownsample } from '@/lib/downsample';
import { fmt } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { useMsPagePeriod, type MsPeriod } from '@/lib/msPeriod';
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
export function MsOverview() {
  const pp = usePagePeriod();
  // «Всё» (0) обслуживается из нашего дневного архива ms_daily (слайс 2а), живые окна — 7/30/90;
  // точный диапазон топбара honored единым сериализатором (useMsPagePeriod → from/to).
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const summary = useMsSummary(period);
  // «Всё» (0) бэк со слайса 4 считает честно: полный диапазон от старейшего заказа архива
  // (страничная добивка отчёта + кэш 1 час) — подмена 0→30 больше не нужна.
  const [funnelMetric, setFunnelMetric] = useState<'orders' | 'revenue'>('orders');
  const funnel = useMsFunnel(period);
  const returns = useMsReturns(period);

  if (summary.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[264px] rounded-2xl border border-border bg-card p-5 lg:col-span-3">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="mt-3 h-40 w-full" />
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

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="ms-revenue" title="Выручка" fixedSize="half" drillTo="/metrics/ms-revenue">
        <ChartCardBody value={`${fmt.short(revenue.total)} ₽`} caption={windowLabel}>
          {revValues.length > 1 ? (
            <LineChart
              values={revValues}
              labels={revLabels}
              titles={revSeries.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.value)} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-orders" title="Заказы" fixedSize="half" drillTo="/metrics/ms-orders">
        <ChartCardBody
          value={fmt.num(orders.totalCount)}
          caption={`на ${fmt.short(orders.totalSum)} ₽ ${windowLabel}`}
        >
          {ordValues.length > 1 ? (
            <LineChart
              values={ordValues}
              labels={ordLabels}
              titles={ordSeries.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.count)} · ${fmt.num(p.sum)} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-avg-check" title="Средний чек" fixedSize="half" drillTo="/metrics/ms-aov">
        <ChartCardBody value={avgTotal != null ? `${fmt.short(avgTotal)} ₽` : '—'} caption={`${windowLabel} · по дням с заказами`}>
          {avgValues.length > 1 ? (
            <LineChart
              values={avgValues}
              labels={avgLabels}
              titles={avgSampled.map((p) => `${fmt.day(p.day)}: ${fmt.num(Math.round(p.sum / p.count))} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней с заказами для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-funnel" title="Статусы заказов" fixedSize="half" drillTo="/metrics/ms-funnel">
        <div className="mb-2 flex justify-end">
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
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={`f${i}`} className="h-6 w-full" />
            ))}
          </div>
        ) : funnel.isError ? (
          <ErrorState
            className="py-4"
            title="Не удалось получить статусы заказов"
            reason={funnel.error instanceof Error ? funnel.error.message : 'ошибка'}
            onRetry={() => funnel.refetch()}
            retrying={funnel.isFetching}
          />
        ) : !funnel.data ? (
          <p className="py-4 text-sm text-muted-foreground">Нет данных о статусах за период.</p>
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
            <p className="py-4 text-sm text-muted-foreground">Нет заказов за период.</p>
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
          <div className="space-y-2 py-2">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : returns.isError ? (
          <ErrorState
            className="py-4"
            title="Не удалось получить возвраты"
            reason={returns.error instanceof Error ? returns.error.message : 'ошибка'}
            onRetry={() => returns.refetch()}
            retrying={returns.isFetching}
          />
        ) : !returns.data ? (
          <p className="py-4 text-sm text-muted-foreground">Нет данных о возвратах за период.</p>
        ) : (
          <ChartCardBody
            value={fmt.num(returns.data.count)}
            caption={`на ${fmt.short(returns.data.sum)} ₽ ${windowLabel}`}
          >
            <div className="space-y-1.5 text-2xs text-muted-foreground">
              {/* Живое чтение salesreturn с cap по страницам: упёрлись — честное «не менее». */}
              {returns.data.truncated && <p>Показано не менее — возвратов за период больше лимита выборки.</p>}
              <p>Возвраты считаются отдельно и из выручки не вычитаются.</p>
            </div>
          </ChartCardBody>
        )}
      </ChartWidget>
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
    return (
      <div className="py-2">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="mt-3 h-48 w-full" />
      </div>
    );
  }
  if (summary.isError) {
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
      <p className="py-4 text-xs text-muted-foreground">
        {metric === 'aov'
          ? 'Недостаточно бакетов с заказами для среднего чека за период.'
          : 'Недостаточно данных за период.'}
      </p>
    );
  }

  const values = points.map((p) => metricValue(metric, p));
  const labels = points.map((p) => fmt.day(p.day));
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

/** Строки структуры: топ-5 последних сохранённых статусов заказов окна + сводный хвост; разворот
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
  const top = expanded ? ranked : ranked.slice(0, 5);
  const tail = expanded ? [] : ranked.slice(5);
  const restOrders = tail.reduce((acc, row) => acc + row.orders, 0) + noState;
  const restSum = tail.reduce((acc, row) => acc + row.sum, 0) + noStateSum;
  const totalSum = rows.reduce((acc, row) => acc + row.sum, 0) + noStateSum;
  const max = Math.max(1, ...top.map((row) => Math.max(0, selectedValue(row))));
  return (
    <div className="space-y-2 pt-1">
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
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, Math.round((Math.max(0, selectedValue(r)) / max) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
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
