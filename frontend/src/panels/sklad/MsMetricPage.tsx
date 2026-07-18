import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartSection as RailSection } from '@/components/instagram/shared';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { PeriodChips } from '@/components/PeriodChips';
import { SourceIdentity } from '@/components/SourceIdentity';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { usePeriod, type DateRange, type PeriodDays } from '@/lib/period';
import { msPreviousPeriod, useMsResolvedPeriod, type MsPeriod } from '@/lib/msPeriod';
import { metricTotal, type Grain, type Metric } from '@/lib/msSeries';
import { customerMetricTotal, type MsCustomerMetric } from '@/lib/msCustomerSeries';
import {
  useMsChannelSeries,
  useMsCustomers,
  useMsFunnel,
  useMsGeography,
  useMsReturns,
  useMsSalesByChannel,
  useMsSummary,
  useMsTopCustomers,
  useMsCohorts,
} from '@/api/queries';
import { MsSummaryExplorer, MsFunnelRows } from '@/panels/sklad/MsOverview';
import {
  MsCustomerExplorer,
  MsCohortsTable,
  MsTopCustomersBody,
  CUSTOMER_METRIC_OPTIONS,
} from '@/panels/sklad/MsClients';
import {
  MsChannelChart,
  MsChannelControls,
  MsChannelRows,
  MsGeographyRows,
  type View,
  type ChannelOption,
} from '@/panels/sklad/MsChannels';
import { MsTopProductsCard } from '@/panels/sklad/MsTopProducts';
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
    default:
      return null;
  }
}

/** Re-export guard so the route dispatcher can gate `ms-*` keys without importing the page eagerly. */
export { isMsMetricKey };

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
}: {
  current: number | null;
  previous: number | null;
  format: (value: number) => string;
  previousPeriod: MsPeriod | null;
  pending?: boolean;
  error?: boolean;
  label?: string;
}) {
  const [mode, setMode] = useState<'off' | 'prev'>('prev');
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
        onChange={setMode}
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
  const [grain, setGrain] = useState<Grain>('day');
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const current = useMsSummary(window.period);
  const previous = useMsSummary(window.previousPeriod ?? window.period);
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
          previous={window.previousPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={current.isPending || (window.previousPeriod != null && previous.isPending)}
          error={current.isError || (window.previousPeriod != null && previous.isError)}
        />
      }
    >
      <MsChartCard
        id={`ms-page-${metric}`}
        title="По периодам"
        kind={kind}
        onKind={setKind}
        chart={
          <MsSummaryExplorer
            metric={metric}
            period={window.period}
            comparisonPeriod={window.previousPeriod}
            grain={grain}
            kind={kind}
          />
        }
        controlBar={<ControlBar window={window} grain={grain} onGrain={setGrain} />}
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
  const [grain, setGrain] = useState<Grain>('day');
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [metric, setMetric] = useState<MsCustomerMetric>(defaultMetric);
  const current = useMsCustomers(window.period);
  const previous = useMsCustomers(window.previousPeriod ?? window.period);
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
          previous={window.previousPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={current.isPending || (window.previousPeriod != null && previous.isPending)}
          error={current.isError || (window.previousPeriod != null && previous.isError)}
        />
      }
    >
      <MsChartCard
        id="ms-page-customers"
        title="По периодам"
        kind={kind}
        onKind={setKind}
        chart={<MsCustomerExplorer metric={metric} period={window.period} grain={grain} kind={kind} />}
        controlBar={
          <ControlBar
            window={window}
            grain={grain}
            onGrain={setGrain}
            extra={
              <SegmentedControl
                ariaLabel="Метрика покупателей"
                className="shrink-0"
                value={metric}
                onChange={setMetric}
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
  const [grain, setGrain] = useState<Grain>('day');
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [metric, setMetric] = useState<Metric>('revenue');
  const [view, setView] = useState<View>('aggregate');
  const [selected, setSelected] = useState<string[]>([]);
  const channels = useMsSalesByChannel(window.period);
  const options: ChannelOption[] = (channels.data?.rows ?? []).map((r) => ({
    id: r.sales_channel_id,
    name: r.name ?? 'Канал без имени',
  }));
  const breakdown = view === 'breakdown';
  const currentSeries = useMsChannelSeries(window.period, { channels: selected, breakdown: false });
  const previousSeries = useMsChannelSeries(window.previousPeriod ?? window.period, { channels: selected, breakdown: false });
  const valueOf = (data: typeof currentSeries.data) => data ? metricTotal(data.series, metric) : null;
  const format = (value: number) => metric === 'orders' ? fmt.num(value) : `${fmt.short(value)} ₽`;
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
          previous={window.previousPeriod ? valueOf(previousSeries.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={currentSeries.isPending || (window.previousPeriod != null && previousSeries.isPending)}
          error={currentSeries.isError || (window.previousPeriod != null && previousSeries.isError)}
        />
      }
    >
      <MsChartCard
        id="ms-page-channels"
        title="По периодам"
        kind={allowKind ? kind : undefined}
        onKind={allowKind ? setKind : undefined}
        chart={
          <MsChannelChart
            period={window.period}
            metric={metric}
            breakdown={breakdown}
            selected={selected}
            options={options}
            grain={grain}
            kind={allowKind ? kind : 'line'}
          />
        }
        controlBar={
          <ControlBar
            window={window}
            grain={grain}
            onGrain={setGrain}
            extra={
              <MsChannelControls
                metric={metric}
                onMetric={setMetric}
                view={view}
                onView={setView}
                options={options}
                selected={selected}
                onSelected={setSelected}
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
  const [metric, setMetric] = useState<'orders' | 'revenue'>('orders');
  const funnel = useMsFunnel(window.period);
  const previous = useMsFunnel(window.previousPeriod ?? window.period);
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
          previous={window.previousPeriod ? valueOf(previous.data) : null}
          format={format}
          previousPeriod={window.previousPeriod}
          pending={funnel.isPending || (window.previousPeriod != null && previous.isPending)}
          error={funnel.isError || (window.previousPeriod != null && previous.isError)}
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
            onChange={setMetric}
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
            className="py-4"
            title="Не удалось получить статусы заказов"
            reason={funnel.error instanceof Error ? funnel.error.message : 'ошибка'}
            onRetry={() => funnel.refetch()}
            retrying={funnel.isFetching}
          />
        ) : !funnel.data || funnel.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет заказов со статусами за период.</p>
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
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term="Товары"
      descriptor="Концентрация и рейтинг ассортимента за окно"
      about={{
        formula:
          'Концентрация — доля топ-N в положительной выручке или валовой прибыли (знаменатель по полному отчёту до limit). Рейтинг — сортировка по выручке / прибыли / марже.',
        included: 'Маржа определена только при положительной выручке; убыточные позиции показаны отдельно.',
        source: 'Отчёт по товарам МойСклада (profit).',
      }}
    >
      <MsReportCard id="ms-page-products" title="Отчёт по товарам">
        <MsTopProductsCard period={window.period} />
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsReturnsPage() {
  const window = useMsMetricWindow();
  const returns = useMsReturns(window.period);
  const previous = useMsReturns(window.previousPeriod ?? window.period);
  const windowLabel = window.range
    ? `${fmt.day(window.range.from)} – ${fmt.day(window.range.to)}`
    : window.days === 0 ? 'за всё время' : `за ${window.days} дн.`;
  return (
    <MsMetricShell
      back={BACK_OVERVIEW}
      term="Возвраты"
      descriptor="Возвраты МойСклада за выбранное окно"
      about={{
        formula: 'Число и сумма возвратов (salesreturn) за окно.',
        included: 'Возвраты считаются отдельно и из выручки не вычитаются.',
        source: 'Документы возвратов МойСклада (salesreturn).',
      }}
      comparison={
        <ComparisonReadout
          current={returns.data?.sum ?? null}
          previous={window.previousPeriod ? (previous.data?.sum ?? null) : null}
          format={(value) => `${fmt.short(value)} ₽`}
          previousPeriod={window.previousPeriod}
          pending={returns.isPending || (window.previousPeriod != null && previous.isPending)}
          error={returns.isError || (window.previousPeriod != null && previous.isError)}
          label="Сумма возвратов"
        />
      }
    >
      <MsReportCard id="ms-page-returns" title="Возвраты">
        {returns.isPending ? (
          <ListSkeleton rows={2} />
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
          <ChartCardBody value={fmt.num(returns.data.count)} caption={`на ${fmt.short(returns.data.sum)} ₽ ${windowLabel}`}>
            <div className="space-y-1.5 text-2xs text-muted-foreground">
              {returns.data.truncated && <p>Показано не менее — возвратов за период больше лимита выборки.</p>}
              <p>Возвраты считаются отдельно и из выручки не вычитаются.</p>
            </div>
          </ChartCardBody>
        )}
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsSalesChannelsPage() {
  const window = useMsMetricWindow();
  const channels = useMsSalesByChannel(window.period);
  const previous = useMsSalesByChannel(window.previousPeriod ?? window.period);
  const revenueOf = (data: typeof channels.data) => data ? data.rows.reduce((sum, row) => sum + row.sum, 0) : null;
  return (
    <MsMetricShell
      back={BACK_CHANNELS}
      term="Продажи по каналам"
      descriptor="Каналы продаж с долей выручки и средним чеком за окно"
      about={{
        formula: 'Каналы продаж с долей выручки, числом заказов и средним чеком; сортировка по выручке / заказам / чеку / имени.',
        source: 'Заказы МойСклада с salesChannel.',
      }}
      comparison={
        <ComparisonReadout
          current={revenueOf(channels.data)}
          previous={window.previousPeriod ? revenueOf(previous.data) : null}
          format={(value) => `${fmt.short(value)} ₽`}
          previousPeriod={window.previousPeriod}
          pending={channels.isPending || (window.previousPeriod != null && previous.isPending)}
          error={channels.isError || (window.previousPeriod != null && previous.isError)}
          label="Выручка каналов"
        />
      }
    >
      <MsReportCard id="ms-page-sales-channels" title="Все каналы">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : channels.isError ? (
          <ErrorState
            className="py-4"
            title="Не удалось получить каналы продаж"
            reason={channels.error instanceof Error ? channels.error.message : 'ошибка'}
            onRetry={() => channels.refetch()}
            retrying={channels.isFetching}
          />
        ) : !channels.data || channels.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsChannelRows
            rows={channels.data.rows}
            totalOrders={channels.data.total_orders}
            noChannel={channels.data.no_channel_orders}
          />
        )}
      </MsReportCard>
      <ControlBar window={window} />
    </MsMetricShell>
  );
}

function MsGeographyPage() {
  const window = useMsMetricWindow();
  const geo = useMsGeography(window.period);
  const previous = useMsGeography(window.previousPeriod ?? window.period);
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
          previous={window.previousPeriod ? (previous.data?.total_orders ?? null) : null}
          format={fmt.num}
          previousPeriod={window.previousPeriod}
          pending={geo.isPending || (window.previousPeriod != null && previous.isPending)}
          error={geo.isError || (window.previousPeriod != null && previous.isError)}
          label="Заказы с географией"
        />
      }
    >
      <MsReportCard id="ms-page-geography" title="Все города">
        {geo.isPending ? (
          <ListSkeleton rows={6} />
        ) : geo.isError ? (
          <ErrorState
            className="py-4"
            title="Не удалось получить географию заказов"
            reason={geo.error instanceof Error ? geo.error.message : 'ошибка'}
            onRetry={() => geo.refetch()}
            retrying={geo.isFetching}
          />
        ) : !geo.data || geo.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет городов доставки за период.</p>
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
  const topCustomers = useMsTopCustomers(window.period);
  const previous = useMsTopCustomers(window.previousPeriod ?? window.period);
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
          previous={window.previousPeriod ? sumOf(previous.data) : null}
          format={(value) => `${fmt.short(value)} ₽`}
          previousPeriod={window.previousPeriod}
          pending={topCustomers.isPending || (window.previousPeriod != null && previous.isPending)}
          error={topCustomers.isError || (window.previousPeriod != null && previous.isError)}
          label="Сумма показанного топа"
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

function MsCohortsPage() {
  const cohorts = useMsCohorts();
  return (
    <MsMetricShell
      back={BACK_CLIENTS}
      term="Когорты"
      descriptor="Возвращаемость по месяцу первой покупки"
      about={{
        formula:
          'Доля клиентов когорты (по месяцу первой покупки), сделавших заказ через N месяцев после неё; «0» — месяц самой первой покупки.',
        included: 'Будущие месяцы когорты — пустые (данных ещё нет), а не ноль.',
        source: 'Архив заказов МойСклада (ms_orders).',
      }}
    >
      <MsReportCard id="ms-page-cohorts" title="Таблица когорт">
        {cohorts.isPending ? (
          <ListSkeleton rows={6} />
        ) : cohorts.isError ? (
          <ErrorState
            className="py-4"
            title="Не удалось получить когорты"
            reason={cohorts.error instanceof Error ? cohorts.error.message : 'ошибка'}
            onRetry={() => cohorts.refetch()}
            retrying={cohorts.isFetching}
          />
        ) : !cohorts.data || cohorts.data.cohorts.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Когорт пока нет — они появятся после загрузки истории заказов.</p>
        ) : (
          <MsCohortsTable cohorts={cohorts.data.cohorts} />
        )}
      </MsReportCard>
    </MsMetricShell>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}
