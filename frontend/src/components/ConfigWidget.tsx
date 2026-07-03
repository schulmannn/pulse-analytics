import { ChartSection } from '@/components/ChartWidget';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import { ChannelScope } from '@/lib/channel-context';
import { useWidgetData } from '@/lib/useWidgetData';
import { getMetric } from '@/lib/widgetMetrics';
import type { WidgetConfig } from '@/lib/widgetConfig';

/**
 * A config-driven widget card — the metric builder's output rendered on a surface. It reuses the
 * existing ChartSection chrome (title / ⋯ menu / expand / reorder within a WidgetGroup) and fills its
 * body with the WidgetRenderer, fed by the resolver via useWidgetData. Source pinning (config.source)
 * wraps the card in a ChannelScope so the data hooks inside read the pinned channel.
 *
 * The card size follows config.size (via the ChartSection prefs store, keyed by the custom id); the
 * rich per-metric settings (period / grain / comparison / target / filter) come from the WidgetConfig
 * and are edited through the builder dialog (S5), not the legacy prefs dialog.
 */
export function ConfigWidget({ config, homeKey }: { config: WidgetConfig; homeKey?: string }) {
  const metric = getMetric(config.metricId);
  const card = (
    <ChartSection
      id={`custom-${config.id}`}
      title={config.title || metric?.label || 'Метрика'}
      homeKey={homeKey}
      defaultSize={config.size}
    >
      <ConfigWidgetBody config={config} />
    </ChartSection>
  );
  return config.source != null ? <ChannelScope channelId={config.source}>{card}</ChannelScope> : card;
}

/** Body only — kept a child of ChartSection (inside its ChannelScope + card) so useWidgetData reads
 *  the pinned channel and the chart fills the tile via the card's height context. */
function ConfigWidgetBody({ config }: { config: WidgetConfig }) {
  const result = useWidgetData(config);
  return <WidgetRenderer result={result} viz={config.viz} />;
}
