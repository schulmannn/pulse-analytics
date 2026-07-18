import { useContext, useState } from 'react';
import type { MsAssortmentComparison, MsMetricComparison, MsProductSort, MsTopSummary } from '@/api/queries';
import { useMsAssortmentComparison, useMsTopProducts } from '@/api/queries';
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
export type ExpandedView = 'concentration' | 'ranking' | 'dynamics';
/** Метрика изменения на вкладке «Динамика»: выручка / валовая прибыль / штуки. */
export type ChangeMetric = 'revenue' | 'profit' | 'units';

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
  changeMetric: changeMetricProp,
  onChangeMetric,
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
  changeMetric?: ChangeMetric;
  onChangeMetric?: (metric: ChangeMetric) => void;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [productSortState, setProductSortState] = useState<MsProductSort>('revenue');
  const [viewState, setViewState] = useState<ExpandedView>('concentration');
  const [concMetricState, setConcMetricState] = useState<ConcentrationMetric>('revenue');
  const [changeMetricState, setChangeMetricState] = useState<ChangeMetric>('revenue');
  const productSort = productSortProp ?? productSortState;
  const setProductSort = onProductSort ?? setProductSortState;
  const view = viewProp ?? viewState;
  const setView = onView ?? setViewState;
  const concMetric = concMetricProp ?? concMetricState;
  const setConcMetric = onConcMetric ?? setConcMetricState;
  const changeMetric = changeMetricProp ?? changeMetricState;
  const setChangeMetric = onChangeMetric ?? setChangeMetricState;

  // Концентрация сортирует по своей метрике (выручка/прибыль), рейтинг — по productSort. Компакт
  // сортирует по productSort. Переключение метрики концентрации меняет sort → backend переиспользует
  // тот же raw-кэш.
  const activeSort: MsProductSort = expanded && view === 'concentration' ? concMetric : productSort;
  // Прямой URL `view=dynamics` не должен одновременно запускать обычный top-products и opt-in
  // comparison: два параллельных miss одного raw-cache удвоили бы дорогой upstream page-loop.
  const top = useMsTopProducts(
    period,
    expanded ? EXPANDED_LIMIT : COMPACT_ROWS,
    activeSort,
    !(expanded && view === 'dynamics'),
  );

  if (!expanded) {
    // Компакт — прежний вид: «Рейтинг» + метрика + 5 строк. Сравнение здесь НИКОГДА не запрашивается.
    if (top.isPending) return <TopProductsSkeleton />;
    if (top.isError) return <TopProductsError state={top} />;
    const rows = (top.data?.rows ?? []) as TopRow[];
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

  const rows = (top.data?.rows ?? []) as TopRow[];
  const summary = top.data?.summary ?? null;

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
            { value: 'dynamics', content: 'Динамика' },
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
        ) : view === 'dynamics' ? (
          <SegmentedControl
            ariaLabel="Метрика изменения"
            size="sm"
            value={changeMetric}
            onChange={setChangeMetric}
            options={[
              { value: 'revenue', content: 'Выручка' },
              { value: 'profit', content: 'Валовая прибыль' },
              { value: 'units', content: 'Штуки' },
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
      {view === 'dynamics' ? (
        // Только вкладка «Динамика» тянет сравнение (opt-in compare=prev); свои loading/error/пустые
        // и «Всё»-недоступно состояния она держит внутри.
        <MsAssortmentDynamics period={period} metric={changeMetric} />
      ) : top.isPending ? (
        <TopProductsSkeleton />
      ) : top.isError ? (
        <TopProductsError state={top} />
      ) : view === 'ranking' ? (
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

function TopProductsSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={`t${i}`} className="h-6 w-full" />
      ))}
    </div>
  );
}

function TopProductsError({ state }: { state: ReturnType<typeof useMsTopProducts> }) {
  return (
    <ErrorState
      className="py-4"
      title="Не удалось получить топ товаров"
      reason={state.error instanceof Error ? state.error.message : 'ошибка'}
      onRetry={() => state.refetch()}
      retrying={state.isFetching}
    />
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
  const expanded = useContext(ChartExpandedContext);
  const shown = limit != null ? rows.slice(0, limit) : rows;
  return (
    <ul>
      {shown.map((row, i) => (
        <li
          key={`${row.name}-${i}`}
          className={`flex items-center gap-3 border-t border-border first:border-t-0 ${expanded ? 'py-1.5' : 'py-1'}`}
        >
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

// ── Динамика: сравнение с предыдущим равным окном ──────────────────────────────────────────────

type Mover = MsMetricComparison['gainers'][number];
type MoverKind = 'gain' | 'loss' | 'appeared' | 'disappeared';

/** Значение метрики в её натуральной единице (сервер уже дал рубли/штуки). */
export function fmtChangeValue(value: number, unit: 'rub' | 'count'): string {
  return unit === 'rub' ? `${fmt.short(value)} ₽` : `${fmt.num(value)} шт.`;
}

/**
 * Приглушённая подпись изменения (steep-канон «ничего не кричит» — без зелёного/красного). Рост/
 * падение показывают %-дельту, а при неположительной предыдущей базе (deltaPct == null) — абсолютный сдвиг.
 * Появившиеся/пропавшие честно отмечают отсутствие продаж в другом окне, а не выдуманный ±100%.
 */
export function changeLabel(entry: Mover, kind: MoverKind, unit: 'rub' | 'count'): string {
  if (kind === 'appeared') return 'ранее продаж не было';
  if (kind === 'disappeared') return 'сейчас продаж нет';
  const arrow = entry.delta >= 0 ? '▲' : '▼';
  if (entry.deltaPct == null) return `${arrow} ${fmtChangeValue(Math.abs(entry.delta), unit)}`;
  return `${arrow} ${Math.abs(entry.deltaPct).toFixed(1)}%`;
}

const MOVER_EMPTY: Record<MoverKind, string> = {
  gain: 'Нет товаров, выросших в обоих окнах.',
  loss: 'Нет товаров, снизившихся в обоих окнах.',
  appeared: 'Нет товаров с продажами только в текущем окне.',
  disappeared: 'Нет товаров без продаж в текущем окне.',
};

function MoverList({ title, entries, unit, kind }: { title: string; entries: Mover[]; unit: 'rub' | 'count'; kind: MoverKind }) {
  return (
    <section className="min-w-0">
      <h4 className="mb-1.5 text-2xs tracking-wide text-muted-foreground">{title}</h4>
      {entries.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{MOVER_EMPTY[kind]}</p>
      ) : (
        <ul>
          {entries.map((entry, i) => (
            <li
              key={`${entry.name}-${i}`}
              className="flex items-center gap-3 border-t border-border py-1.5 first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{entry.name || '—'}</span>
              <span className="shrink-0 text-sm tabular-nums text-foreground">
                {fmtChangeValue(kind === 'disappeared' ? entry.previous : entry.current, unit)}
              </span>
              <span className="w-32 shrink-0 truncate text-right text-2xs tabular-nums text-muted-foreground">
                {changeLabel(entry, kind, unit)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Метрик-независимые счётчики присутствия: сколько товаров в обоих окнах, появились, пропали. */
function DynamicsCounts({ counts }: { counts: { current_only: number; previous_only: number; both: number } }) {
  const tiles = [
    { label: 'Товаров в обоих окнах', value: fmt.num(counts.both) },
    { label: 'Появились продажи', value: fmt.num(counts.current_only) },
    { label: 'Нет продаж в текущем', value: fmt.num(counts.previous_only) },
  ];
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-border pb-3 sm:grid-cols-3">
      {tiles.map((t) => (
        <div key={t.label} className="flex items-baseline justify-between gap-3">
          <span className="text-2xs tracking-wide text-muted-foreground">{t.label}</span>
          <span className="text-sm font-medium tabular-nums text-foreground">{t.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Вкладка «Динамика»: текущее окно против предыдущего равного. Решающие вопросы — наибольший рост и
 * падение (товары из обоих окон), товары с продажами только сейчас и только в прошлом окне. Не
 * называем последние «снятыми с продажи», а текущие-only — «новинками каталога»: отчёт доказывает
 * только наличие/отсутствие продаж в окнах. Возвраты в отчёт profit не входят и не вычитаются.
 */
function MsAssortmentDynamics({ period, metric }: { period: MsPeriod; metric: ChangeMetric }) {
  const q = useMsAssortmentComparison(period, true);
  if (q.isPending) return <TopProductsSkeleton />;
  if (q.isError) {
    return (
      <ErrorState
        className="py-4"
        title="Не удалось получить сравнение периодов"
        reason={q.error instanceof Error ? q.error.message : 'ошибка'}
        onRetry={() => q.refetch()}
        retrying={q.isFetching}
      />
    );
  }
  const comparison: MsAssortmentComparison | undefined = q.data?.comparison;
  if (!comparison) {
    return <p className="py-4 text-sm text-muted-foreground">Сравнение с предыдущим периодом недоступно.</p>;
  }
  if (!comparison.available) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Для окна «Всё» предыдущего равного периода не существует — сравнение недоступно.
      </p>
    );
  }
  const m = comparison.metrics[metric];
  const nothing =
    m.gainers.length === 0 && m.losers.length === 0 && m.appeared.length === 0 && m.disappeared.length === 0;
  return (
    <div className="flex min-h-0 flex-col gap-4">
      {comparison.partial && (
        <p className="text-xs text-muted-foreground">
          Отчёт по товарам за период неполон — сравнение основано на частичных данных.
        </p>
      )}
      {comparison.identity_fallback_count > 0 && (
        <p className="text-xs text-muted-foreground">
          Для {fmt.num(comparison.identity_fallback_count)} позиций МойСклад не вернул стабильный ID —
          сопоставление выполнено по названию.
        </p>
      )}
      <DynamicsCounts counts={comparison.counts} />
      {nothing ? (
        <p className="py-4 text-sm text-muted-foreground">Продажи в обоих окнах не различаются по выбранному показателю.</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2">
          <MoverList title="Наибольший рост" entries={m.gainers} unit={m.unit} kind="gain" />
          <MoverList title="Наибольшее падение" entries={m.losers} unit={m.unit} kind="loss" />
          <MoverList title="Появились продажи" entries={m.appeared} unit={m.unit} kind="appeared" />
          <MoverList title="Нет продаж в текущем периоде" entries={m.disappeared} unit={m.unit} kind="disappeared" />
        </div>
      )}
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Предыдущее окно {formatComparisonDay(comparison.previous.from)} —{' '}
        {formatComparisonDay(comparison.previous.to)}, текущее {formatComparisonDay(comparison.current.from)} —{' '}
        {formatComparisonDay(comparison.current.to)}. Возвраты не вычитаются.
      </p>
    </div>
  );
}

function formatComparisonDay(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}
