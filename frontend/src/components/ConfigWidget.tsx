import { useState } from 'react';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import { ConfigEditDialog } from '@/components/ConfigEditDialog';
import { WidgetExplorer } from '@/components/WidgetExplorer';
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
        // The goal line is now resolver-computed (result.target) and provided by WidgetRenderer, so
        // the card-level target override is no longer needed (it also covers dynamic targets, S9).
      }}
      // «Развернуть» opens the universal explorer sandbox (mutable draft; «Применить» commits it).
      explorer={
        metric
          ? (close) => (
              <WidgetExplorer
                config={config}
                metric={metric}
                onApply={(next) => updateWidgetConfig(config.id, next)}
                onClose={close}
              />
            )
          : undefined
      }
    >
      <WidgetBody config={config} />
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

/** Resolved widget body (WidgetRenderer over the config's data) — exported so the create-widget
 *  preview can render the SAME body it will get once added. TG and IG bodies are distinct COMPONENTS
 *  (not a conditional hook) so a TG widget never mounts the IG queries. */
export function WidgetBody({ config }: { config: WidgetConfig }) {
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
