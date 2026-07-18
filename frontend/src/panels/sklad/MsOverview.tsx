import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import type { ChartExpandConfig } from '@/components/ExpandableChart';
import { useMsFunnel, useMsReturns, useMsSummary, useMsTopProducts } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
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
  const top = useMsTopProducts(period);
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
      <ChartWidget id="ms-revenue" title="Выручка" fixedSize="half" expand={msSummaryExpand('revenue')}>
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

      <ChartWidget id="ms-orders" title="Заказы" fixedSize="half" expand={msSummaryExpand('orders')}>
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

      <ChartWidget id="ms-avg-check" title="Средний чек" fixedSize="half" expand={msSummaryExpand('aov')}>
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

      <ChartWidget id="ms-funnel" title="Воронка статусов" fixedSize="half">
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
              повторно, и воронка заполнится.
            </p>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">Нет заказов за период.</p>
          )
        ) : (
          <MsFunnelRows
            rows={funnel.data.rows}
            totalOrders={funnel.data.total_orders}
            noState={funnel.data.no_state_orders}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-top-products" title="Топ товаров по выручке" fixedSize="half">
        {top.isPending ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={`t${i}`} className="h-6 w-full" />
            ))}
          </div>
        ) : top.isError ? (
          <ErrorState
            className="py-4"
            title="Не удалось получить топ товаров"
            reason={top.error instanceof Error ? top.error.message : 'ошибка'}
            onRetry={() => top.refetch()}
            retrying={top.isFetching}
          />
        ) : !top.data || top.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsTopProductsList rows={top.data.rows} />
        )}
      </ChartWidget>

      <ChartWidget id="ms-returns" title="Возвраты" fixedSize="half">
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

/**
 * Rich explorer выручки/заказов/среднего чека — тот же общий overlay (период 7/30/90/Всё ·
 * грануляция День/Неделя/Месяц · линия/столбцы), что у Telegram/Instagram и графика каналов МС.
 * renderExpanded/renderExpandedBar сами тянут summary для ВЫБРАННОГО окна оверлея (свой MsPeriod),
 * а не переиспользуют топбар-payload карточки. statsFor намеренно НЕ задаём: он считался бы по
 * данным исходного окна страницы и разошёлся бы с окном оверлея — честнее показать число и дельту
 * внутри графика (ChartCardBody), посчитанные ровно для выбранного периода.
 */
function msSummaryExpand(metric: Metric): ChartExpandConfig {
  return {
    renderExpanded: (d, grain) => (
      <MsSummaryExplorer metric={metric} period={{ days: d }} grain={grain} kind="line" />
    ),
    renderExpandedBar: (d, grain) => (
      <MsSummaryExplorer metric={metric} period={{ days: d }} grain={grain} kind="bar" />
    ),
    grainable: true,
  };
}

/** Полноэкранный график одной метрики обзора. Агрегация по бакету: выручка=сумма, заказы=сумма,
    средний чек=sum(выручка)/sum(заказы) (НЕ среднее дневных чеков и никогда чек=0 для бакета без
    заказов — пустые бакеты среднего чека отфильтрованы, ряд остаётся непрерывным по датам). */
function MsSummaryExplorer({
  metric,
  period,
  grain = 'day',
  kind,
}: {
  metric: Metric;
  period: MsPeriod;
  grain?: Grain;
  kind: 'line' | 'bar';
}) {
  const summary = useMsSummary(period);
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
  const total = metricTotal(dayPoints, metric);
  const windowWord = period.days === 0 ? 'за всё время' : `за ${period.days} дн.`;
  const caption =
    metric === 'aov' ? `${windowWord} · по ${GRAIN_BUCKET_WORD[grain]} с заказами` : windowWord;

  return (
    <ChartCardBody value={total != null ? fmtMetric(metric, total) : '—'} caption={caption}>
      {kind === 'bar' ? (
        <BarChart values={values.map((v) => v ?? 0)} labels={labels} titles={titles} height={expandedHeight ?? undefined} />
      ) : (
        <LineChart values={values} labels={labels} titles={titles} yMin={0} height={expandedHeight ?? undefined} />
      )}
    </ChartCardBody>
  );
}

/** Список топ-товаров. Half-тайл фиксированной высоты вмещает 5 строк без внутреннего скролла
    (канон плотности); РАЗВОРОТ карточки (ChartExpandedContext — тот же паттерн, что Breakdown)
    показывает полный состав ответа. */
function MsTopProductsList({
  rows,
}: {
  rows: Array<{ name: string; quantity: number; revenue: number; profit: number }>;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 5);
  return (
    <ul>
      {shown.map((row, i) => (
        <li key={`${row.name}-${i}`} className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0">
          <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmt.num(row.quantity)} шт.</span>
          <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{fmt.short(row.revenue)} ₽</span>
          {/* Прибыль бывает отрицательной — показываем честно, но без красного крика (канон тихих дельт). */}
          <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {row.profit >= 0 ? '' : '−'}
            {fmt.short(Math.abs(row.profit))} ₽
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Строки воронки: топ-5 статусов окна барами в акценте графиков + сводный хвост; разворот
    карточки показывает ВСЕ статусы. Цвета статусов из МС сознательно НЕ красим в бары (пёстрый
    набор пользовательских цветов кричал бы против канона тихих карточек) — цвет живёт
    точкой-меткой у имени. */
function MsFunnelRows({
  rows,
  totalOrders,
  noState,
}: {
  rows: Array<{ state_id: string; name: string | null; color: string | null; orders: number; sum: number }>;
  totalOrders: number;
  noState: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const top = expanded ? rows : rows.slice(0, 5);
  const restOrders = (expanded ? [] : rows.slice(5)).reduce((acc, r) => acc + r.orders, 0) + noState;
  const max = top[0]?.orders ?? 1;
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
              <span className="font-medium text-foreground">{fmt.num(r.orders)}</span> · {fmt.short(r.sum)} ₽
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, Math.round((r.orders / max) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
          </div>
        </div>
      ))}
      {restOrders > 0 && (
        <p className="text-2xs text-muted-foreground">
          Ещё {fmt.num(restOrders)} {noState > 0 ? `заказов (из них без статуса ${fmt.num(noState)})` : 'заказов'} из{' '}
          {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}
