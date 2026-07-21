import { useCallback, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartSection as RailSection } from '@/components/instagram/shared';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { PeriodChips } from '@/components/PeriodChips';
import { SourceIdentity } from '@/components/SourceIdentity';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { usePeriod, type DateRange, type PeriodDays } from '@/lib/period';
import { msPreviousPeriod, useMsResolvedPeriod, type MsPeriod } from '@/lib/msPeriod';
import { metricTotal, type Grain, type Metric } from '@/lib/msSeries';
import { customerMetricTotal, type MsCustomerMetric } from '@/lib/msCustomerSeries';
import type { MsChannelContributionMetric } from '@/lib/msChannelContribution';
import { MS_COHORT_MODES, type MsCohortMode } from '@/lib/msCohortMode';
import {
  applyMsMetricChannels,
  applyMsMetricEnum,
  parseMsMetricUrl,
  type MsMetricUrlSchema,
} from '@/lib/msMetricUrlState';
import {
  useMsChannelSeries,
  useMsCustomers,
  useMsFunnel,
  useMsGeography,
  useMsReturns,
  useMsRfm,
  useMsSalesByChannel,
  useMsSummary,
  useMsTopCustomers,
  useMsCohorts,
  type MsProductSort,
} from '@/api/queries';
import {
  MsSummaryExplorer,
  MsFunnelRows,
  MsReturnsExplorer,
  RETURNS_METRIC_OPTIONS,
  fmtReturnsMetric,
  type MsReturnsMetric,
} from '@/panels/sklad/MsOverview';
import {
  MsCustomerExplorer,
  MsCohortsTable,
  MsRfmBody,
  MsTopCustomersBody,
  CUSTOMER_METRIC_OPTIONS,
  RFM_SEGMENTS,
  type RfmSegmentKey,
} from '@/panels/sklad/MsClients';
import { MsRfmSegmentCustomers } from '@/panels/sklad/MsRfmCustomers';
import {
  MsChannelChart,
  MsChannelContribution,
  MsChannelControls,
  MsChannelRows,
  MsGeographyRows,
  type View,
  type ChannelOption,
} from '@/panels/sklad/MsChannels';
import {
  MsTopProductsCard,
  type ChangeMetric,
  type ConcentrationMetric,
  type ExpandedView,
} from '@/panels/sklad/MsTopProducts';
import { MsStockTable, STOCK_SORT_OPTIONS, type MsStockSort } from '@/panels/sklad/MsStock';
import { isMsMetricKey } from '@/panels/sklad/msMetricKeys';

/**
 * Полностраничные метрики МойСклада — `/metrics/ms-*`. Каждая раскрываемая карточка Обзора/Клиентов/
 * Каналов ведёт СЮДА (`drillTo`), а не в модальный `?detail=` оверлей: та же информационная
 * архитектура и визуальная грамматика, что у эталона Instagram `/metrics/ig-reach` — назад-ссылка,
 * тихая шапка (имя метрики + источник + дескриптор), две колонки (главный график/отчёт + rail «О
 * метрике»), контролы графика и тайм-бар окна под ним. Тела графиков/отчётов переиспользуются из
 * панелей (self-fetch по выбранному окну), поэтому число считается ровно для окна страницы.
 */
export function MsMetricPage({ metricKey }: { metricKey: string }) {
  switch (metricKey) {
    case 'ms-revenue':
      return (
        <MsSummaryPage
          metric="revenue"
          term="Выручка"
          descriptor="Продажи МойСклада за выбранное окно"
          about={{
            formula: 'Сумма продаж по дням; бакет недели/месяца — сумма за бакет.',
            included: 'Возвраты считаются отдельно и из выручки не вычитаются.',
            source: 'Отчёт продаж МойСклада (plotseries) + дневной архив ms_daily.',
          }}
        />
      );
    case 'ms-orders':
      return (
        <MsSummaryPage
          metric="orders"
          term="Заказы"
          descriptor="Число заказов МойСклада за выбранное окно"
          about={{
            formula: 'Число заказов по дням; бакет недели/месяца — сумма заказов за бакет.',
            source: 'Заказы МойСклада (ms_orders) + дневной архив ms_daily.',
          }}
        />
      );
    case 'ms-aov':
      return (
        <MsSummaryPage
          metric="aov"
          term="Средний чек"
          descriptor="Средний чек МойСклада за выбранное окно"
          about={{
            formula:
              'Σ суммы заказов ÷ Σ числа заказов за бакет (не среднее дневных чеков). В период без заказов не определён.',
            source: 'Заказы МойСклада (ms_orders) + дневной архив ms_daily.',
          }}
        />
      );
    case 'ms-customers':
      return (
        <MsCustomerPage
          term="Покупатели"
          descriptor="Новые и повторные покупки за выбранное окно"
          defaultMetric="orders"
        />
      );
    case 'ms-repeat':
      return (
        <MsCustomerPage
          term="Повторные покупки"
          descriptor="Повторные покупатели и их выручка за выбранное окно"
          defaultMetric="repeatShare"
        />
      );
    case 'ms-rfm':
      return <MsRfmPage />;
    case 'ms-channels':
      return <MsChannelsPage />;
    case 'ms-funnel':
      return <MsFunnelPage />;
    case 'ms-products':
      return <MsProductsPage />;
    case 'ms-returns':
      return <MsReturnsPage />;
    case 'ms-sales-channels':
      return <MsSalesChannelsPage />;
    case 'ms-geography':
      return <MsGeographyPage />;
    case 'ms-top-customers':
      return <MsTopCustomersPage />;
    case 'ms-cohorts':
      return <MsCohortsPage />;
    case 'ms-stock':
      return <MsStockPage />;
    default:
      return null;
  }
}

/** Re-export guard so the route dispatcher can gate `ms-*` keys without importing the page eagerly. */
export { isMsMetricKey };

// ── URL-owned explorer controls ─────────────────────────────────────────────────────────────

const GRAIN = { values: ['day', 'week', 'month'], defaultValue: 'day' } as const;
const CHART = { values: ['line', 'bar'], defaultValue: 'line' } as const;
const COMPARE = { values: ['prev', 'off'], defaultValue: 'prev' } as const;
const SUMMARY_URL: MsMetricUrlSchema = { enums: { grain: GRAIN, chart: CHART, compare: COMPARE } };
const CHANNELS_URL: MsMetricUrlSchema = {
  enums: {
    grain: GRAIN,
    chart: CHART,
    metric: { values: ['revenue', 'orders', 'aov'], defaultValue: 'revenue' },
    view: { values: ['aggregate', 'breakdown'], defaultValue: 'aggregate' },
    compare: COMPARE,
  },
  channels: true,
};
const FUNNEL_URL: MsMetricUrlSchema = {
  enums: { metric: { values: ['orders', 'revenue'], defaultValue: 'orders' }, compare: COMPARE },
};
const PRODUCTS_URL: MsMetricUrlSchema = {
  enums: {
    view: { values: ['concentration', 'ranking', 'dynamics'], defaultValue: 'concentration' },
    sort: { values: ['revenue', 'profit', 'margin'], defaultValue: 'revenue' },
    concentration: { values: ['revenue', 'profit'], defaultValue: 'revenue' },
    // Метрика изменения на вкладке «Динамика»; сервер отдаёт все три сразу, поэтому это чистый
    // клиентский переключатель, не влияющий на запрос/кэш.
    change: { values: ['revenue', 'profit', 'units'], defaultValue: 'revenue' },
  },
};
const STOCK_URL: MsMetricUrlSchema = {
  // Только клиентская сортировка таблицы: запрос/кэш от неё не зависят (сервер всегда отдаёт
  // порядок по срочности), поэтому compare/grain здесь нет.
  enums: { sort: { values: ['days', 'stock', 'sold'], defaultValue: 'days' } },
};
const RETURNS_URL: MsMetricUrlSchema = {
  enums: {
    grain: GRAIN,
    chart: CHART,
    metric: { values: ['count', 'sum'], defaultValue: 'count' },
    compare: COMPARE,
  },
};
const CONTRIBUTION_URL: MsMetricUrlSchema = {
  enums: { metric: { values: ['revenue', 'orders'], defaultValue: 'revenue' }, compare: COMPARE },
};
const COMPARE_URL: MsMetricUrlSchema = { enums: { compare: COMPARE } };
// Когорты — только режим клетки (mode); окна нет (вся история), поэтому ни period, ни compare.
const COHORTS_URL: MsMetricUrlSchema = {
  enums: { mode: { values: [...MS_COHORT_MODES], defaultValue: 'retention' } },
};
const RFM_URL: MsMetricUrlSchema = {
  enums: {
    // 'none' = сегмент не выбран (дефолт — из URL убирается); остальные ключи — канон RFM_SEGMENTS.
    segment: {
      values: ['none', 'champions', 'loyal', 'potential', 'new', 'at_risk', 'hibernating'],
      defaultValue: 'none',
    },
    compare: COMPARE,
  },
};

/** One merge-and-replace URL owner per metric page: no competing effects or history spam. */
function useMsMetricUrlControls(schema: MsMetricUrlSchema) {
  const [params, setParams] = useSearchParams();
  const parsed = useMemo(() => parseMsMetricUrl(params, schema), [params, schema]);
  const canonical = parsed.canonical.toString();
  const current = params.toString();

  useEffect(() => {
    if (canonical !== current) setParams(parsed.canonical, { replace: true });
  }, [canonical, current, parsed.canonical, setParams]);

  const setEnum = useCallback((key: string, value: string) => {
    setParams((prev) => applyMsMetricEnum(prev, schema, key, value), { replace: true });
  }, [schema, setParams]);
  const setChannels = useCallback((ids: readonly string[]) => {
    setParams((prev) => applyMsMetricChannels(prev, ids), { replace: true });
  }, [setParams]);

  return { values: parsed.values, channels: parsed.channels, setEnum, setChannels };
}

// ── Shared shell ─────────────────────────────────────────────────────────────────────────────

type Back = { to: string; label: string };
const BACK_OVERVIEW: Back = { to: '/sklad', label: 'МойСклад · Обзор' };
const BACK_CLIENTS: Back = { to: '/sklad/clients', label: 'МойСклад · Клиенты' };
const BACK_CHANNELS: Back = { to: '/sklad/channels', label: 'МойСклад · Каналы' };

interface AboutDef {
  formula: string;
  included?: string;
  source: string;
}

/** Тихая шапка + две колонки (главный блок + rail «О метрике»), как у `/metrics/ig-reach`. */
function MsMetricShell({
  back,
  term,
  descriptor,
  about,
  comparison,
  children,
}: {
  back: Back;
  term: string;
  descriptor?: string;
  about: AboutDef;
  comparison?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Link
        to={back.to}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> {back.label}
      </Link>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="ms" className="mt-1 max-w-full" />
        {descriptor && <div className="mt-1.5 text-xs text-muted-foreground">{descriptor}</div>}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="space-y-6">
          <RailSection title="Сравнение">
            {comparison ?? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Для этого отчёта нет одной канонической метрики периода — сравнение не рассчитывается.
              </p>
            )}
          </RailSection>
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={about.formula} />
              {about.included && <AboutRow label="Что учитывается" text={about.included} />}
              <AboutRow label="Источник" text={about.source} />
            </dl>
          </RailSection>
          <Link
            to={back.to}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть раздел <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
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

/** Пресеты окна одной строкой под графиком (тайм-бар принадлежит графику, а не краю экрана). */
interface MsMetricWindow {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
  range: DateRange | null;
  setRange: (range: DateRange | null) => void;
  period: MsPeriod;
  previousPeriod: MsPeriod | null;
}

function useMsMetricWindow(): MsMetricWindow {
  const { days, setDays, range, setRange } = usePeriod();
  const period = useMsResolvedPeriod({ days, range });
  const previousPeriod = useMemo(() => msPreviousPeriod(period), [period]);
  return { days, setDays, range, setRange, period, previousPeriod };
}

function ControlBar({
  window,
  grain,
  onGrain,
  extra,
}: {
  window: MsMetricWindow;
  grain?: Grain;
  onGrain?: (grain: Grain) => void;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">Окно</span>
      <PeriodChips
        ariaLabel="Окно"
        value={window.days}
        onChange={window.setDays}
        range={window.range}
        onRangeChange={window.setRange}
      />
      {grain && onGrain && (
        <SegmentedControl
          ariaLabel="Грануляция"
          className="shrink-0"
          value={grain}
          onChange={onGrain}
          options={(['day', 'week', 'month'] as const).map((g) => ({
            value: g,
            content: g === 'day' ? 'День' : g === 'week' ? 'Неделя' : 'Месяц',
          }))}
        />
      )}
      {extra}
    </div>
  );
}

function ComparisonReadout({
  current,
  previous,
  format,
  previousPeriod,
  pending = false,
  error = false,
  label = 'Текущее окно',
  mode,
  onMode,
}: {
  current: number | null;
  previous: number | null;
  format: (value: number) => string;
  previousPeriod: MsPeriod | null;
  pending?: boolean;
  error?: boolean;
  label?: string;
  mode: 'off' | 'prev';
  onMode: (mode: 'off' | 'prev') => void;
}) {
  const delta = current != null && previous != null && previous !== 0
    ? ((current - previous) / Math.abs(previous)) * 100
    : null;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-base font-medium tabular-nums text-foreground">
          {current == null ? '—' : format(current)}
        </span>
      </div>
      <SegmentedControl
        ariaLabel="База сравнения"
        size="sm"
        value={mode}
        onChange={onMode}
        options={[
          { value: 'off', content: 'Выкл' },
          { value: 'prev', content: 'Пред. период', disabled: previousPeriod == null },
        ]}
      />
      {mode === 'off' ? (
        <p className="text-xs text-muted-foreground">Выберите предыдущий равный период для сравнения.</p>
      ) : previousPeriod == null ? (
        <p className="text-xs text-muted-foreground">Для окна «Всё» предыдущего равного периода не существует.</p>
      ) : pending ? (
        <Skeleton className="h-12 w-full" />
      ) : error ? (
        <p className="text-xs text-muted-foreground">Не удалось получить предыдущий период.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Пред. период</span>
            <span className="tabular-nums">{previous == null ? '—' : format(previous)}</span>
          </div>
          {delta != null && (
            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">Изменение</span>
              <span className={`text-xs font-medium tabular-nums ${delta >= 0 ? 'text-verdant' : 'text-ember'}`}>
                {delta >= 0 ? '▲' : '▼'}{Math.abs(delta).toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const KIND_OPTIONS = [
  { value: 'line' as const, content: 'Линия' },
  { value: 'bar' as const, content: 'Столбцы' },
];

/** Каркас главного блока графика: карточка с телом explorer'а (self-fetch), контролы окна/грануляции
    под ним и переключатель линия/столбцы в заголовке карточки. */
function MsChartCard({
  id,
  title,
  chart,
  kind,
  onKind,
  controlBar,
}: {
  id: string;
  title: string;
  chart: ReactNode;
  kind?: 'line' | 'bar';
  onKind?: (kind: 'line' | 'bar') => void;
  controlBar: ReactNode;
}) {
  const chartH = useExplorerChartHeight();
  return (
    <>
      <ChartWidget
        id={id}
        title={title}
        defaultSize="full"
        noExpand
        action={
          kind && onKind ? (
            <SegmentedControl
              ariaLabel="Тип графика"
              className="shrink-0"
              value={kind}
              onChange={onKind}
              options={KIND_OPTIONS}
            />
          ) : undefined
        }
      >
        <ChartExpandedContext.Provider value={true}>
          <ExpandedChartHeightContext.Provider value={chartH}>{chart}</ExpandedChartHeightContext.Provider>
        </ChartExpandedContext.Provider>
      </ChartWidget>
      {controlBar}
    </>
  );
}

// ── Series pages (revenue / orders / aov) ─────────────────────────────────────────────────────

function MsSummaryPage({
  metric,
  term,
  descriptor,
  about,
}: {
  metric: Metric;
  term: string;
  descriptor: string;
  about: AboutDef;
}) {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(SUMMARY_URL);
  const grain = controls.values.grain as Grain;
  const kind = controls.values.chart as 'line' | 'bar';
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const current = useMsSummary(window.period);
  const previous = useMsSummary(comparisonPeriod ?? window.period);
  const valueOf = (data: typeof current.data): number | null => {
    if (!data) return null;
    if (metric === 'revenue') return data.revenue.total;
    if (metric === 'orders') return data.orders.totalCount;
    return data.orders.totalCount > 0 ? data.orders.totalSum / data.orders.totalCount : null;
  };
  const format = (value: number) => metric === 'orders' ? fmt.num(value) : `${fmt.short(value)} ₽`;
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term={term}
      descriptor={descriptor}
      about={about}
      comparison={
        <ComparisonReadout
          current={valueOf(current.data)}
          previous={comparisonPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={current.isPending || (comparisonPeriod != null && previous.isPending)}
          error={current.isError || (comparisonPeriod != null && previous.isError)}
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsChartCard
        id={`ms-page-${metric}`}
        title="По периодам"
        kind={kind}
        onKind={(value) => controls.setEnum('chart', value)}
        chart={
          <MsSummaryExplorer
            metric={metric}
            period={window.period}
            comparisonPeriod={comparisonPeriod}
            grain={grain}
            kind={kind}
          />
        }
        controlBar={<ControlBar window={window} grain={grain} onGrain={(value) => controls.setEnum('grain', value)} />}
      />
    </MsMetricShell>
  );
}

// ── Customer pages (customers / repeat) ────────────────────────────────────────────────────────

function MsCustomerPage({
  term,
  descriptor,
  defaultMetric,
}: {
  term: string;
  descriptor: string;
  defaultMetric: MsCustomerMetric;
}) {
  const window = useMsMetricWindow();
  const urlSchema = useMemo<MsMetricUrlSchema>(() => ({
    enums: {
      grain: GRAIN,
      chart: CHART,
      metric: { values: ['orders', 'revenue', 'repeatShare'], defaultValue: defaultMetric },
      compare: COMPARE,
    },
  }), [defaultMetric]);
  const controls = useMsMetricUrlControls(urlSchema);
  const grain = controls.values.grain as Grain;
  const kind = controls.values.chart as 'line' | 'bar';
  const metric = controls.values.metric as MsCustomerMetric;
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const current = useMsCustomers(window.period);
  const previous = useMsCustomers(comparisonPeriod ?? window.period);
  const valueOf = (data: typeof current.data) => data ? customerMetricTotal(data.series, metric).value : null;
  const format = (value: number) =>
    metric === 'orders' ? fmt.num(value) : metric === 'revenue' ? `${fmt.short(value)} ₽` : `${value.toFixed(1)}%`;
  return (
    <MsMetricShell
      back={BACK_CLIENTS}
      term={term}
      descriptor={descriptor}
      about={{
        formula:
          '«Новый» = первый заказ контрагента за всю историю канала; «повторный» — последующие. Доля повторной выручки = Σ повторной выручки ÷ Σ общей выручки.',
        included: 'Заказы без контрагента не учитываются — некому приписать повторность.',
        source: 'Архив заказов МойСклада (ms_orders).',
      }}
      comparison={
        <ComparisonReadout
          current={valueOf(current.data)}
          previous={comparisonPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={current.isPending || (comparisonPeriod != null && previous.isPending)}
          error={current.isError || (comparisonPeriod != null && previous.isError)}
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsChartCard
        id="ms-page-customers"
        title="По периодам"
        kind={kind}
        onKind={(value) => controls.setEnum('chart', value)}
        chart={<MsCustomerExplorer metric={metric} period={window.period} grain={grain} kind={kind} />}
        controlBar={
          <ControlBar
            window={window}
            grain={grain}
            onGrain={(value) => controls.setEnum('grain', value)}
            extra={
              <SegmentedControl
                ariaLabel="Метрика покупателей"
                className="shrink-0"
                value={metric}
                onChange={(value) => controls.setEnum('metric', value)}
                options={CUSTOMER_METRIC_OPTIONS}
              />
            }
          />
        }
      />
    </MsMetricShell>
  );
}

// ── Channels dynamics page ────────────────────────────────────────────────────────────────────

function MsChannelsPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(CHANNELS_URL);
  const grain = controls.values.grain as Grain;
  const requestedKind = controls.values.chart as 'line' | 'bar';
  const metric = controls.values.metric as Metric;
  const view = controls.values.view as View;
  const compare = controls.values.compare as 'off' | 'prev';
  const selected = controls.channels;
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const channels = useMsSalesByChannel(window.period);
  const options: ChannelOption[] = useMemo(() => (channels.data?.rows ?? []).map((r) => ({
    id: r.sales_channel_id,
    name: r.name ?? 'Канал без имени',
  })), [channels.data?.rows]);
  const selectableOptions = useMemo(() => {
    const known = new Set(options.map((option) => option.id.toLowerCase()));
    return [
      ...options,
      ...selected
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: `Недоступный канал · ${id.slice(0, 8)}` })),
    ];
  }, [options, selected]);
  const breakdown = view === 'breakdown';
  const kind: 'line' | 'bar' = breakdown ? 'line' : requestedKind;
  const currentSeries = useMsChannelSeries(window.period, { channels: selected, breakdown: false });
  const previousSeries = useMsChannelSeries(comparisonPeriod ?? window.period, { channels: selected, breakdown: false });
  const valueOf = (data: typeof currentSeries.data) => data ? metricTotal(data.series, metric) : null;
  const format = (value: number) => metric === 'orders' ? fmt.num(value) : `${fmt.short(value)} ₽`;

  // A multi-series breakdown is line-only. Direct incompatible links become canonical before the
  // user can share them; rendering is already line-only on the first frame.
  useEffect(() => {
    if (breakdown && requestedKind === 'bar') controls.setEnum('chart', 'line');
  }, [breakdown, controls.setEnum, requestedKind]);
  // A valid selected ID can legitimately be absent from the current-period aggregate (zero sales)
  // or have become unavailable. Keep it explicit instead of silently broadening an empty filter to
  // "all channels"; the picker exposes the placeholder so the user can remove it deliberately.
  // Мультисерийные столбцы на 6×140 значений — нечитаемый частокол: в breakdown оставляем только
  // линии и прячем переключатель типа (как и в прежнем оверлее).
  const allowKind = !breakdown;
  return (
    <MsMetricShell
      back={BACK_CHANNELS}
      term="Каналы продаж"
      descriptor="Динамика по каналам продаж за выбранное окно"
      about={{
        formula:
          'Выручка / заказы / средний чек по каналу продаж заказа. Пустой фильтр — все каналы в агрегате; мультивыбор агрегирует выбранные; разбивка рисует до 6 каналов отдельными сериями.',
        source: 'Заказы МойСклада с salesChannel + дневной архив ms_daily.',
      }}
      comparison={
        <ComparisonReadout
          current={valueOf(currentSeries.data)}
          previous={comparisonPeriod ? valueOf(previousSeries.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={currentSeries.isPending || (comparisonPeriod != null && previousSeries.isPending)}
          error={currentSeries.isError || (comparisonPeriod != null && previousSeries.isError)}
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsChartCard
        id="ms-page-channels"
        title="По периодам"
        kind={allowKind ? kind : undefined}
        onKind={allowKind ? (value) => controls.setEnum('chart', value) : undefined}
        chart={
          <MsChannelChart
            period={window.period}
            metric={metric}
            breakdown={breakdown}
            selected={selected}
            options={selectableOptions}
            grain={grain}
            kind={allowKind ? kind : 'line'}
          />
        }
        controlBar={
          <ControlBar
            window={window}
            grain={grain}
            onGrain={(value) => controls.setEnum('grain', value)}
            extra={
              <MsChannelControls
                metric={metric}
                onMetric={(value) => controls.setEnum('metric', value)}
                view={view}
                onView={(value) => controls.setEnum('view', value)}
                options={selectableOptions}
                selected={selected}
                onSelected={controls.setChannels}
              />
            }
          />
        }
      />
    </MsMetricShell>
  );
}

// ── Report pages ──────────────────────────────────────────────────────────────────────────────

/** Каркас отчётной страницы: карточка с полным (развёрнутым) телом отчёта + окно под ним. */
function MsReportCard({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const chartH = useExplorerChartHeight();
  return (
    <ChartWidget id={id} title={title} defaultSize="full" noExpand action={action}>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartH}>{children}</ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </ChartWidget>
  );
}

function MsFunnelPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(FUNNEL_URL);
  const metric = controls.values.metric as 'orders' | 'revenue';
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const funnel = useMsFunnel(window.period);
  const previous = useMsFunnel(comparisonPeriod ?? window.period);
  const valueOf = (data: typeof funnel.data) => {
    if (!data) return null;
    return data.rows.reduce((sum, row) => sum + (metric === 'orders' ? row.orders : row.sum), 0)
      + (metric === 'orders' ? data.no_state_orders : data.no_state_sum);
  };
  const format = (value: number) => metric === 'orders' ? fmt.num(value) : `${fmt.short(value)} ₽`;
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term="Структура заказов по статусам"
      descriptor="Заказы, созданные в выбранном окне, по последнему сохранённому статусу"
      about={{
        formula: 'Заказы, созданные в выбранном окне, сгруппированы по последнему статусу, полученному при обновлении истории. Переключатель показывает число заказов или их выручку. Это не история переходов, не конверсия и не порядок этапов.',
        source: 'Заказы МойСклада (ms_orders, state_id).',
      }}
      comparison={
        <ComparisonReadout
          current={valueOf(funnel.data)}
          previous={comparisonPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={funnel.isPending || (comparisonPeriod != null && previous.isPending)}
          error={funnel.isError || (comparisonPeriod != null && previous.isError)}
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsReportCard
        id="ms-page-funnel"
        title="Все статусы"
        action={
          <SegmentedControl
            ariaLabel="Показатель распределения заказов по статусам"
            size="sm"
            value={metric}
            onChange={(value) => controls.setEnum('metric', value)}
            options={[
              { value: 'orders', content: 'Заказы' },
              { value: 'revenue', content: 'Выручка' },
            ]}
          />
        }
      >
        {funnel.isPending ? (
          <ListSkeleton rows={6} />
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
        ) : !funnel.data || funnel.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет заказов со статусами за период." />
        ) : (
          <MsFunnelRows
            rows={funnel.data.rows}
            totalOrders={funnel.data.total_orders}
            noState={funnel.data.no_state_orders}
            noStateSum={funnel.data.no_state_sum}
            metric={metric}
          />
        )}
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsProductsPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(PRODUCTS_URL);
  const view = controls.values.view as ExpandedView;
  const productSort = controls.values.sort as MsProductSort;
  const concentration = controls.values.concentration as ConcentrationMetric;
  const changeMetric = controls.values.change as ChangeMetric;
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term="Товары"
      descriptor="Концентрация, рейтинг и динамика ассортимента за окно"
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          Вкладка «Динамика» сравнивает выбранное окно с непосредственно предшествующим равным
          периодом. Для окна «Всё» сопоставимого предыдущего периода нет.
        </p>
      }
      about={{
        formula:
          'Концентрация — доля топ-N в положительной выручке или валовой прибыли (знаменатель по полному отчёту до limit). Рейтинг — сортировка по выручке / прибыли / марже. Динамика сравнивает окно с предыдущим равным по выручке / валовой прибыли / штукам.',
        included:
          'Маржа определена только при положительной выручке; убыточные позиции показаны отдельно. Динамика доказывает лишь наличие/отсутствие продаж в окнах; для «Всё» предыдущего равного окна нет. Возвраты не вычитаются.',
        source: 'Отчёт по товарам МойСклада (profit).',
      }}
    >
      <MsReportCard id="ms-page-products" title="Отчёт по товарам">
        <MsTopProductsCard
          period={window.period}
          view={view}
          onView={(value) => controls.setEnum('view', value)}
          productSort={productSort}
          onProductSort={(value) => controls.setEnum('sort', value)}
          concMetric={concentration}
          onConcMetric={(value) => controls.setEnum('concentration', value)}
          changeMetric={changeMetric}
          onChangeMetric={(value) => controls.setEnum('change', value)}
        />
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsStockPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(STOCK_URL);
  const sort = controls.values.sort as MsStockSort;
  // Окну остатков нужен конечный знаменатель скорости продаж — «Всё» недоступно. Прецедента
  // скрытия пилюли «Всё» в PeriodChips нет, поэтому канонный редирект: выбранное «Всё»
  // немедленно переводится в 30 дн; кадр до редиректа тело уже запрашивает конечным окном
  // (msStockPeriod внутри MsStockTable), так что 400 к серверу не уходит.
  useEffect(() => {
    if (window.days === 0 && !window.range) window.setDays(30);
  }, [window.days, window.range, window.setDays]);
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term="Остатки"
      descriptor="Что заканчивается: остатки склада и дни до нуля по скорости продаж окна"
      about={{
        formula:
          '«~Дней до нуля» = остаток ÷ средняя дневная скорость продаж выбранного окна (продано за окно ÷ дней в окне). Резерв из остатка не вычитается — показан отдельной колонкой.',
        included:
          'Товар без продаж за окно получает «нет продаж» — прогноз для него не определён. Окно «Всё» недоступно: скорости нужен конечный знаменатель, выбор переводится в 30 дн. Показаны первые 200 позиций по срочности.',
        source: 'Живой отчёт остатков МойСклада (stock/all) + отчёт продаж по товарам (profit).',
      }}
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          Остатки — живой снимок склада на сейчас; окно задаёт только скорость продаж, поэтому
          сравнение периодов не рассчитывается.
        </p>
      }
    >
      <MsReportCard
        id="ms-page-stock"
        title="Все позиции"
        action={
          <SegmentedControl
            ariaLabel="Сортировка остатков"
            size="sm"
            value={sort}
            onChange={(value) => controls.setEnum('sort', value)}
            options={STOCK_SORT_OPTIONS}
          />
        }
      >
        <MsStockTable period={window.period} sort={sort} />
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsReturnsPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(RETURNS_URL);
  const grain = controls.values.grain as Grain;
  const kind = controls.values.chart as 'line' | 'bar';
  const metric = controls.values.metric as MsReturnsMetric;
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const current = useMsReturns(window.period);
  const previous = useMsReturns(comparisonPeriod ?? window.period);
  const valueOf = (data: typeof current.data) => (data?.complete
    ? (metric === 'count' ? data.count : data.sum)
    : null);
  const format = (value: number) => fmtReturnsMetric(metric, value);
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term="Возвраты"
      descriptor="Возвраты МойСклада за выбранное окно"
      about={{
        formula: 'Число и сумма возвратов (salesreturn), созданных в выбранном окне, дневной серией из архива.',
        included: 'Возвраты считаются отдельно и из выручки/RFM заказов НЕ вычитаются.',
        source: 'Архив возвратов МойСклада (ms_returns).',
      }}
      comparison={
        <ComparisonReadout
          current={valueOf(current.data)}
          previous={comparisonPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={current.isPending || (comparisonPeriod != null && previous.isPending)}
          error={current.isError || (comparisonPeriod != null && previous.isError)}
          label={metric === 'count' ? 'Число возвратов' : 'Сумма возвратов'}
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsChartCard
        id="ms-page-returns"
        title="По периодам"
        kind={kind}
        onKind={(value) => controls.setEnum('chart', value)}
        chart={
          <MsReturnsExplorer
            metric={metric}
            period={window.period}
            comparisonPeriod={comparisonPeriod}
            grain={grain}
            kind={kind}
          />
        }
        controlBar={
          <ControlBar
            window={window}
            grain={grain}
            onGrain={(value) => controls.setEnum('grain', value)}
            extra={
              <SegmentedControl
                ariaLabel="Метрика возвратов"
                className="shrink-0"
                value={metric}
                onChange={(value) => controls.setEnum('metric', value)}
                options={RETURNS_METRIC_OPTIONS}
              />
            }
          />
        }
      />
    </MsMetricShell>
  );
}

function MsSalesChannelsPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(CONTRIBUTION_URL);
  const metric = controls.values.metric as MsChannelContributionMetric;
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const channels = useMsSalesByChannel(window.period);
  const previous = useMsSalesByChannel(comparisonPeriod ?? window.period);
  const totalOf = (data: typeof channels.data) => data
    ? data.rows.reduce((sum, row) => sum + (metric === 'revenue' ? row.sum : row.orders),
        metric === 'revenue' ? data.no_channel_sum : data.no_channel_orders)
    : null;
  const format = (value: number) => metric === 'revenue' ? `${fmt.short(value)} ₽` : fmt.num(value);
  return (
    <MsMetricShell
      back={BACK_CHANNELS}
      term="Продажи по каналам"
      descriptor="Доля каждого канала и его абсолютный вклад в изменение выручки или заказов"
      about={{
        formula:
          'Доля канала = его выручка или заказы ÷ общий результат окна, включая заказы без канала. Вклад в изменение — знаковая абсолютная разница канала против равного предыдущего окна; положительные и отрицательные изменения в сумме дают общее изменение.',
        included: 'Заказы без канала — отдельная синтетическая строка «Без канала», а не сноска. Для окна «Всё» предыдущего равного периода нет — изменение не рассчитывается.',
        source: 'Заказы МойСклада с salesChannel.',
      }}
      comparison={
        <ComparisonReadout
          current={totalOf(channels.data)}
          previous={comparisonPeriod ? totalOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={channels.isPending || (comparisonPeriod != null && previous.isPending)}
          error={channels.isError || (comparisonPeriod != null && previous.isError)}
          label={metric === 'revenue' ? 'Выручка каналов' : 'Заказы каналов'}
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsReportCard id="ms-page-sales-channels" title="Что изменило результат">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : channels.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить каналы продаж"
            reason={channels.error instanceof Error ? channels.error.message : 'ошибка'}
            onRetry={() => channels.refetch()}
            retrying={channels.isFetching}
          />
        ) : !channels.data || channels.data.total_orders === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <MsChannelContribution
            current={channels.data}
            previous={comparisonPeriod && !previous.isError ? (previous.data ?? null) : null}
            comparisonState={
              compare === 'off' ? 'disabled'
                : !window.previousPeriod ? 'unavailable'
                  : previous.isError ? 'error' : previous.isPending ? 'pending' : 'ready'
            }
            metric={metric}
            onMetric={(value) => controls.setEnum('metric', value)}
          />
        )}
      </MsReportCard>
      <MsReportCard id="ms-page-sales-channel-structure" title="Структура текущего периода">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : channels.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить каналы продаж"
            reason={channels.error instanceof Error ? channels.error.message : 'ошибка'}
            onRetry={() => channels.refetch()}
            retrying={channels.isFetching}
          />
        ) : !channels.data || channels.data.total_orders === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <MsChannelRows
            rows={channels.data.rows}
            totalOrders={channels.data.total_orders}
            noChannel={channels.data.no_channel_orders}
            noChannelSum={channels.data.no_channel_sum}
          />
        )}
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsGeographyPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(COMPARE_URL);
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const geo = useMsGeography(window.period);
  const previous = useMsGeography(comparisonPeriod ?? window.period);
  return (
    <MsMetricShell
      back={BACK_CHANNELS}
      term="География заказов"
      descriptor="Города доставки за выбранное окно"
      about={{
        formula: 'Города доставки по числу заказов и сумме; самовывоз / без города вынесен отдельно.',
        source: 'Адрес доставки заказов МойСклада (ms_orders).',
      }}
      comparison={
        <ComparisonReadout
          current={geo.data?.total_orders ?? null}
          previous={comparisonPeriod ? (previous.data?.total_orders ?? null) : null}
          format={fmt.num}
          previousPeriod={window.previousPeriod}
          pending={geo.isPending || (comparisonPeriod != null && previous.isPending)}
          error={geo.isError || (comparisonPeriod != null && previous.isError)}
          label="Заказы с географией"
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsReportCard id="ms-page-geography" title="Все города">
        {geo.isPending ? (
          <ListSkeleton rows={6} />
        ) : geo.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
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
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsTopCustomersPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(COMPARE_URL);
  const compare = controls.values.compare as 'off' | 'prev';
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const topCustomers = useMsTopCustomers(window.period);
  const previous = useMsTopCustomers(comparisonPeriod ?? window.period);
  const sumOf = (data: typeof topCustomers.data) => data ? data.rows.reduce((sum, row) => sum + row.sum, 0) : null;
  return (
    <MsMetricShell
      back={BACK_CLIENTS}
      term="Топ покупателей"
      descriptor="Контрагенты окна по сумме заказов"
      about={{
        formula: 'Контрагенты окна по сумме заказов; имена резолвит справочник counterparty по id.',
        included: 'Удалённый / безымянный контрагент показывается заглушкой, а не выпадает из топа.',
        source: 'Архив заказов МойСклада (ms_orders) + справочник counterparty.',
      }}
      comparison={
        <ComparisonReadout
          current={sumOf(topCustomers.data)}
          previous={comparisonPeriod ? sumOf(previous.data) : null}
          format={(value) => `${fmt.short(value)} ₽`}
          previousPeriod={window.previousPeriod}
          pending={topCustomers.isPending || (comparisonPeriod != null && previous.isPending)}
          error={topCustomers.isError || (comparisonPeriod != null && previous.isError)}
          label="Сумма показанного топа"
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsReportCard id="ms-page-top-customers" title="Топ покупателей">
        <MsTopCustomersBody state={topCustomers} />
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsRfmPage() {
  const window = useMsMetricWindow();
  const controls = useMsMetricUrlControls(RFM_URL);
  const compare = controls.values.compare as 'off' | 'prev';
  // Выбранный сегмент живёт в URL (?segment=at_risk) — ссылка на провал шарится и переживает reload.
  const segmentParam = controls.values.segment as RfmSegmentKey | 'none';
  const selectedSegment = segmentParam === 'none' ? null : segmentParam;
  const comparisonPeriod = compare === 'prev' ? window.previousPeriod : null;
  const rfm = useMsRfm(window.period);
  const previous = useMsRfm(comparisonPeriod ?? window.period);
  return (
    <MsMetricShell
      back={BACK_CLIENTS}
      term="RFM-сегменты"
      descriptor="Относительная ценность и активность покупателей выбранного окна"
      about={{
        formula:
          'R — календарные дни от последнего заказа до конца окна; F — число заказов; M — сумма заказов. Для каждой величины покупатели получают относительный score 1–5 по mid-rank: одинаковые значения всегда получают одинаковую оценку, а полностью одинаковая выборка — нейтральную 3.',
        included:
          'Только контрагенты с заказом в выбранном окне. Заказы без контрагента показаны отдельно. Возвраты не вычитаются: их архив и семантика выпускаются отдельной метрикой.',
        source: 'Архив заказов МойСклада (ms_orders); расчёт на точную дату конца выбранного окна.',
      }}
      comparison={
        <ComparisonReadout
          current={rfm.data?.customers ?? null}
          previous={comparisonPeriod ? (previous.data?.customers ?? null) : null}
          format={(value) => `${fmt.num(value)} ${value === 1 ? 'покупатель' : 'покупателей'}`}
          previousPeriod={window.previousPeriod}
          pending={rfm.isPending || (comparisonPeriod != null && previous.isPending)}
          error={rfm.isError || (comparisonPeriod != null && previous.isError)}
          label="Покупатели в RFM"
          mode={compare}
          onMode={(value) => controls.setEnum('compare', value)}
        />
      }
    >
      <MsReportCard id="ms-page-rfm" title="Сегменты покупателей">
        <MsRfmBody
          state={rfm}
          detailed
          selectedSegment={selectedSegment}
          onSelectSegment={(key) => controls.setEnum('segment', key === selectedSegment ? 'none' : key)}
        />
      </MsReportCard>
      {selectedSegment != null && (
        <MsReportCard id="ms-page-rfm-customers" title={`Покупатели · ${RFM_SEGMENTS[selectedSegment].label}`}>
          <MsRfmSegmentCustomers period={window.period} segment={selectedSegment} />
        </MsReportCard>
      )}
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

// Заголовок/описание карточки под выбранный режим — deals честно называет monthly-выручку/клиента
// и кумулятивный LTV, ничего не именуя «прибылью».
const COHORT_MODE_META: Record<MsCohortMode, { title: string; formula: string }> = {
  retention: {
    title: 'Возвращаемость',
    formula:
      'Доля клиентов когорты (по месяцу первой покупки), сделавших заказ через N месяцев после неё; «0» — месяц самой первой покупки.',
  },
  revenue: {
    title: 'Выручка на клиента',
    formula:
      'Выручка заказов N-го месяца, делённая на ИСХОДНЫЙ размер когорты (не на активных) — помесячно, в рублях. Это не среднее и не прибыль; возвраты не вычитаются.',
  },
  ltv: {
    title: 'LTV на клиента',
    formula:
      'Накопленная выручка с 0-го по N-й месяц, делённая на ИСХОДНЫЙ размер когорты — LTV в рублях. Не прибыль; возвраты не вычитаются.',
  },
};

function MsCohortsPage() {
  const cohorts = useMsCohorts();
  const controls = useMsMetricUrlControls(COHORTS_URL);
  const mode = controls.values.mode as MsCohortMode;
  const meta = COHORT_MODE_META[mode];
  return (
    <MsMetricShell
      back={BACK_CLIENTS}
      term="Когорты"
      descriptor="Возвращаемость и монетизация по месяцу первой покупки"
      about={{
        formula: meta.formula,
        included:
          'Все режимы нормированы на исходный размер когорты, поэтому когорты разного размера сравнимы. Будущие месяцы когорты — пустые (данных ещё нет), а не ноль.',
        source: 'Архив заказов МойСклада (ms_orders); суммы в рублях, возвраты не вычитаются.',
      }}
    >
      <MsReportCard
        id="ms-page-cohorts"
        title={meta.title}
        action={
          <SegmentedControl
            ariaLabel="Режим когортной матрицы"
            size="sm"
            value={mode}
            onChange={(value) => controls.setEnum('mode', value)}
            options={[
              { value: 'retention', content: 'Возвращаемость' },
              { value: 'revenue', content: 'Выручка/клиент' },
              { value: 'ltv', content: 'LTV' },
            ]}
          />
        }
      >
        {cohorts.isPending ? (
          <ListSkeleton rows={6} />
        ) : cohorts.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить когорты"
            reason={cohorts.error instanceof Error ? cohorts.error.message : 'ошибка'}
            onRetry={() => cohorts.refetch()}
            retrying={cohorts.isFetching}
          />
        ) : !cohorts.data || cohorts.data.cohorts.length === 0 ? (
          <EmptyState
            compact
            size="table"
            title="Когорт пока нет"
            reason="Они появятся после загрузки истории заказов."
          />
        ) : (
          <MsCohortsTable cohorts={cohorts.data.cohorts} mode={mode} />
        )}
      </MsReportCard>
    </MsMetricShell>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return <TableSkeleton rows={rows} columns={4} className="py-2" />;
}
