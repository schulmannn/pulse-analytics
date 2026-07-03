import { useState } from 'react';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import { ConfigEditDialog } from '@/components/ConfigEditDialog';
import { ChannelScope } from '@/lib/channel-context';
import { useWidgetData } from '@/lib/useWidgetData';
import { useIgWidgetData } from '@/lib/useIgWidgetData';
import { getMetric } from '@/lib/widgetMetrics';
import { updateWidgetConfig } from '@/lib/widgetStore';
import type { WidgetConfig } from '@/lib/widgetConfig';

/**
 * A config-driven widget card — the metric builder's output rendered on a surface. It reuses the
 * existing ChartSection chrome (⋯ menu / expand / reorder within a WidgetGroup) and fills its body
 * with the WidgetRenderer, fed by the resolver via useWidgetData. The card's accent / background /
 * size / title all come from the WidgetConfig (via the `configEditor` hook on ChartSection), and the
 * ⋯«Изменить» opens the universal ConfigEditDialog which writes back to the config. Source pinning
 * (config.source) wraps the card in a ChannelScope so the data hooks inside read the pinned channel.
 */
export function ConfigWidget({ config, homeKey }: { config: WidgetConfig; homeKey?: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const metric = getMetric(config.metricId);

  const card = (
    <ChartSection
      id={`custom-${config.id}`}
      title={config.title || metric?.label || 'Метрика'}
      homeKey={homeKey}
      defaultSize={config.size}
      configEditor={{
        open: () => setEditOpen(true),
        color: config.style?.color,
        tinted: config.style?.tinted,
        size: config.size,
        // Fixed goal line → charts' WidgetTargetContext (dynamic/forecast targets land in S9).
        target: config.target?.type === 'fixed' ? config.target.value ?? null : null,
      }}
    >
      <ConfigWidgetBody config={config} />
    </ChartSection>
  );
  const wrapped = config.source != null ? <ChannelScope channelId={config.source}>{card}</ChannelScope> : card;

  return (
    <>
      {wrapped}
      {editOpen && metric && (
        <ConfigEditDialog
          config={config}
          metric={metric}
          onChange={(patch) => updateWidgetConfig(config.id, patch)}
          onClose={() => setEditOpen(false)}
        />
      )}
    </>
  );
}

/** Body only — kept a child of ChartSection (inside its ChannelScope + card) so the data hook reads
 *  the pinned channel and the chart fills the tile via the card's height context. TG and IG bodies
 *  are distinct COMPONENTS (not a conditional hook) so a TG widget never mounts the IG queries. */
function ConfigWidgetBody({ config }: { config: WidgetConfig }) {
  const metric = getMetric(config.metricId);
  return metric?.source === 'ig' ? <IgWidgetBody config={config} /> : <TgWidgetBody config={config} />;
}

function TgWidgetBody({ config }: { config: WidgetConfig }) {
  const result = useWidgetData(config);
  return <WidgetRenderer result={result} viz={config.viz} />;
}

function IgWidgetBody({ config }: { config: WidgetConfig }) {
  const result = useIgWidgetData(config);
  return <WidgetRenderer result={result} viz={config.viz} />;
}
