import { useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMsCohorts, useMsCustomers, useMsRfm, useMsTopCustomers } from '@/api/queries';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { BarChart } from '@/components/BarChart';
import { LineChart } from '@/components/LineChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { lttbDownsample } from '@/lib/downsample';
import { fmt, pluralRu } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { useMsPagePeriod, type MsPeriod } from '@/lib/msPeriod';
import {
  bucketCustomerDays,
  customerMetricTotal,
  customerMetricValues,
  customerPlotPoints,
  densifyCustomerDays,
  type MsCustomerMetric,
} from '@/lib/msCustomerSeries';
import { CHART_MAX_POINTS, type Grain } from '@/lib/msSeries';
import { cohortCellValue, isMoneyCohortMode, type MsCohortCell, type MsCohortMode } from '@/lib/msCohortMode';

/**
 * «Клиенты» МойСклада — покупательская аналитика АРХИВА заказов (ms_orders, слайс 3).
 * Семантика пришпилена на бэке: «новый» заказ = первый заказ этого контрагента за всю историю
 * канала (не окна), поэтому цифры не скачут при смене периода. Заказы без контрагента честно
 * вынесены в сноску, а не растворены в числах.
 */
export function MsClients() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const customers = useMsCustomers(period);
  const cohorts = useMsCohorts();
  const topCustomers = useMsTopCustomers(period);
  const rfm = useMsRfm(period);

  // Бэк отдаёт только дни С заказами (канон mentions.daily) — дозаполняем календарную сетку окна
  // нулями: день без заказов для СЧЁТЧИКА заказов — честный ноль, а не разрыв (разрыв = пропуск
  // сбора, здесь сбора нет — есть арифметика по архиву). Затем длинные окна («Всё» = годы точек)
  // даунсэмплим по канону графиков; обе серии на одной сетке — один LTTB-проход по сумме дня.
  // Тяжёлый дериват (densify до 730 дн + LTTB) — мемо по данным/окну, а не на каждый рендер;
  // хук ДО early-return (React #310).
  const series = customers.data?.series;
  const chart = useMemo(() => {
    if (!series) return null;
    const dense = densifyCustomerDays(series, period);
    const sampled = lttbDownsample(dense, 140, (r) => r.new_orders + r.repeat_orders);
    return {
      count: sampled.length,
      labels: sampled.map((r) => fmt.day(r.day)),
      newValues: sampled.map((r) => r.new_orders),
      repeatValues: sampled.map((r) => r.repeat_orders),
    };
  }, [series, period]);

  if (customers.isPending) {
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

  if (customers.isError) {
    return (
      <ErrorState
        title="Не удалось получить данные о покупателях"
        reason={customers.error instanceof Error ? customers.error.message : 'ошибка'}
        onRetry={() => customers.refetch()}
        retrying={customers.isFetching}
      />
    );
  }

  const { summary } = customers.data;
  const repeatShare = summary.customers > 0 ? Math.round((summary.repeat_customers / summary.customers) * 100) : 0;
  const everShare = summary.repeat_ever; // клиенты с ≥2 заказами за всю историю
  const repeatRevenueTotal = summary.sum_new + summary.sum_repeat;
  const repeatRevenueShare = repeatRevenueTotal > 0 ? (summary.sum_repeat / repeatRevenueTotal) * 100 : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget
        id="ms-customers"
        title="Покупатели"
        fixedSize="half"
        drillTo="/metrics/ms-customers"
      >
        <ChartCardBody value={fmt.num(summary.customers)} caption={windowLabel}>
          {chart && chart.count > 1 ? (
            <LineChart
              values={chart.newValues}
              ghost={chart.repeatValues}
              primaryLabel="Новые"
              comparisonDelta={false}
              ghostLabel="Повторные"
              labels={chart.labels}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget
        id="ms-repeat"
        title="Повторные покупки"
        fixedSize="half"
        drillTo="/metrics/ms-repeat"
      >
        {days === 0 && !pp?.range ? (
          // На «Всё» окно совпадает с историей — «новых в окне» не бывает; честная метрика
          // здесь — сколько клиентов вообще возвращалось.
          <MsStatCardBody
            value={`${summary.customers > 0 ? Math.round((everShare / summary.customers) * 100) : 0}%`}
            caption={`возвращались: ${fmt.num(everShare)} из ${fmt.num(summary.customers)} клиентов`}
          >
            <MsRepeatBreakdown summary={summary} repeatRevenueShare={repeatRevenueShare} allTime />
          </MsStatCardBody>
        ) : (
          <MsStatCardBody
            value={`${repeatShare}%`}
            caption={`повторных покупателей ${windowLabel}`}
          >
            <MsRepeatBreakdown summary={summary} repeatRevenueShare={repeatRevenueShare} />
          </MsStatCardBody>
        )}
      </ChartWidget>

      <ChartWidget id="ms-rfm" title="RFM-сегменты" fixedSize="full" drillTo="/metrics/ms-rfm">
        <MsRfmBody state={rfm} />
      </ChartWidget>

      <MsTopCustomersCard state={topCustomers} windowLabel={windowLabel} />

      <MsCohortsCard state={cohorts} />
    </div>
  );
}

/** Метрики покупательских explorer'ов — общий список для полностраничного `/metrics/ms-*`. */
export const CUSTOMER_METRIC_OPTIONS = [
  { value: 'orders' as const, content: 'Заказы' },
  { value: 'revenue' as const, content: 'Выручка' },
  { value: 'repeatShare' as const, content: 'Доля повторных' },
];

/** Полностраничный explorer покупателей (новые/повторные · выручка · доля повторной выручки);
    сам тянет данные для выбранного окна. Экспортируется для `/metrics/ms-*` (MsMetricPage). */
export function MsCustomerExplorer({
  metric,
  period,
  grain = 'day',
  kind,
}: {
  metric: MsCustomerMetric;
  period: MsPeriod;
  grain?: Grain;
  kind: 'line' | 'bar';
}) {
  const customers = useMsCustomers(period);
  const expandedHeight = useContext(ExpandedChartHeightContext);

  // Тяжёлый дериват (densify всего окна до 730 дн + бакетинг + точки/подписи) — мемо по
  // данным/окну/грануляции/метрике, а не на каждый рендер; хук ДО early-return (React #310).
  const series = customers.data?.series;
  const model = useMemo(() => {
    if (!series) return null;
    const bucketed = bucketCustomerDays(densifyCustomerDays(series, period), grain);
    // Доля без выручки не равна нулю. Как у sparse-AOV, соединяем только реальные наблюдения,
    // сохраняя их настоящие даты, чтобы пустые дни не превращали линию в россыпь точек.
    const relevant = metric === 'repeatShare'
      ? bucketed.filter((point) => point.sum_new + point.sum_repeat > 0)
      : bucketed;
    const points = customerPlotPoints(relevant, CHART_MAX_POINTS);
    const pairs = points.map((point) => customerMetricValues(point, metric));
    return {
      count: points.length,
      primary: pairs.map((pair) => pair.primary),
      repeat: metric === 'repeatShare' ? undefined : pairs.map((pair) => pair.repeat ?? 0),
      labels: points.map((point) => fmt.day(point.day)),
      titles: points.map((point, index) => {
        const pair = pairs[index];
        if (metric === 'repeatShare') return `${fmt.day(point.day)}: ${pair.primary?.toFixed(1) ?? '—'}%`;
        const suffix = metric === 'revenue' ? ' ₽' : '';
        return `${fmt.day(point.day)}: новые ${fmt.num(pair.primary ?? 0)}${suffix} · повторные ${fmt.num(pair.repeat ?? 0)}${suffix}`;
      }),
      totals: customerMetricTotal(relevant, metric),
    };
  }, [series, period, grain, metric]);

  if (customers.isPending) {
    return (
      <div className="py-2">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="mt-3 h-48 w-full" />
      </div>
    );
  }
  if (customers.isError) {
    return (
      <ErrorState
        title="Не удалось получить динамику покупателей"
        reason={customers.error instanceof Error ? customers.error.message : 'ошибка'}
        onRetry={() => customers.refetch()}
        retrying={customers.isFetching}
      />
    );
  }

  if (!model || model.count < 2) {
    return <p className="py-4 text-xs text-muted-foreground">Недостаточно данных за выбранный период.</p>;
  }

  const { primary, repeat, labels, titles, totals } = model;
  const headline = totals.value == null
    ? '—'
    : metric === 'orders'
      ? fmt.num(totals.value)
      : metric === 'revenue'
        ? `${fmt.short(totals.value)} ₽`
        : `${totals.value.toFixed(1)}%`;
  const caption = metric === 'repeatShare' ? 'доля повторной выручки' : 'новые и повторные покупки';
  const formatValue = (value: number) =>
    metric === 'orders' ? fmt.num(value) : metric === 'revenue' ? `${fmt.short(value)} ₽` : `${value.toFixed(1)}%`;

  return (
    <ChartCardBody value={headline} caption={caption}>
      {kind === 'bar' ? (
        <BarChart
          values={primary.map((value) => value ?? 0)}
          ghost={repeat}
          primaryLabel={metric === 'repeatShare' ? 'Доля повторной выручки' : 'Новые'}
          ghostLabel="Повторные"
          comparisonDelta={false}
          formatValue={formatValue}
          labels={labels}
          titles={titles}
          height={expandedHeight ?? undefined}
        />
      ) : (
        <LineChart
          values={primary}
          ghost={repeat}
          primaryLabel={metric === 'repeatShare' ? 'Доля повторной выручки' : 'Новые'}
          ghostLabel="Повторные"
          comparisonDelta={false}
          formatValue={formatValue}
          labels={labels}
          titles={titles}
          yMin={0}
          height={expandedHeight ?? undefined}
        />
      )}
    </ChartCardBody>
  );
}

/** Топ покупателей окна по выручке (слайс 4): имена резолвит бэк словарём counterparty по id;
    удалённый/безымянный контрагент честно показывается заглушкой, а не выпадает из топа. */
function MsTopCustomersCard({
  state,
  windowLabel,
}: {
  state: ReturnType<typeof useMsTopCustomers>;
  windowLabel: string;
}) {
  return (
    <ChartWidget id="ms-top-customers" title={`Топ покупателей ${windowLabel}`} fixedSize="full" drillTo="/metrics/ms-top-customers">
      <MsTopCustomersBody state={state} />
    </ChartWidget>
  );
}

/** Тело «Топ покупателей» — общий для карточки и полностраничного `/metrics/ms-top-customers`. */
export function MsTopCustomersBody({ state }: { state: ReturnType<typeof useMsTopCustomers> }) {
  if (state.isPending) {
    return (
      <div className="space-y-2 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={`tc${i}`} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (state.isError) {
    return (
      <ErrorState
        className="py-4"
        title="Не удалось получить топ покупателей"
        reason={state.error instanceof Error ? state.error.message : 'ошибка'}
        onRetry={() => state.refetch()}
        retrying={state.isFetching}
      />
    );
  }
  if (!state.data || state.data.rows.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">Нет покупателей за период.</p>;
  }
  return (
    <ul>
      {state.data.rows.map((row, i) => (
        <li key={row.agent_id} className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0">
          <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
          <span className={`min-w-0 flex-1 truncate text-sm ${row.name ? 'text-foreground' : 'text-muted-foreground'}`}>
            {row.name ?? 'Без имени'}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {fmt.num(row.orders)} {pluralRu(row.orders, ['заказ', 'заказа', 'заказов'])}
          </span>
          <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums">{fmt.short(row.sum)} ₽</span>
        </li>
      ))}
    </ul>
  );
}

type RfmMode = 'customers' | 'revenue';

export const RFM_SEGMENTS = {
  champions: { label: 'Чемпионы', action: 'часто покупают, недавно и на крупную сумму', color: 'hsl(var(--chart-role-positive))' },
  loyal: { label: 'Лояльные', action: 'стабильно возвращаются и приносят выручку', color: 'hsl(var(--chart-role-primary))' },
  potential: { label: 'Потенциально лояльные', action: 'есть потенциал для следующей покупки', color: 'hsl(var(--chart-role-comparison))' },
  new: { label: 'Новые', action: 'покупали недавно, но пока редко', color: 'hsl(var(--chart-role-primary) / 0.65)' },
  at_risk: { label: 'Под риском', action: 'раньше были ценными, но давно не покупали', color: 'hsl(var(--chart-role-negative))' },
  hibernating: { label: 'Спящие', action: 'давно не покупали и были малоактивны', color: 'hsl(var(--muted-foreground) / 0.55)' },
} as const;

export type RfmSegmentKey = keyof typeof RFM_SEGMENTS;

/** RFM distribution stays aggregate — no customer ids travel through THIS endpoint. Drilling into a
    segment's customer list is a separate deliberate tenant-scoped route (`/api/ms/rfm-customers`,
    rendered by MsRfmSegmentCustomers on the ms-rfm page). Scores are relative to the selected window
    population, so the UI never presents them as absolute lifetime labels. With `onSelectSegment` the
    segment rows become toggle buttons (the page owns the selection, канон — URL-контрол); without it
    (compact card, expand overlay) the markup stays exactly as before. */
export function MsRfmBody({
  state,
  detailed = false,
  selectedSegment = null,
  onSelectSegment,
}: {
  state: ReturnType<typeof useMsRfm>;
  detailed?: boolean;
  selectedSegment?: string | null;
  onSelectSegment?: (key: RfmSegmentKey) => void;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [mode, setMode] = useState<RfmMode>('customers');
  if (state.isPending) {
    return (
      <div className="space-y-2 py-2">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={`rfm${i}`} className="h-7 w-full" />)}
      </div>
    );
  }
  if (state.isError) {
    return (
      <ErrorState
        className="py-4"
        title="Не удалось рассчитать RFM-сегменты"
        reason={state.error instanceof Error ? state.error.message : 'ошибка'}
        onRetry={() => state.refetch()}
        retrying={state.isFetching}
      />
    );
  }
  if (!state.data || state.data.customers === 0) {
    return <p className="py-4 text-sm text-muted-foreground">Нет покупателей с заказами в выбранном окне.</p>;
  }

  const total = mode === 'customers' ? state.data.customers : state.data.total_sum;
  return (
    <div className="space-y-3 pt-1">
      <SegmentedControl
        ariaLabel="Метрика RFM-сегментов"
        value={mode}
        onChange={(value) => setMode(value as RfmMode)}
        options={[
          { value: 'customers', content: 'Клиенты' },
          { value: 'revenue', content: 'Выручка' },
        ]}
      />
      <div className="space-y-2.5">
        {state.data.segments.map((segment) => {
          const meta = RFM_SEGMENTS[segment.key];
          const value = mode === 'customers' ? segment.customers : segment.sum;
          const share = total > 0 ? (value / total) * 100 : 0;
          const row = (
            <>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-foreground">{meta.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {mode === 'customers' ? fmt.num(value) : `${fmt.short(value)} ₽`}
                  </span>{' '}
                  · {share.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${Math.max(0, share)}%`, backgroundColor: meta.color }} />
              </div>
              {(detailed || expanded) && segment.customers > 0 && (
                <p className="mt-1 text-2xs text-muted-foreground">
                  {meta.action}; в среднем R {segment.average_recency_days == null ? '—' : segment.average_recency_days.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} дн. · F {segment.average_frequency == null ? '—' : segment.average_frequency.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} заказа · M {segment.average_monetary == null ? '—' : `${fmt.short(segment.average_monetary)} ₽`}.
                </p>
              )}
            </>
          );
          if (!onSelectSegment) return <div key={segment.key}>{row}</div>;
          const selected = selectedSegment === segment.key;
          return (
            <button
              key={segment.key}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectSegment(segment.key)}
              className={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                selected ? 'bg-muted/40' : 'hover:bg-muted/25'
              }`}
            >
              {row}
            </button>
          );
        })}
      </div>
      <p className="text-2xs text-muted-foreground">
        Оценки R/F/M относительны покупателям этого окна и устойчивы к одинаковым значениям;
        {state.data.as_of ? ` дата среза ${fmt.day(state.data.as_of)}.` : ' дата среза не определена.'}
      </p>
      {state.data.no_agent_orders > 0 && (
        <p className="text-2xs text-muted-foreground">
          Без контрагента: {fmt.num(state.data.no_agent_orders)} {pluralRu(state.data.no_agent_orders, ['заказ', 'заказа', 'заказов'])} — не сегментированы.
        </p>
      )}
    </div>
  );
}

/** Вертикальное тело карточки-статистики без графика: значение + подпись сразу под заголовком,
    строки ниже. Горизонтальный ChartCardBody прижимал число к левому низу, а строки — к правому
    верху, оставляя диагональную пустоту. */
function MsStatCardBody({
  value,
  caption,
  children,
}: {
  value: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="pt-1">
      <div className="kpi-accent text-3xl font-medium leading-none tabular-nums tracking-tight">{value}</div>
      <div className="mt-1.5 text-2xs text-muted-foreground">{caption}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function MsRepeatBreakdown({
  summary,
  repeatRevenueShare,
  allTime = false,
}: {
  summary: {
    new_customers: number;
    repeat_customers: number;
    orders_repeat: number;
    sum_new: number;
    sum_repeat: number;
    no_agent_orders: number;
  };
  repeatRevenueShare: number | null;
  allTime?: boolean;
}) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {!allTime && (
        <p>
          Новых <span className="font-medium tabular-nums text-foreground">{fmt.num(summary.new_customers)}</span> ·
          повторных <span className="font-medium tabular-nums text-foreground">{fmt.num(summary.repeat_customers)}</span>
        </p>
      )}
      <p>
        Повторные заказы: <span className="font-medium tabular-nums text-foreground">{fmt.num(summary.orders_repeat)}</span>{' '}
        на <span className="font-medium tabular-nums text-foreground">{fmt.short(summary.sum_repeat)} ₽</span>
      </p>
      <div className="pt-1">
        <div className="mb-1 flex items-center justify-between gap-3 text-2xs">
          <span>Доля повторной выручки</span>
          <span className="font-medium tabular-nums text-foreground">
            {repeatRevenueShare == null ? '—' : `${repeatRevenueShare.toFixed(1)}%`}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
          {repeatRevenueShare != null && (
            <div
              className="h-full rounded-full bg-[hsl(var(--chart-role-comparison))]"
              style={{ width: `${Math.min(100, Math.max(0, repeatRevenueShare))}%` }}
            />
          )}
        </div>
      </div>
      {summary.no_agent_orders > 0 && (
        // Честная сноска вместо тихого искажения: заказы без контрагента в клиентские метрики
        // не входят (некому приписать повторность).
        <p className="text-2xs">Без контрагента: {fmt.num(summary.no_agent_orders)} заказов — не учтены.</p>
      )}
    </div>
  );
}

const COHORT_OFFSETS = Array.from({ length: 12 }, (_, i) => i);

/** Порядковый номер месяца 'YYYY-MM' (для границы «прошлое/будущее» в клетках когорт). */
function monthIndex(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + (mo - 1);
}

function cohortMonthLabel(m: string) {
  return new Date(`${m}-01T00:00:00`)
    .toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' })
    .replace(' г.', '');
}

function MsCohortsCard({ state }: { state: ReturnType<typeof useMsCohorts> }) {
  return (
    <ChartWidget id="ms-cohorts" title="Когорты: возвращаемость по месяцу первой покупки" fixedSize="full" drillTo="/metrics/ms-cohorts">
      {state.isPending ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={`c${i}`} className="h-6 w-full" />
          ))}
        </div>
      ) : state.isError ? (
        <ErrorState
          className="py-4"
          title="Не удалось получить когорты"
          reason={state.error instanceof Error ? state.error.message : 'ошибка'}
          onRetry={() => state.refetch()}
          retrying={state.isFetching}
        />
      ) : !state.data || state.data.cohorts.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          Когорт пока нет — они появятся после загрузки истории заказов.
        </p>
      ) : (
        <MsCohortsTable cohorts={state.data.cohorts} />
      )}
    </ChartWidget>
  );
}

// Подпись под матрицей и aria — своя для каждого режима: ретеншен считает ДОЛЮ клиентов, а
// денежные режимы нормируют на ИСХОДНЫЙ размер когорты (не на активных), поэтому формулировка
// обязана это разделять. Возвраты нигде не вычитаются (инвариант ms_orders/RFM).
const COHORT_MODE_CAPTION: Record<MsCohortMode, string> = {
  retention:
    'Доля клиентов когорты, сделавших заказ через N месяцев после первой покупки; «0» — месяц самой первой покупки.',
  revenue:
    'Выручка заказов N-го месяца на одного ИСХОДНОГО клиента когорты (₽), помесячно — не среднее и не прибыль; возвраты не вычтены.',
  ltv: 'Накопленная выручка с 0-го по N-й месяц на одного ИСХОДНОГО клиента когорты (₽) — LTV; возвраты не вычтены.',
};

/** Формат значения клетки: ретеншен — проценты, деньги — компактные рубли (клетка узкая). */
function cohortCellLabel(value: number | null, mode: MsCohortMode): string {
  if (value == null) return '—';
  return isMoneyCohortMode(mode) ? `${fmt.short(value)} ₽` : `${Math.round(value * 100)}%`;
}

/** Полная подсказка клетки (title/aria) — всегда точные числа, режим явно назван. */
function cohortCellTitle(cell: MsCohortCell, size: number, value: number | null, mode: MsCohortMode): string {
  if (mode === 'retention') return `${fmt.num(cell.active)} из ${fmt.num(size)} клиентов`;
  if (value == null) return 'Сумма недоступна в точном числовом диапазоне';
  const per = `${fmt.num(value)} ₽ на клиента (÷ ${fmt.num(size)} исходных)`;
  return mode === 'revenue' ? `Выручка месяца: ${per}` : `Накопленная выручка (LTV): ${per}`;
}

/** Таблица когорт — ОТДЕЛЬНЫМ компонентом внутри детей карточки: ChartExpandedContext провайдится
    оверлеем разворота ВОКРУГ детей, поэтому читать его можно только отсюда (чтение в MsCohortsCard
    видело бы вечный false). Разворот показывает все когорты, свёрнуто — последние 12. `mode` по
    умолчанию 'retention' — компактная карточка Клиентов остаётся ретеншен-only и обратносовместима;
    режим передаёт только каноническая полная страница. */
export function MsCohortsTable({
  cohorts,
  mode = 'retention',
}: {
  cohorts: Array<{ cohort_month: string; size: number; cells: MsCohortCell[] }>;
  mode?: MsCohortMode;
}) {
  const expanded = useContext(ChartExpandedContext);
  const rows = expanded ? cohorts : cohorts.slice(-12);
  const money = isMoneyCohortMode(mode);
  const now = new Date();
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  // Максимум значения по видимым уже-наступившим клеткам — опора тепловой шкалы. В ретеншене
  // колонка «0» исключена: там по определению всегда 100%, и шкала «от неё» делала 1% и 8%
  // одинаково-прозрачными (нечитаемый плоский текст). Отрицательные значения заливку не получают.
  let colorMax = 0;
  for (const c of rows) {
    const elapsed = nowIdx - monthIndex(c.cohort_month);
    for (const o of COHORT_OFFSETS) {
      if (o > elapsed || c.size === 0 || (!money && o === 0)) continue;
      const v = cohortCellValue(c.cells, c.size, o, mode) ?? 0;
      if (v > colorMax) colorMax = v;
    }
  }
  if (colorMax <= 0) colorMax = 1;
  return (
    <>
      {/* Широкая матрица скроллится ВНУТРИ карточки (канон: без горизонтального overflow
          страницы; мобильное поведение не ломаем). */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-xs tabular-nums">
          <thead>
            <tr className="text-2xs text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-medium">Первая покупка</th>
              <th className="py-1.5 pr-3 text-right font-medium">Клиентов</th>
              {COHORT_OFFSETS.map((o) => (
                <th key={o} className="w-12 py-1.5 text-center font-medium">
                  {o === 0 ? '0' : `+${o}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
                  // Сколько offset-месяцев когорты уже НАСТУПИЛО: прошедший месяц без заказов —
                  // честный 0, будущий — пустая клетка (данных ещё нет, не ноль).
                  const elapsed = nowIdx - monthIndex(c.cohort_month);
                  return (
                    <tr key={c.cohort_month}>
                      <td className="whitespace-nowrap border-t border-border py-1.5 pr-3 text-left text-muted-foreground">
                        {cohortMonthLabel(c.cohort_month)}
                      </td>
                      <td className="border-t border-border py-1.5 pr-3 text-right font-medium text-foreground">
                        {fmt.num(c.size)}
                      </td>
                      {COHORT_OFFSETS.map((o) => {
                        if (o > elapsed || c.size === 0) {
                          return <td key={o} className="border-t border-border" />;
                        }
                        const cell = c.cells.find((x) => x.offset === o) ?? { offset: o, active: 0, revenue: 0 };
                        const value = cohortCellValue(c.cells, c.size, o, mode);
                        if (!money && o === 0) {
                          // Ретеншен, «0» — месяц самой первой покупки, всегда 100% по
                          // определению: приглушённый плоский текст вместо шумной пилюли.
                          return (
                            <td
                              key={o}
                              className="border-t border-border py-1.5 text-center text-muted-foreground"
                              title={cohortCellTitle(cell, c.size, value, mode)}
                            >
                              {cohortCellLabel(value, mode)}
                            </td>
                          );
                        }
                        // Заливка: доля от максимума видимой таблицы (только положительные).
                        const intensity = Math.min(1, Math.max(0, value ?? 0) / colorMax);
                        return (
                          <td key={o} className="border-t border-border p-0.5 text-center">
                            <span
                              className="block rounded px-1 py-1 text-foreground"
                              style={{ backgroundColor: `hsl(var(--chart-role-primary) / ${(intensity * 0.45).toFixed(3)})` }}
                              title={cohortCellTitle(cell, c.size, value, mode)}
                            >
                              {cohortCellLabel(value, mode)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-2xs text-muted-foreground">{COHORT_MODE_CAPTION[mode]}</p>
    </>
  );
}
