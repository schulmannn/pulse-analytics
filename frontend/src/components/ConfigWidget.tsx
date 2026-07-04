import { useMemo, useState } from 'react';
import { ChartSection, PERIOD_WORD } from '@/components/ChartWidget';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import { ConfigEditDialog } from '@/components/ConfigEditDialog';
import { WidgetExplorer } from '@/components/WidgetExplorer';
import { LEGACY_RENDER } from '@/components/legacyAdapters';
import { ChannelScope } from '@/lib/channel-context';
import { useWidgetData } from '@/lib/useWidgetData';
import { useIgWidgetData } from '@/lib/useIgWidgetData';
import { getMetric } from '@/lib/widgetMetrics';
import { updateWidgetConfig } from '@/lib/widgetStore';
import { LEGACY_LABEL, legacyKeyForMetricId, type LegacyKey } from '@/lib/legacyWidgets';
import {
  DEFAULT_WIDGET_DAYS,
  WidgetPeriodProvider,
  resolveEffectivePeriod,
  useChannelRecency,
  widgetPeriodValue,
} from '@/lib/period';
import type { WidgetConfig } from '@/lib/widgetConfig';

/**
 * A config-driven widget card — the metric builder's output rendered on a surface. It reuses the
 * existing ChartSection chrome (⋯ menu / expand / reorder within a WidgetGroup) and fills its body
 * with the WidgetRenderer (metric widgets) or a legacy composite body (U6.3), fed by the resolver
 * via useWidgetData. The card's accent / background / size / title all come from the WidgetConfig
 * (via the `configEditor` hook on ChartSection), and the ⋯«Изменить» opens the universal
 * ConfigEditDialog which writes back to the config. Source pinning (config.source) wraps the card in
 * a ChannelScope so the data hooks inside read the pinned channel.
 */
export function ConfigWidget({ config, homeKey }: { config: WidgetConfig; homeKey?: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const metric = getMetric(config.metricId);
  const legacyKey = legacyKeyForMetricId(config.metricId);
  // Metric widgets and legacy composites both drive the universal editor / explorer.
  const configurable = !!metric || !!legacyKey;
  const label = config.title || metric?.label || (legacyKey ? LEGACY_LABEL[legacyKey] : undefined) || 'Метрика';

  const card = (
    <ChartSection
      id={`custom-${config.id}`}
      title={label}
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
        configurable
          ? (close) => (
              <WidgetExplorer
                config={config}
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
      {editOpen && configurable && (
        <ConfigEditDialog
          config={config}
          onChange={(patch) => updateWidgetConfig(config.id, patch)}
          onClose={() => setEditOpen(false)}
        />
      )}
    </>
  );
}

/** Resolved widget body — exported so the create-widget preview / explorer render the SAME body a
 *  pinned card will. A legacy composite routes to its adapter; otherwise the metric resolver. TG and
 *  IG bodies are distinct COMPONENTS (not a conditional hook) so a TG widget never mounts IG queries. */
export function WidgetBody({ config }: { config: WidgetConfig }) {
  const legacyKey = legacyKeyForMetricId(config.metricId);
  if (legacyKey) return <LegacyWidgetBody legacyKey={legacyKey} config={config} />;
  const metric = getMetric(config.metricId);
  return metric?.source === 'ig' ? <IgWidgetBody config={config} /> : <TgWidgetBody config={config} />;
}

/** A legacy composite body (KpiGrid / Digest / …) hosted in the unified card. It reads
 *  useWidgetPeriod(), so we scope that to the instance's config.period — widened to the channel's
 *  data window like the feed does (resolveEffectivePeriod), so a dormant channel isn't blank. Source
 *  is already applied via a ChannelScope on the card. An un-wired legacy key (U6.3b) renders nothing. */
function LegacyWidgetBody({ legacyKey, config }: { legacyKey: LegacyKey; config: WidgetConfig }) {
  const render = LEGACY_RENDER[legacyKey];
  const recency = useChannelRecency();
  const requested = config.period ?? DEFAULT_WIDGET_DAYS;
  const days = resolveEffectivePeriod(requested, recency);
  const period = useMemo(() => widgetPeriodValue(days), [days]);
  if (!render) return null;
  return (
    <WidgetPeriodProvider value={period}>
      {/* Config cards carry no period pills, so surface the auto-widen the same way the old
          periodControl card did — otherwise a dormant channel shows a wider window with no hint. */}
      {days !== requested && (
        <p className="mb-2 text-2xs text-muted-foreground print:hidden">
          За {PERIOD_WORD[requested]} данных нет — показано за {PERIOD_WORD[days]}.
        </p>
      )}
      {render()}
    </WidgetPeriodProvider>
  );
}

function TgWidgetBody({ config }: { config: WidgetConfig }) {
  const result = useWidgetData(config);
  return <WidgetRenderer result={result} viz={config.viz} />;
}

function IgWidgetBody({ config }: { config: WidgetConfig }) {
  const result = useIgWidgetData(config);
  return <WidgetRenderer result={result} viz={config.viz} />;
}
