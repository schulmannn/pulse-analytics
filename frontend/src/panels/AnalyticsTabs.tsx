import { useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { TgAnalytics } from '@/panels/TgAnalytics';
import { Insights } from '@/panels/Insights';
import { Compare } from '@/panels/Compare';
import { HistoryChartBlock, HeatmapChartBlock, VelocityChartBlock } from '@/panels/Charts';
import { WidgetGroup } from '@/components/ChartWidget';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { Hashtags } from '@/panels/Hashtags';

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
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none',
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
        <div className="space-y-10">
          <AnalyticsSection title="Сравнение периодов">
            <Compare />
          </AnalyticsSection>
          <AnalyticsSection title="Главное">
            <Insights />
          </AnalyticsSection>
        </div>
      )}
    </div>
  );
}

function AnalyticsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-base font-medium tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  );
}
