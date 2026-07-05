import { memo, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChartSection, PERIOD_WORD } from '@/components/ChartWidget';
import { WidgetRenderer, WidgetSkeleton } from '@/components/WidgetRenderer';
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
// memo: the widget store preserves per-config object identity across snapshots (storeIdentity), so
// when Home re-renders because ONE config changed, every other card's `config` prop is reference-
// equal and bails out here — the edit re-renders exactly one ConfigWidget.
export const ConfigWidget = memo(function ConfigWidget({ config, homeKey }: { config: WidgetConfig; homeKey?: string }) {
  const [editOpen, setEditOpen] = useState(false);
  const navigate = useNavigate();
  const metric = getMetric(config.metricId);
  const legacyKey = legacyKeyForMetricId(config.metricId);
  // Metric widgets and legacy composites both drive the universal editor / explorer.
  const configurable = !!metric || !!legacyKey;
  const label = config.title || metric?.label || (legacyKey ? LEGACY_LABEL[legacyKey] : undefined) || 'Метрика';
  // Drilldown (steep #9): only the six core TG metrics have a metric page (/metrics/:drillKey), so
  // only those cards' hero value + chart points navigate. Everything else (IG, breakdowns, legacy)
  // has no page → no drill. A SOURCE-PINNED card is also not drilled: the metric page reads the
  // global switcher channel, so drilling a card pinned to a different channel would silently show
  // the wrong channel's data. (Re-enabling pinned drill needs a channel-scoped metric page — backlog.)
  // Previews and the explorer sandbox never pass onDrill, so they stay static regardless.
  const drillKey = metric?.drillKey;
  const onDrill = drillKey && config.source == null ? () => navigate(`/metrics/${drillKey}`) : undefined;

  const card = (
    <ChartSection
      id={`custom-${config.id}`}
      title={label}
      homeKey={homeKey}
      defaultSize={config.size}
      // Config signature → when the user reconfigures a crashed widget, the body error boundary
      // (inside ChartSection) clears the caught error and re-renders the new config automatically.
      bodyResetKey={JSON.stringify(config)}
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
          ? (close, originRect) => (
              <WidgetExplorer
                config={config}
                onApply={(next) => updateWidgetConfig(config.id, next)}
                onClose={close}
                originRect={originRect}
              />
            )
          : undefined
      }
    >
      {/* The pin scopes ONLY the card body — not the whole ChartSection: the explorer render-prop
          must stay OUTSIDE the pin so its draft fully controls its own scope («Как в свитчере» in
          the sandbox previews switcher data, not the still-pinned original channel). */}
      {config.source != null ? (
        <ChannelScope channelId={config.source}>
          <WidgetBody config={config} onDrill={onDrill} drillLabel={label} />
        </ChannelScope>
      ) : (
        <WidgetBody config={config} onDrill={onDrill} drillLabel={label} />
      )}
    </ChartSection>
  );

  return (
    <>
      {card}
      {editOpen && configurable && (
        <ConfigEditDialog
          config={config}
          onChange={(patch) => updateWidgetConfig(config.id, patch)}
          onClose={() => setEditOpen(false)}
        />
      )}
    </>
  );
});

/** Resolved widget body — exported so the create-widget preview / explorer render the SAME body a
 *  pinned card will. A legacy composite routes to its adapter; otherwise the metric resolver. TG and
 *  IG bodies are distinct COMPONENTS (not a conditional hook) so a TG widget never mounts IG queries. */
export function WidgetBody({ config, onDrill, drillLabel }: { config: WidgetConfig; onDrill?: () => void; drillLabel?: string }) {
  const legacyKey = legacyKeyForMetricId(config.metricId);
  if (legacyKey) return <LegacyWidgetBody legacyKey={legacyKey} config={config} />;
  const metric = getMetric(config.metricId);
  return metric?.source === 'ig' ? <IgWidgetBody config={config} /> : <TgWidgetBody config={config} onDrill={onDrill} drillLabel={drillLabel} />;
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

function TgWidgetBody({ config, onDrill, drillLabel }: { config: WidgetConfig; onDrill?: () => void; drillLabel?: string }) {
  const { result, isLoading } = useWidgetData(config);
  if (isLoading) return <WidgetSkeleton viz={config.viz} />;
  return <WidgetRenderer result={result} viz={config.viz} onDrill={onDrill} drillLabel={drillLabel} />;
}

function IgWidgetBody({ config }: { config: WidgetConfig }) {
  const { result, isLoading } = useIgWidgetData(config);
  if (isLoading) return <WidgetSkeleton viz={config.viz} />;
  return <WidgetRenderer result={result} viz={config.viz} />;
}
