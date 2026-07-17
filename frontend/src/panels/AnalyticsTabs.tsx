import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { fmt, pluralRu } from '@/lib/format';
import { TgAnalytics } from '@/panels/TgAnalytics';
import { useChannels, useTgFull, useTgGraphs } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { calendarWindowForPeriod, DEFAULT_WIDGET_DAYS, usePagePeriod } from '@/lib/period';
import { buildTgAnalyticsRows, tgDailySeriesFromGraphs } from '@/lib/tgAnalyticsExport';
import { downloadAnalyticsCsv, exportFilename } from '@/lib/analyticsExport';
import { Insights } from '@/panels/Insights';
import { Compare } from '@/panels/Compare';
import { HistoryChartBlock, HeatmapChartBlock, VelocityChartBlock } from '@/panels/Charts';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { CampaignFilterControl } from '@/components/campaigns/CampaignFilterControl';
import { useTgCampaignScope, type TgCampaignScope } from '@/lib/campaignFilter';
import { Hashtags } from '@/panels/Hashtags';
import { ContentOpportunity } from '@/panels/ContentOpportunity';

/**
 * Analytics — the deep breakdowns. The Overview is a focused summary (Figma), so the detailed
 * sections that used to sit there (auto-insights, рост/история, лучшее время, скорость,
 * сравнение) live here alongside the TG breakdowns + hashtag lift. Moved out of App.tsx so
 * the TG feed can compose it as a block.
 */
// Order mirrors the canonical section schema (dynamics/reach → content aggregates →
// audience/demographics → comparison). The tab is «Форматы», not «Контент»: the sidebar's
// «Контент» section (the posts list) owns that name now — two different «Контент» one click
// apart read as the same thing. This tab is per-TYPE aggregates (formats, эмодзи, hashtags).
const ANALYTICS_TABS = [
  { key: 'dynamics', label: 'Динамика' },
  { key: 'content', label: 'Форматы' },
  { key: 'audience', label: 'Аудитория' },
  { key: 'compare', label: 'Сравнение' },
] as const;
type AnalyticsTab = (typeof ANALYTICS_TABS)[number]['key'];

const isAnalyticsTab = (raw: string | null): raw is AnalyticsTab =>
  ANALYTICS_TABS.some((t) => t.key === raw);

export function Analytics() {
  // The active tab lives in ?tab= (replace, not push) so a shared /analytics link restores
  // it; the default «Динамика» keeps the URL clean. Period params (?p / ?from&to) coexist.
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: AnalyticsTab = isAnalyticsTab(rawTab) ? rawTab : 'dynamics';
  const setTab = (next: AnalyticsTab) => {
    setParams(
      (prev) => {
        const merged = new URLSearchParams(prev);
        if (next === 'dynamics') merged.delete('tab');
        else merged.set('tab', next);
        return merged;
      },
      { replace: true },
    );
  };
  return (
    <div className="space-y-8">
      {/* Grouped tabs break the 20-chart wall into Динамика / Аудитория / Контент / Сравнение —
          each tab renders only its section family (progressive disclosure). The desktop-only export
          control sits alongside the tabs and covers the whole analytics window regardless of tab. */}
      {/* Пилюльные табы (steep-регистр): подчёркивание border-b-2 выбивалось из пилюльного
          языка сегментов; активный таб — тихая secondary-заливка, никакой синей линии. */}
      <div className="flex items-center justify-between gap-3">
      <div role="tablist" aria-label="Разделы аналитики" className="flex gap-1 overflow-x-auto">
        {ANALYTICS_TABS.map((t) => (
          <button
            key={t.key}
            id={`analytics-tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            // APG tabs: ролям tab обещаны стрелки — без них скринридер объявляет навигацию,
            // которой нет (аудит). Roving tabindex + перенос фокуса на активированный таб.
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = ANALYTICS_TABS.findIndex((x) => x.key === tab);
              const next = ANALYTICS_TABS[(i + (e.key === 'ArrowRight' ? 1 : ANALYTICS_TABS.length - 1)) % ANALYTICS_TABS.length]!;
              setTab(next.key);
              requestAnimationFrame(() => document.getElementById(`analytics-tab-${next.key}`)?.focus());
            }}
            className={cn(
              'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              tab === t.key ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
        <TgAnalyticsExportButton />
      </div>

      {tab === 'dynamics' && (
        <div className="space-y-10">
          {/* TgAnalytics derives its breakdowns in its OWN render (above every ChartSection), so a
              panel-level boundary keeps the app shell alive if a top-level derive throws; its
              per-chart function-form computes are already isolated inside ChartSection. */}
          <WidgetErrorBoundary variant="inline" widgetId="analytics-tg-dynamics" label="Аналитика">
            <TgAnalytics group="dynamics" />
          </WidgetErrorBoundary>
          {/* Standard 1× tiles side by side — stacked full-width they rendered as two
              200px-high «islands» stretched across the whole row. Wide (span-2) variants
              still take the full row via the widgets' own variant span. History/Velocity build
              their series in their own render (above ChartSection), so each gets a per-widget card
              boundary here — the same seam Home protects. */}
          <WidgetGroup id="analytics-dynamics" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
            <WidgetErrorBoundary variant="card" size="half" widgetId="analytics-history" label="История подписчиков">
              <HistoryChartBlock />
            </WidgetErrorBoundary>
            <WidgetErrorBoundary variant="card" size="half" widgetId="analytics-velocity" label="Скорость набора просмотров">
              <VelocityChartBlock />
            </WidgetErrorBoundary>
          </WidgetGroup>
        </div>
      )}
      {tab === 'content' && <FormatsTab />}
      {tab === 'audience' && (
        <div className="space-y-10">
          <WidgetErrorBoundary variant="inline" widgetId="analytics-tg-audience" label="Аналитика">
            <TgAnalytics group="audience" />
          </WidgetErrorBoundary>
          <WidgetErrorBoundary variant="card" size="full" widgetId="analytics-heatmap" label="Тепловая карта активности">
            <HeatmapChartBlock />
          </WidgetErrorBoundary>
        </div>
      )}
      {tab === 'compare' && (
        <WidgetGroup id="analytics-compare" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
          {/* Real widgets (аудит: не-виджетные блоки без ⋯) — hide/reorder like every card. */}
          <ChartSection id="tg-period-compare" title="Сравнение периодов" defaultSize="full" noExpand>
            <Compare />
          </ChartSection>
          <ChartSection id="tg-insights" title="Главное" defaultSize="full" noExpand>
            <Insights />
          </ChartSection>
        </WidgetGroup>
      )}
    </div>
  );
}

/**
 * Desktop-only Telegram Analytics export. Reflects the exact top-bar window (preset or custom «Свой»)
 * and its equal previous window where the archive covers it; only genuinely daily flows (channel
 * views, reposts, net follower growth) are exported — no fabricated daily values, no history leak.
 */
function TgAnalyticsExportButton() {
  const { data: full } = useTgFull(0);
  const { data: graphs } = useTgGraphs();
  const pp = usePagePeriod();
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();

  const win = calendarWindowForPeriod(pp ? { days: pp.days, range: pp.range } : { days: DEFAULT_WIDGET_DAYS, range: null });
  const channel = channelsData?.channels.find((c) => c.id === channelId);
  const source = channel?.title ?? channel?.username ?? full?.channel?.title ?? full?.channel?.username ?? '';

  const rows = useMemo(
    () => buildTgAnalyticsRows({ source, window: win, series: tgDailySeriesFromGraphs(graphs) }),
    [source, win?.from, win?.to, graphs],
  );

  return (
    <button
      type="button"
      onClick={() =>
        downloadAnalyticsCsv(
          exportFilename({ network: 'telegram', section: 'analytics', source, from: win?.from, to: win?.to }),
          rows,
        )
      }
      disabled={rows.length === 0}
      aria-label="Экспорт метрик аналитики за выбранный период в CSV"
      title={rows.length === 0 ? 'Нет метрик за выбранный период' : undefined}
      className="mb-1 hidden shrink-0 btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 md:inline-flex"
    >
      Экспорт метрик
    </button>
  );
}

/**
 * «Форматы» — the only Analytics surface with the canonical campaign filter (?campaign=). A single
 * desktop scope row sits near the tab controls (not duplicated inside cards); selecting a campaign
 * scopes the POST-derived content sections to that campaign's members for the active source
 * (tg, channelId) — never another channel or Instagram, never the channel-wide views_summary.
 * Dynamics/Audience stay channel-level and don't render this control. The campaign param is kept in
 * the URL across tabs, but only applied and shown here.
 */
function FormatsTab() {
  const scope = useTgCampaignScope();
  return (
    <div>
      {/* Scope row near the tab controls. `empty:hidden` keeps a new workspace (no campaigns →
          CampaignFilterControl renders null) from leaving a stray gap above the widgets. */}
      <div
        className="hidden flex-wrap items-center gap-3 empty:hidden md:flex md:[&:not(:empty)]:mb-8"
        data-testid="analytics-campaign-scope"
        aria-live="polite"
      >
        <CampaignFilterControl />
        {scope.active && scope.sourceMemberCount > 0 && (
          <span className="text-2xs text-muted-foreground">
            {fmt.num(scope.sourceMemberCount)}{' '}
            {pluralRu(scope.sourceMemberCount, ['публикация', 'публикации', 'публикаций'])} кампании из этого источника
          </span>
        )}
      </div>
      <FormatsBody scope={scope} />
    </div>
  );
}

/** Honest loading/empty/error for the campaign-scoped Formats content, then the (filtered) widgets. */
function FormatsBody({ scope }: { scope: TgCampaignScope }) {
  if (scope.active && scope.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (scope.active && scope.isError) {
    return <ErrorState title="Не удалось загрузить публикации кампании" onRetry={scope.retry} />;
  }
  if (scope.active && scope.sourceMemberCount === 0) {
    return (
      <EmptyState
        title="В этой кампании нет публикаций Telegram из текущего источника"
        reason="Выберите другую кампанию или снимите фильтр, чтобы увидеть аналитику всего канала."
      />
    );
  }
  const inCampaign = scope.inCampaign;
  return (
    <div className="space-y-10">
      <WidgetGroup id="analytics-content-opportunity" className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection
          id="content-opportunity"
          title="Карта возможностей контента"
          defaultSize="full"
          periodControl
          noExpand
        >
          <ContentOpportunity inCampaign={inCampaign} />
        </ChartSection>
      </WidgetGroup>
      <WidgetErrorBoundary variant="inline" widgetId="analytics-tg-content" label="Аналитика">
        <TgAnalytics group="content" campaign={{ active: scope.active, inCampaign }} />
      </WidgetErrorBoundary>
      <Hashtags inCampaign={inCampaign} />
    </div>
  );
}


