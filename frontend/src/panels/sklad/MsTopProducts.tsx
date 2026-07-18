import { useContext, useState } from 'react';
import type { MsProductSort, MsTopSummary } from '@/api/queries';
import { useMsTopProducts } from '@/api/queries';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { cumulativeContribution, cumulativePointLabel } from '@/lib/msConcentration';
import type { MsPeriod } from '@/lib/msPeriod';

type TopRow = { name: string; quantity: number; revenue: number; profit: number; margin: number | null };
export type ConcentrationMetric = 'revenue' | 'profit';
export type ExpandedView = 'concentration' | 'ranking';

const COMPACT_ROWS = 5;
const EXPANDED_LIMIT = 50;

const PRODUCT_SORT_OPTIONS: Array<{ value: MsProductSort; content: string }> = [
  { value: 'revenue', content: 'Выручка' },
  { value: 'profit', content: 'Прибыль' },
  { value: 'margin', content: 'Маржа' },
];

/**
 * Карточка «Товары». Тот же элемент рендерится дважды: компактно в тайле (ChartExpandedContext =
 * false) и в оверлее разворота (true) — как список товаров раньше. Компакт остаётся дешёвым
 * пятистрочным рейтингом; разворот добавляет вид «Концентрация / Рейтинг» и открывается на
 * концентрации. Компакт тянет только 5 строк; разворот — свою sort-specific выборку (limit 50),
 * которую backend отдаёт из ОДНОГО кэшированного raw-отчёта (без второго page-loop к МойСкладу).
 */
export function MsTopProductsCard({
  period,
  view: viewProp,
  onView,
  productSort: productSortProp,
  onProductSort,
  concMetric: concMetricProp,
  onConcMetric,
}: {
  period: MsPeriod;
  // Optional controlled bindings so the canonical `/metrics/ms-products` page can own these
  // controls in the URL; omitted → the card stays self-owned (compact tile in Обзор).
  view?: ExpandedView;
  onView?: (view: ExpandedView) => void;
  productSort?: MsProductSort;
  onProductSort?: (sort: MsProductSort) => void;
  concMetric?: ConcentrationMetric;
  onConcMetric?: (metric: ConcentrationMetric) => void;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [productSortState, setProductSortState] = useState<MsProductSort>('revenue');
  const [viewState, setViewState] = useState<ExpandedView>('concentration');
  const [concMetricState, setConcMetricState] = useState<ConcentrationMetric>('revenue');
  const productSort = productSortProp ?? productSortState;
  const setProductSort = onProductSort ?? setProductSortState;
  const view = viewProp ?? viewState;
  const setView = onView ?? setViewState;
  const concMetric = concMetricProp ?? concMetricState;
  const setConcMetric = onConcMetric ?? setConcMetricState;

  // Концентрация сортирует по своей метрике (выручка/прибыль), рейтинг — по productSort. Компакт
  // сортирует по productSort. Переключение метрики концентрации меняет sort → backend переиспользует
  // тот же raw-кэш.
  const activeSort: MsProductSort = expanded && view === 'concentration' ? concMetric : productSort;
  const top = useMsTopProducts(period, expanded ? EXPANDED_LIMIT : COMPACT_ROWS, activeSort);

  if (top.isPending) {
    return (
      <div className="space-y-2 py-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={`t${i}`} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (top.isError) {
    return (
      <ErrorState
        className="py-4"
        title="Не удалось получить топ товаров"
        reason={top.error instanceof Error ? top.error.message : 'ошибка'}
        onRetry={() => top.refetch()}
        retrying={top.isFetching}
      />
    );
  }

  const rows = (top.data?.rows ?? []) as TopRow[];
  const summary = top.data?.summary ?? null;

  if (!expanded) {
    // Компакт — прежний вид: «Рейтинг» + метрика + 5 строк.
    return (
      <>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-2xs text-muted-foreground">Рейтинг</span>
          <SegmentedControl
            ariaLabel="Метрика рейтинга товаров"
            size="sm"
            value={productSort}
            onChange={setProductSort}
            options={PRODUCT_SORT_OPTIONS}
          />
        </div>
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsTopProductsList rows={rows} metric={productSort} limit={COMPACT_ROWS} />
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          ariaLabel="Вид отчёта товаров"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'concentration', content: 'Концентрация' },
            { value: 'ranking', content: 'Рейтинг' },
          ]}
        />
        {view === 'concentration' ? (
          <SegmentedControl
            ariaLabel="Метрика концентрации"
            size="sm"
            value={concMetric}
            onChange={setConcMetric}
            options={[
              { value: 'revenue', content: 'Выручка' },
              { value: 'profit', content: 'Валовая прибыль' },
            ]}
          />
        ) : (
          <SegmentedControl
            ariaLabel="Метрика рейтинга товаров"
            size="sm"
            value={productSort}
            onChange={setProductSort}
            options={PRODUCT_SORT_OPTIONS}
          />
        )}
      </div>
      {view === 'ranking' ? (
        rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsTopProductsList rows={rows} metric={productSort} />
        )
      ) : (
        <MsConcentrationView rows={rows} summary={summary} metric={concMetric} />
      )}
    </div>
  );
}

/** Кумулятивная кривая концентрации (Pareto) + заголовок доли топ-N + решающие KPI. Знаменатель —
    только положительный итог из ответа сервера (полный отчёт до limit). Если сводки нет (отчёт
    усечён) или положительной метрики нет — честно показываем недоступность, а не 0/частичную долю. */
function MsConcentrationView({
  rows,
  summary,
  metric,
}: {
  rows: TopRow[];
  summary: MsTopSummary | null;
  metric: ConcentrationMetric;
}) {
  const expandedHeight = useContext(ExpandedChartHeightContext);
  const metricWord = metric === 'revenue' ? 'положительной выручки' : 'положительной валовой прибыли';

  if (!summary || !summary.complete) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Отчёт по товарам за период неполон — концентрация недоступна.
      </p>
    );
  }

  const denominator = metric === 'revenue' ? summary.revenue_positive_total : summary.profit_positive_total;
  const share = metric === 'revenue' ? summary.revenue_top10_share_pct : summary.profit_top10_share_pct;
  const points = cumulativeContribution(
    rows.map((r) => ({ name: r.name, value: metric === 'revenue' ? r.revenue : r.profit })),
    denominator,
    EXPANDED_LIMIT,
  );

  if (share == null || points.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Недостаточно данных о {metricWord} за период для оценки концентрации.
      </p>
    );
  }

  const values = points.map((p) => p.cumulativePct);
  const labels = points.map((p) => String(p.rank));
  const titles = points.map(cumulativePointLabel);
  const chartH = Math.min(expandedHeight ?? 300, 320);
  const topN = summary.top_n;

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <ChartCardBody
        label={`Доля топ-${topN} · ${metricWord}`}
        value={`${share.toFixed(1)}%`}
        caption={`топ-${topN} из ${fmt.num(summary.product_count)} товаров дают эту долю ${metricWord}`}
      >
        {/* The shared explorer normally gives its only chart the whole remaining panel height.
            This view also has a headline and KPI ledger, so override that context locally to keep
            every decision row inside the viewport instead of clipping it below the fold. */}
        <ExpandedChartHeightContext.Provider value={chartH}>
          <LineChart
            values={values}
            labels={labels}
            titles={titles}
            yMin={0}
            yMax={100}
            showPoints
            fullAxes
            formatValue={(v) => `${v.toFixed(1)}%`}
            height={chartH}
          />
        </ExpandedChartHeightContext.Provider>
      </ChartCardBody>
      {/* Доступный дубль кривой для скринридера: имя товара и проценты в каждой точке. */}
      <ol className="sr-only">
        {points.map((p) => (
          <li key={`${p.rank}-${p.name}`}>{cumulativePointLabel(p)}</li>
        ))}
      </ol>
      <MsConcentrationKpis summary={summary} />
    </div>
  );
}

/** Решающие KPI концентрации: число товаров в полном отчёте, общая маржа (только при выручке > 0)
    и убыточные позиции (счётчик + абсолютный убыток). */
function MsConcentrationKpis({ summary }: { summary: MsTopSummary }) {
  const tiles = [
    { label: 'Товаров в отчёте', value: fmt.num(summary.product_count) },
    { label: 'Общая маржа', value: summary.net_margin_pct == null ? '—' : `${summary.net_margin_pct.toFixed(1)}%` },
    {
      label: 'Убыточных товаров',
      value:
        summary.loss_making_count > 0
          ? `${fmt.num(summary.loss_making_count)} · −${fmt.short(summary.loss_making_amount)} ₽`
          : '0',
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-3">
      {tiles.map((t) => (
        <div key={t.label} className="flex items-baseline justify-between gap-3">
          <span className="text-2xs tracking-wide text-muted-foreground">{t.label}</span>
          <span className="text-sm font-medium tabular-nums text-foreground">{t.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Список топ-товаров. Компакт передаёт `limit=5`; разворот-рейтинг показывает весь состав ответа. */
function MsTopProductsList({ rows, metric, limit }: { rows: TopRow[]; metric: MsProductSort; limit?: number }) {
  const shown = limit != null ? rows.slice(0, limit) : rows;
  return (
    <ul>
      {shown.map((row, i) => (
        <li key={`${row.name}-${i}`} className="flex items-center gap-3 border-t border-border py-1.5 first:border-t-0">
          <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmt.num(row.quantity)} шт.</span>
          <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums text-foreground">
            {formatProductPrimary(row, metric)}
          </span>
          <span className="w-36 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
            {formatProductSecondary(row, metric)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function formatProfit(value: number): string {
  return `${value < 0 ? '−' : ''}${fmt.short(Math.abs(value))} ₽`;
}

function formatMargin(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)}%`;
}

function formatProductPrimary(row: { revenue: number; profit: number; margin: number | null }, metric: MsProductSort): string {
  if (metric === 'profit') return formatProfit(row.profit);
  if (metric === 'margin') return formatMargin(row.margin);
  return `${fmt.short(row.revenue)} ₽`;
}

function formatProductSecondary(row: { revenue: number; profit: number; margin: number | null }, metric: MsProductSort): string {
  if (metric === 'profit') return `выруч. ${fmt.short(row.revenue)} ₽ · ${formatMargin(row.margin)}`;
  if (metric === 'margin') return `приб. ${formatProfit(row.profit)} · выруч. ${fmt.short(row.revenue)} ₽`;
  return `приб. ${formatProfit(row.profit)} · ${formatMargin(row.margin)}`;
}
