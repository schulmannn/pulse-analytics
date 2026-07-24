import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useCampaignSummary } from '@/api/queries';
import type { Campaign, CampaignSummary } from '@/api/schemas';
import { BarChart } from '@/components/BarChart';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import {
  ChartExpandedContext,
  ExpandedChartHeightContext,
} from '@/components/ExpandableChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LineChart } from '@/components/LineChart';
import { PieChart } from '@/components/PieChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import {
  CampaignColorDot,
  CampaignStatusChip,
  NetworkBadge,
} from '@/components/campaigns/shared';
import { ChartSection as RailSection } from '@/components/instagram/shared';
import { Skeleton } from '@/components/ui/skeleton';
import {
  comparisonText,
  comparisonUnavailableText,
  formatSlices,
  timelineSeries,
} from '@/lib/campaignSummary';
import {
  applyTimelineMode,
  resolveTimelineMode,
  sourceLeaderboard,
  timelineModes,
  type TimelineMode,
} from '@/lib/campaignPageModel';
import {
  campaignSourceKey,
  campaignSourceOptions,
  parseCampaignSourceKey,
  type CampaignSourceScope,
} from '@/lib/campaignSources';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { CampaignSourceLeaderboard } from '@/panels/campaign/CampaignSourceLeaderboard';
import {
  campaignBackPath,
  isCampaignMetricKey,
} from '@/panels/campaign/campaignMetricKeys';

type ChartKind = 'line' | 'bar';

interface AboutDef {
  formula: string;
  included: string;
  source: string;
}

/**
 * Dedicated visual explorers for `/campaigns/:id`. They intentionally reuse the campaign summary
 * endpoint and pure page derivations, so a card and its full-screen route cannot disagree.
 */
export function CampaignMetricPage() {
  const route = useParams<{ id: string; metricKey: string }>();
  const id = /^\d+$/.test(route.id ?? '') ? Number(route.id) : null;
  const metricKey = isCampaignMetricKey(route.metricKey) ? route.metricKey : null;
  const [searchParams, setSearchParams] = useSearchParams();
  const baseSummaryQ = useCampaignSummary(id);
  const baseSummary = baseSummaryQ.data?.summary;
  const rawSource = searchParams.get('source');
  const requestedSource = useMemo(() => parseCampaignSourceKey(rawSource), [rawSource]);
  const sourceOptions = useMemo(
    () => campaignSourceOptions(baseSummary?.by_source ?? []),
    [baseSummary?.by_source],
  );
  const selectedSource =
    requestedSource &&
    sourceOptions.some((option) => option.key === campaignSourceKey(requestedSource))
      ? requestedSource
      : null;
  const scopedSummaryQ = useCampaignSummary(
    id,
    selectedSource,
    baseSummary != null && selectedSource != null,
  );
  const summary = selectedSource ? scopedSummaryQ.data?.summary : baseSummary;
  const campaign = baseSummary?.campaign ?? summary?.campaign ?? null;

  useEffect(() => {
    if (!baseSummary || !rawSource || selectedSource) return;
    const next = new URLSearchParams(searchParams);
    next.delete('source');
    setSearchParams(next, { replace: true });
  }, [baseSummary, rawSource, searchParams, selectedSource, setSearchParams]);

  if (id == null || metricKey == null) {
    return (
      <EmptyState
        title="График кампании не найден"
        action={{ to: '/posts?view=campaigns', label: 'К списку кампаний' }}
      />
    );
  }
  if (baseSummaryQ.isPending || (selectedSource && scopedSummaryQ.isPending)) {
    return <CampaignMetricSkeleton />;
  }
  const error = baseSummaryQ.isError
    ? baseSummaryQ.error
    : selectedSource && scopedSummaryQ.isError
      ? scopedSummaryQ.error
      : null;
  if (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <ErrorState
        title={notFound ? 'Кампания не найдена' : 'Не удалось загрузить график кампании'}
        reason={
          notFound
            ? 'Она могла быть удалена, или у вас нет к ней доступа.'
            : error instanceof Error
              ? error.message
              : 'ошибка сервера'
        }
        onRetry={() => {
          void baseSummaryQ.refetch();
          if (selectedSource) void scopedSummaryQ.refetch();
        }}
        retrying={baseSummaryQ.isFetching || scopedSummaryQ.isFetching}
      />
    );
  }
  if (!summary || !campaign) {
    return (
      <EmptyState
        title="Кампания не найдена"
        action={{ to: '/posts?view=campaigns', label: 'К списку кампаний' }}
      />
    );
  }

  const backTo = campaignBackPath(id, searchParams);
  if (metricKey === 'timeline') {
    return (
      <CampaignTimelineMetric
        campaign={campaign}
        summary={summary}
        source={selectedSource}
        backTo={backTo}
        searchParams={searchParams}
        setSearchParams={setSearchParams}
      />
    );
  }
  if (metricKey === 'sources') {
    return (
      <CampaignSourcesMetric
        campaign={campaign}
        summary={summary}
        source={selectedSource}
        backTo={backTo}
      />
    );
  }
  return (
    <CampaignFormatsMetric
      campaign={campaign}
      summary={summary}
      source={selectedSource}
      backTo={backTo}
    />
  );
}

function CampaignMetricShell({
  campaign,
  summary,
  backTo,
  term,
  descriptor,
  about,
  comparison,
  children,
}: {
  campaign: Campaign;
  summary: CampaignSummary;
  backTo: string;
  term: string;
  descriptor: string;
  about: AboutDef;
  comparison: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Link
        to={backTo}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> {campaign.name}
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          {campaign.color ? <CampaignColorDot color={campaign.color} className="size-3" /> : null}
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
          <CampaignStatusChip status={campaign.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {(summary.tg?.posts ?? 0) > 0 && <NetworkBadge network="tg" />}
          {(summary.ig?.posts ?? 0) > 0 && <NetworkBadge network="ig" />}
          <span className="text-2xs text-muted-foreground">{campaign.name}</span>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">{descriptor}</div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:gap-8">
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="space-y-6">
          <RailSection title="Сравнение">{comparison}</RailSection>
          <RailSection title="О графике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={about.formula} />
              <AboutRow label="Что учитывается" text={about.included} />
              <AboutRow label="Источник" text={about.source} />
            </dl>
          </RailSection>
          <Link
            to={backTo}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть кампанию <span aria-hidden="true">→</span>
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

function CampaignReportCard({
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
  const chartHeight = useExplorerChartHeight();
  return (
    <ChartWidget id={id} title={title} defaultSize="full" noExpand action={action}>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartHeight}>
          {children}
        </ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </ChartWidget>
  );
}

function sourceDescriptor(source: CampaignSourceScope | null): string {
  if (!source) return 'Все источники кампании';
  return `${source.network === 'tg' ? 'Telegram' : 'Instagram'} · источник #${source.channelId}`;
}

function CampaignTimelineMetric({
  campaign,
  summary,
  source,
  backTo,
  searchParams,
  setSearchParams,
}: {
  campaign: Campaign;
  summary: CampaignSummary;
  source: CampaignSourceScope | null;
  backTo: string;
  searchParams: URLSearchParams;
  setSearchParams: ReturnType<typeof useSearchParams>[1];
}) {
  const series = useMemo(() => timelineSeries(summary.timeline), [summary.timeline]);
  const modes = useMemo(() => timelineModes(series), [series]);
  const rawMode = searchParams.get('metric');
  const activeKey = resolveTimelineMode(rawMode, modes);
  const active = modes.find((mode) => mode.key === activeKey) ?? null;
  const rawChart = searchParams.get('chart');
  const kind: ChartKind =
    rawChart === 'line' || rawChart === 'bar' ? rawChart : active?.kind ?? 'line';
  const cmp = comparisonText(summary);
  const cmpMissing = comparisonUnavailableText(summary);

  useEffect(() => {
    if (!rawMode || rawMode === activeKey) return;
    setSearchParams(applyTimelineMode(searchParams, activeKey, modes[0]?.key ?? null), {
      replace: true,
    });
  }, [activeKey, modes, rawMode, searchParams, setSearchParams]);

  const selectMode = (mode: TimelineMode) => {
    setSearchParams(applyTimelineMode(searchParams, mode, modes[0]?.key ?? null), {
      replace: true,
    });
  };
  const selectKind = (nextKind: ChartKind) => {
    const next = new URLSearchParams(searchParams);
    if (nextKind === active?.kind) next.delete('chart');
    else next.set('chart', nextKind);
    setSearchParams(next, { replace: true });
  };

  return (
    <CampaignMetricShell
      campaign={campaign}
      summary={summary}
      backTo={backTo}
      term={active?.title ?? 'Динамика кампании'}
      descriptor={`${sourceDescriptor(source)} · значения сгруппированы по дате публикации`}
      about={{
        formula:
          'Публикации группируются по календарной дате. В режиме TG суммируются просмотры Telegram, в режиме IG — охваты публикаций Instagram без дедупликации аудитории, в режиме публикаций — число материалов.',
        included:
          'TG-просмотры и IG-охват никогда не складываются в одну серию: это разные методологии. Переключатель показателя заменяет ряд целиком.',
        source: 'Серверная сводка публикаций, добавленных в кампанию.',
      }}
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          {cmp
            ? `${cmp}. Это сравнение среднего TG-поста; дневной ряд прошлого окна API не возвращает, поэтому baseline на графике не рисуется.`
            : cmpMissing}
        </p>
      }
    >
      <CampaignReportCard
        id="campaign-page-timeline"
        title={active?.title ?? 'Динамика кампании'}
        action={
          active ? (
            <SegmentedControl
              ariaLabel="Тип графика"
              className="shrink-0"
              value={kind}
              onChange={selectKind}
              options={[
                { value: 'line', content: 'Линия', ariaLabel: 'Тип графика: Линия' },
                { value: 'bar', content: 'Столбцы', ariaLabel: 'Тип графика: Столбцы' },
              ]}
            />
          ) : undefined
        }
      >
        {!active ? (
          <EmptyState compact size="chart" title="Нет данных для графика динамики." />
        ) : kind === 'line' ? (
          <LineChart
            values={active.values}
            labels={active.labels}
            titles={active.titles}
            yMin={0}
            showPoints
            fullAxes
            markAnomalies
            markExtremes
          />
        ) : (
          <BarChart values={active.values} labels={active.labels} titles={active.titles} />
        )}
      </CampaignReportCard>
      {modes.length > 1 && active && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
          <span className="text-xs font-medium text-muted-foreground">Показатель</span>
          <span className="flex-1" />
          <SegmentedControl
            ariaLabel="Показатель"
            value={active.key}
            onChange={selectMode}
            options={modes.map((mode) => ({ value: mode.key, content: mode.label }))}
          />
        </div>
      )}
    </CampaignMetricShell>
  );
}

function CampaignSourcesMetric({
  campaign,
  summary,
  source,
  backTo,
}: {
  campaign: Campaign;
  summary: CampaignSummary;
  source: CampaignSourceScope | null;
  backTo: string;
}) {
  const leaders = useMemo(() => sourceLeaderboard(summary.by_source), [summary.by_source]);
  return (
    <CampaignMetricShell
      campaign={campaign}
      summary={summary}
      backTo={backTo}
      term="Источники кампании"
      descriptor={`${sourceDescriptor(source)} · вклад считается только внутри методологии своей платформы`}
      about={{
        formula:
          'Источники упорядочены по числу публикаций. Полоса показывает долю результата источника внутри своей платформы: TG — просмотры, IG — сумма охватов.',
        included:
          'Доли Telegram и Instagram нормируются раздельно и не сравниваются между собой. Число публикаций остаётся единственной общей величиной.',
        source: 'Серверная разбивка кампании по источникам.',
      }}
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          Это распределение источников внутри кампании, а не одна метрика периода — сравнение с
          прошлым окном не рассчитывается.
        </p>
      }
    >
      <CampaignReportCard id="campaign-page-sources" title="Все источники">
        <CampaignSourceLeaderboard leaders={leaders} />
      </CampaignReportCard>
    </CampaignMetricShell>
  );
}

function CampaignFormatsMetric({
  campaign,
  summary,
  source,
  backTo,
}: {
  campaign: Campaign;
  summary: CampaignSummary;
  source: CampaignSourceScope | null;
  backTo: string;
}) {
  const slices = useMemo(() => formatSlices(summary.by_format), [summary.by_format]);
  return (
    <CampaignMetricShell
      campaign={campaign}
      summary={summary}
      backTo={backTo}
      term="Форматы кампании"
      descriptor={`${sourceDescriptor(source)} · распределение публикаций по платформе и типу контента`}
      about={{
        formula:
          'Каждый сектор — число публикаций одного формата внутри платформы. TG и IG разделены в подписях, а размер сектора использует сопоставимое число материалов.',
        included:
          'В подсказке дополнительно показана собственная метрика платформы: просмотры TG или сумма охватов IG. Они не складываются между сетями.',
        source: 'Серверная разбивка кампании по форматам публикаций.',
      }}
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          Это состав кампании по форматам, а не временной ряд — сравнение периодов и переключатель
          Line/Bar здесь были бы ложными.
        </p>
      }
    >
      <CampaignReportCard id="campaign-page-formats" title="По числу публикаций">
        {slices.values.length > 0 ? (
          <PieChart values={slices.values} labels={slices.labels} titles={slices.titles} />
        ) : (
          <EmptyState compact size="chart" title="Нет данных о форматах." />
        )}
      </CampaignReportCard>
    </CampaignMetricShell>
  );
}

function CampaignMetricSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-3 w-28" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-3 w-48" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:gap-8">
        <Skeleton className="h-[420px] w-full" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
