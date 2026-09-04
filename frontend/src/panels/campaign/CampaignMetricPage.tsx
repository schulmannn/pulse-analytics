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
import { RadialShare } from '@/components/RadialShare';
import { SegmentedControl } from '@/components/SegmentedControl';
import { CAMPAIGNS_LIST } from '@/components/campaigns/routes';
import {
  CampaignColorDot,
  CampaignStatusChip,
  NetworkBadge,
} from '@/components/campaigns/shared';

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
  capTimelineMode,
  timelineModes,
  type TimelineMode,
} from '@/lib/campaignPageModel';
import {
  campaignSourceKey,
  campaignSourceOptions,
  parseCampaignSourceKey,
  type CampaignSourceScope,
} from '@/lib/campaignSources';
import { timeAxisFromDayKeys } from '@/lib/format';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { CampaignSourceLeaderboard } from '@/panels/campaign/CampaignSourceLeaderboard';
import {
  campaignBackPath,
  isCampaignMetricKey,
} from '@/panels/campaign/campaignMetricKeys';
import { MetricColumns, MetricDescriptor, WindowBarShell, RailSection, MetricPageHeader} from '@/components/metric/shared';

type ChartKind = 'line' | 'bar';


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
        action={{ to: CAMPAIGNS_LIST, label: 'К списку кампаний' }}
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
        action={{ to: CAMPAIGNS_LIST, label: 'К списку кампаний' }}
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
  comparison,
  children,
}: {
  campaign: Campaign;
  summary: CampaignSummary;
  backTo: string;
  term: string;
  descriptor: string;
  comparison: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <MetricPageHeader back={{ to: backTo, label: campaign.name }} />

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
        <MetricDescriptor>{descriptor}</MetricDescriptor>
      </div>

      <MetricColumns
        rail={
          <>
            <RailSection title="Сравнение">{comparison}</RailSection>
            {/* «О графике» убран — техническая информация не для конечного пользователя (владелец). */}
            <Link
              to={backTo}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            >
              Открыть кампанию <span aria-hidden="true">→</span>
            </Link>
          </>
        }
      >
        {children}
      </MetricColumns>
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
        {/* Кап длинной серии перед рендером (canon CLAUDE.md): линия — LTTB, столбцы — недели. */}
        {!active ? (
          <EmptyState compact size="chart" title="Нет данных для графика динамики." />
        ) : (
          (() => {
            const shown = capTimelineMode(kind === 'line' ? { ...active, kind: 'line' } : { ...active, kind: 'bar' });
            const axisLetters = shown.days ? timeAxisFromDayKeys(shown.days) : undefined;
            return kind === 'line' ? (
              <LineChart
                values={shown.values}
                labels={shown.labels}
                axisLabels={axisLetters}
                titles={shown.titles}
                yMin={0}
                showPoints
                fullAxes
                markAnomalies
                markExtremes
              />
            ) : (
              <BarChart values={shown.values} labels={shown.labels} axisLabels={axisLetters} titles={shown.titles} />
            );
          })()
        )}
      </CampaignReportCard>
      {modes.length > 1 && active && (
        <WindowBarShell label="Показатель">
          <span className="flex-1" />
          <SegmentedControl
            ariaLabel="Показатель"
            value={active.key}
            onChange={selectMode}
            options={modes.map((mode) => ({ value: mode.key, content: mode.label }))}
          />
        </WindowBarShell>
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
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          Это состав кампании по форматам, а не временной ряд — сравнение периодов и переключатель
          Line/Bar здесь были бы ложными.
        </p>
      }
    >
      <CampaignReportCard id="campaign-page-formats" title="По числу публикаций">
        {/* Полукольцо (выбор владельца) — отчётная поверхность показывает ВСЮ легенду. */}
        {slices.values.length > 0 ? (
          <RadialShare
            segments={slices.labels.map((label, i) => ({ key: label, label, value: slices.values[i] ?? 0 }))}
            unitWord="публ."
            centerCaption="публикаций"
            legendMax={Infinity}
          />
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
