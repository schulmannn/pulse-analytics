import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMentionsArchive } from '@/api/queries';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import {
  ChartExpandedContext,
  ExpandedChartHeightContext,
} from '@/components/ExpandableChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LineChart } from '@/components/LineChart';
import { PeriodChips } from '@/components/PeriodChips';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SourceIdentity } from '@/components/SourceIdentity';

import { Skeleton } from '@/components/ui/skeleton';
import { serializeContentPeriod } from '@/lib/contentFilters';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import {
  buildMentionsTimeline,
  capMentionsTimeline,
  type MentionDailyPoint,
  type MentionSourceOption,
} from '@/lib/mentionsFilters';
import { usePeriod, type PeriodDays } from '@/lib/period';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { SegSelect } from '@/components/metric/SegSelect';
import { isMentionsMetricKey } from '@/panels/mentions/mentionsMetricKeys';
import { ComparisonDeltaRow, MetricColumns, MetricDescriptor, WindowBarShell, RailSection, MetricPageHeader} from '@/components/metric/shared';

type ChartKind = 'line' | 'bar';
type CompareMode = 'off' | 'prev';


/**
 * Dedicated graph pages for the Mentions surface. The daily timeline gets the full chart explorer
 * contract (Line/Bar, a real previous equal window and a shared period control). The source ranking
 * remains a categorical report: a full list and period control, without invented chart-type or
 * comparison selectors.
 */
export function MentionsMetricPage({ metricKey }: { metricKey: string }) {
  if (!isMentionsMetricKey(metricKey)) return null;
  return metricKey === 'mentions-timeline'
    ? <MentionsTimelinePage />
    : <MentionsSourcesPage />;
}

function normalizeSource(raw: string | null): string | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+(?=\d)/, '');
  return normalized === '0' ? null : normalized;
}

function mentionsBackTo(days: PeriodDays, source: string | null): string {
  const params = new URLSearchParams();
  const period = serializeContentPeriod(days);
  if (period) params.set('period', period);
  if (source) params.set('source', source);
  const query = params.toString();
  return `/mentions${query ? `?${query}` : ''}`;
}

function MentionsMetricShell({
  backTo,
  term,
  descriptor,
  comparison,
  children,
}: {
  backTo: string;
  term: string;
  descriptor: string;
  comparison: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <MetricPageHeader back={{ to: backTo, label: 'Упоминания' }} />

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="tg" className="mt-1 max-w-full" />
        <MetricDescriptor>{descriptor}</MetricDescriptor>
      </div>

      <MetricColumns
        rail={
          <>
            <RailSection title="Сравнение">{comparison}</RailSection>
            {/* «О метрике» убран — техническая информация не для конечного пользователя (владелец). */}
            <Link
              to={backTo}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            >
              Открыть Упоминания <span aria-hidden="true">→</span>
            </Link>
          </>
        }
      >
        {children}
      </MetricColumns>
    </div>
  );
}

function MentionsReportCard({
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

function WindowBar() {
  const { days, setDays, range, setRange } = usePeriod();
  return (
    <WindowBarShell>
      <span className="flex-1" />
      <PeriodChips
        ariaLabel="Окно"
        value={days}
        onChange={setDays}
        range={range}
        onRangeChange={setRange}
      />
    </WindowBarShell>
  );
}

function MentionsTimelinePage() {
  const { days, range } = usePeriod();
  const [params] = useSearchParams();
  const source = normalizeSource(params.get('source'));
  const archive = useMentionsArchive(days, source, 100, range);
  const [kind, setKind] = useState<ChartKind>('line');
  const [compare, setCompare] = useState<CompareMode>('prev');
  const data = archive.data;
  const daily: MentionDailyPoint[] = data?.daily ?? [];
  const previousDaily: MentionDailyPoint[] = data?.previous_daily ?? [];
  const scopeFrom = data?.scope?.from ?? null;
  const scopeTo = data?.scope?.to ?? null;
  const timeline = useMemo(
    () =>
      buildMentionsTimeline(
        daily,
        previousDaily,
        days,
        data?.scope?.current_to ?? Date.now(),
        scopeFrom && scopeTo ? { from: scopeFrom, to: scopeTo } : null,
      ),
    [daily, previousDaily, days, data?.scope?.current_to, scopeFrom, scopeTo],
  );
  // Кап только рендера (канон CLAUDE.md): линия — pickIndexes/LTTB, столбцы — календарные недели;
  // хедлайн окна и дельта ниже считаются от ПОЛНОГО timeline (кап чисто визуальный).
  const chartTimeline = useMemo(() => capMentionsTimeline(timeline, kind), [timeline, kind]);
  const comparisonAvailable = timeline.ghost != null;
  const showComparison = comparisonAvailable && compare === 'prev';
  const currentTotal = timeline.values.reduce((sum, value) => sum + value, 0);
  const previousTotal = timeline.ghost?.reduce((sum, value) => sum + value, 0) ?? null;
  const delta =
    showComparison && previousTotal != null && previousTotal > 0
      ? ((currentTotal - previousTotal) / previousTotal) * 100
      : null;
  const backTo = mentionsBackTo(days, source);

  return (
    <MentionsMetricShell
      backTo={backTo}
      term="Упоминания по дням"
      descriptor={
        source
          ? 'Динамика упоминаний выбранного канала-источника за выбранное окно'
          : 'Динамика упоминаний бренда по календарным дням за выбранное окно'
      }
      comparison={
        archive.isPending && !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (archive.isError && !data) || data?.available === false ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Сравнение станет доступно после загрузки архива.
          </p>
        ) : comparisonAvailable ? (
          <div className="space-y-3">
            <SegSelect
              ariaLabel="База сравнения"
              value={compare}
              onChange={setCompare}
              options={[
                { value: 'off', label: 'Выкл' },
                { value: 'prev', label: 'Пред. период' },
              ]}
            />
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">Текущее окно</span>
              <span className="text-base font-medium tabular-nums text-foreground">
                {fmt.num(currentTotal)}
              </span>
            </div>
            {showComparison && (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">Пред. период</span>
                  <span className="text-sm tabular-nums text-foreground">
                    {fmt.num(previousTotal ?? 0)}
                  </span>
                </div>
                {delta == null ? (
                  <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
                    <span className="text-xs text-muted-foreground">Изменение</span>
                    <span className="text-xs font-medium tabular-nums text-muted-foreground">нет базы</span>
                  </div>
                ) : (
                  // Общая разметка рейла, но БЕЗ вердикта: объём упоминаний бренда сентимента не
                  // несёт (та же причина, что у `DeltaLine` на /mentions — «never green/red»),
                  // поэтому строка остаётся muted, как была до унификации.
                  <ComparisonDeltaRow delta={delta} evaluative={false} />
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Для окна «Всё» предыдущего равного периода не существует. Выберите ограниченное окно,
            чтобы включить сравнение.
          </p>
        )
      }
    >
      <MentionsReportCard
        id="mentions-page-timeline"
        title="По дням"
        action={
          <SegmentedControl
            ariaLabel="Тип графика"
            className="shrink-0"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'line', content: 'Линия', ariaLabel: 'Тип графика: Линия' },
              { value: 'bar', content: 'Столбцы', ariaLabel: 'Тип графика: Столбцы' },
            ]}
          />
        }
      >
        {archive.isPending && !data ? (
          <Skeleton className="h-[360px] w-full" />
        ) : archive.isError && !data ? (
          <ErrorState
            compact
            size="chart"
            title="Не удалось загрузить архив упоминаний"
            reason={archive.error instanceof Error ? archive.error.message : 'ошибка сервера'}
            onRetry={() => void archive.refetch()}
            retrying={archive.isFetching}
          />
        ) : data?.available === false ? (
          <ErrorState
            compact
            size="chart"
            title="Архив упоминаний временно недоступен"
            reason={data.error || 'Источник не вернул данные.'}
            onRetry={() => void archive.refetch()}
            retrying={archive.isFetching}
          />
        ) : (data?.total ?? 0) === 0 ? (
          <EmptyState compact size="chart" title="За выбранный период упоминаний нет." />
        ) : kind === 'line' ? (
          <LineChart
            values={chartTimeline.values}
            labels={chartTimeline.labels}
            axisLabels={timeAxisFromDayKeys(chartTimeline.days)}
            titles={chartTimeline.titles}
            yMin={0}
            markAnomalies
            markExtremes
            showPoints
            ghost={showComparison ? chartTimeline.ghost : undefined}
            ghostLabel="Пред. период"
            legendToggle={false}
          />
        ) : (
          <BarChart
            values={chartTimeline.values}
            labels={chartTimeline.labels}
            axisLabels={timeAxisFromDayKeys(chartTimeline.days)}
            titles={chartTimeline.titles}
            ghost={showComparison ? chartTimeline.ghost : undefined}
            ghostLabel="Пред. период"
            legendToggle={false}
          />
        )}
      </MentionsReportCard>
      <WindowBar />
    </MentionsMetricShell>
  );
}

function MentionsSourcesPage() {
  const { days, range } = usePeriod();
  const [params] = useSearchParams();
  const incomingSource = normalizeSource(params.get('source'));
  // The ranking must remain complete even when the source surface was filtered to one channel.
  // The incoming source only belongs to the back link; querying it here would collapse the report.
  const archive = useMentionsArchive(days, null, 100, range);
  const data = archive.data;
  const options: MentionSourceOption[] = data?.source_options ?? [];
  const items = options.map((option) => ({
    label: option.username ? `@${option.username}` : option.title || 'Без названия',
    value: option.count,
    display: `${fmt.num(option.count)} упом · ${fmt.short(option.views)} просм`,
  }));
  const backTo = mentionsBackTo(days, incomingSource);

  return (
    <MentionsMetricShell
      backTo={backTo}
      term="Кто упоминает"
      descriptor="Каналы-источники, упорядоченные по числу упоминаний бренда за выбранное окно"
      comparison={
        <p className="text-xs leading-relaxed text-muted-foreground">
          Это распределение каналов за окно, а не одна метрика периода — сравнение с прошлым
          периодом не рассчитывается. Меняйте окно, чтобы пересобрать рейтинг.
        </p>
      }
    >
      <MentionsReportCard id="mentions-page-sources" title="Все каналы">
        {archive.isPending && !data ? (
          <Skeleton className="h-[360px] w-full" />
        ) : archive.isError && !data ? (
          <ErrorState
            compact
            size="chart"
            title="Не удалось загрузить источники упоминаний"
            reason={archive.error instanceof Error ? archive.error.message : 'ошибка сервера'}
            onRetry={() => void archive.refetch()}
            retrying={archive.isFetching}
          />
        ) : data?.available === false ? (
          <ErrorState
            compact
            size="chart"
            title="Архив упоминаний временно недоступен"
            reason={data.error || 'Источник не вернул данные.'}
            onRetry={() => void archive.refetch()}
            retrying={archive.isFetching}
          />
        ) : items.length === 0 ? (
          <EmptyState compact size="chart" title="За выбранный период упоминающих каналов нет." />
        ) : (
          <Breakdown items={items} />
        )}
      </MentionsReportCard>
      <WindowBar />
    </MentionsMetricShell>
  );
}
