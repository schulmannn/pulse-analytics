import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { TgAnalytics } from '@/panels/TgAnalytics';
import { Insights } from '@/panels/Insights';
import { Compare } from '@/panels/Compare';
import { HistoryChartBlock, HeatmapChartBlock, VelocityChartBlock } from '@/panels/Charts';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
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
          each tab renders only its section family (progressive disclosure). */}
      <div role="tablist" aria-label="Разделы аналитики" className="flex gap-1 overflow-x-auto border-b border-border">
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
              'shrink-0 rounded-t border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
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
      {tab === 'content' && (
        <div className="space-y-10">
          <WidgetGroup id="analytics-content-opportunity" className="grid grid-cols-1 gap-6 lg:grid-cols-6">
            <ChartSection
              id="content-opportunity"
              title="Карта возможностей контента"
              defaultSize="full"
              periodControl
              noExpand
            >
              <ContentOpportunity />
            </ChartSection>
          </WidgetGroup>
          <WidgetErrorBoundary variant="inline" widgetId="analytics-tg-content" label="Аналитика">
            <TgAnalytics group="content" />
          </WidgetErrorBoundary>
          <Hashtags />
        </div>
      )}
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


