import { memo, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannels } from '@/api/queries';
import { ChartSection, PERIOD_WORD } from '@/components/ChartWidget';
import { WidgetRenderer, WidgetSkeleton } from '@/components/WidgetRenderer';
import { ConfigEditDialog } from '@/components/ConfigEditDialog';
import { WidgetExplorer } from '@/components/WidgetExplorer';
import { LEGACY_RENDER } from '@/components/legacyAdapters';
import { ChannelScope, useSelectedChannel } from '@/lib/channel-context';
import { getRememberedChannel } from '@/lib/channel';
import { resolveHomeSourceChannel } from '@/lib/channelSource';
import { useWidgetData } from '@/lib/useWidgetData';
import { useIgWidgetData } from '@/lib/useIgWidgetData';
import { useMsWidgetData } from '@/lib/useMsWidgetData';
import { useYmWidgetData } from '@/lib/useYmWidgetData';
import { getMetric } from '@/lib/widgetMetrics';
import { coerceSizeForViz, effectiveTinted } from '@/lib/widgetSurface';
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
import { HomeSourceProvider } from '@/lib/homeSourceContext';

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
  const sourceNetwork =
    metric?.source === 'ig' ? 'ig' : metric?.source === 'ms' ? 'ms' : metric?.source === 'ym' ? 'ym' : 'tg';
  // Metric widgets and legacy composites both drive the universal editor / explorer.
  const configurable = !!metric || !!legacyKey;
  const label = config.title || metric?.label || (legacyKey ? LEGACY_LABEL[legacyKey] : undefined) || 'Метрика';
  const { channelId: globalChannelId } = useSelectedChannel();
  const channels = useChannels().data?.channels;
  // Канон Главной: карточка НЕ следует глобальному свитчеру. Без явного «Источника» карточка
  // на доске (homeKey) пинится к каналу СВОЕЙ сети — запомненному per-network либо первому
  // подходящему: глобальный выбор может быть каналом другой сети (например, МойСклад), и тогда
  // TG/IG-виджет читал бы пустоту под чужой подписью. Вне Главной (превью/эксплорер/страницы)
  // поведение прежнее — следовать активному каналу.
  const effectiveSource = useMemo(() => {
    if (config.source != null) return config.source;
    if (!homeKey) return null;
    return resolveHomeSourceChannel(channels ?? [], sourceNetwork, getRememberedChannel(sourceNetwork));
  }, [config.source, homeKey, channels, sourceNetwork]);
  // Drilldown (steep #9): only the six core TG metrics have a metric page (/metrics/:drillKey), so
  // only those cards' hero value + chart points navigate. Everything else (IG, breakdowns, legacy)
  // has no page → no drill. A card pinned to ДРУГОЙ канал (в т.ч. авто-пин Главной) is not
  // drilled: the metric page reads the global switcher channel, so drilling would silently show
  // the wrong channel's data; пин, совпадающий с активным каналом, дриллится как раньше.
  // Previews and the explorer sandbox never pass onDrill, so they stay static regardless.
  const drillKey = metric?.drillKey;
  // drillTo — absolute-path drill для метрик без страницы /metrics/:drillKey (МС → /sklad);
  // охрана «пин ≠ активный канал» та же: целевая страница читает глобальный свитчер.
  const drillTo = metric?.drillTo;
  const onDrill =
    (drillKey || drillTo) && (effectiveSource == null || effectiveSource === globalChannelId)
      ? () => navigate(drillTo ?? `/metrics/${drillKey}`)
      : undefined;

  // Central surface + width policy (widgetSurface): a multi-series / tabular viz never carries a tonal
  // wash whatever the saved accent, and a temporal line can't sit at a third width where its x-axis
  // collapses — both enforced here, in the one place a config becomes a card, not per-panel.
  const size = coerceSizeForViz(config.viz, config.size ?? 'third');

  const card = (
    <ChartSection
      id={`custom-${config.id}`}
      title={label}
      homeKey={homeKey}
      defaultSize={size}
      // Config signature → when the user reconfigures a crashed widget, the body error boundary
      // (inside ChartSection) clears the caught error and re-renders the new config automatically.
      bodyResetKey={JSON.stringify(config)}
      configEditor={{
        open: () => setEditOpen(true),
        color: config.style?.color,
        tinted: effectiveTinted(config.viz, config.style?.tinted),
        size,
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
      {effectiveSource != null ? (
        <ChannelScope channelId={effectiveSource}>
          <WidgetBody config={config} onDrill={onDrill} drillLabel={label} />
        </ChannelScope>
      ) : (
        <WidgetBody config={config} onDrill={onDrill} drillLabel={label} />
      )}
    </ChartSection>
  );

  return (
    <>
      <HomeSourceProvider value={{ network: sourceNetwork, channelId: effectiveSource }}>
        {card}
      </HomeSourceProvider>
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
  if (metric?.source === 'ig') return <IgWidgetBody config={config} />;
  if (metric?.source === 'ms') return <MsWidgetBody config={config} onDrill={onDrill} drillLabel={drillLabel} />;
  if (metric?.source === 'ym') return <YmWidgetBody config={config} onDrill={onDrill} drillLabel={drillLabel} />;
  return <TgWidgetBody config={config} onDrill={onDrill} drillLabel={drillLabel} />;
}

/** A legacy composite body (KpiGrid / TopPosts / …) hosted in the unified card. It reads
 *  useWidgetPeriod(), so we scope that to the instance's config.period — widened to the channel's
 *  data window like the feed does (resolveEffectivePeriod), so a dormant channel isn't blank. Source
 *  is already applied via a ChannelScope on the card. */
function LegacyWidgetBody({ legacyKey, config }: { legacyKey: LegacyKey; config: WidgetConfig }) {
  const render = LEGACY_RENDER[legacyKey];
  const recency = useChannelRecency();
  const requested = config.period ?? DEFAULT_WIDGET_DAYS;
  const days = resolveEffectivePeriod(requested, recency);
  const period = useMemo(() => widgetPeriodValue(days), [days]);
  return (
    <WidgetPeriodProvider value={period}>
      {/* Config cards carry no period pills, so surface the auto-widen the same way the old
          periodControl card did — otherwise a dormant channel shows a wider window with no hint. */}
      {days !== requested && (
        <p className="mb-2 text-2xs text-muted-foreground print:hidden">
          За {PERIOD_WORD[requested]} данных нет — показано за {PERIOD_WORD[days]}.
        </p>
      )}
      {render(config)}
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

function MsWidgetBody({ config, onDrill, drillLabel }: { config: WidgetConfig; onDrill?: () => void; drillLabel?: string }) {
  const { result, isLoading } = useMsWidgetData(config);
  if (isLoading) return <WidgetSkeleton viz={config.viz} />;
  return <WidgetRenderer result={result} viz={config.viz} onDrill={onDrill} drillLabel={drillLabel} />;
}

function YmWidgetBody({ config, onDrill, drillLabel }: { config: WidgetConfig; onDrill?: () => void; drillLabel?: string }) {
  const { result, isLoading } = useYmWidgetData(config);
  if (isLoading) return <WidgetSkeleton viz={config.viz} />;
  return <WidgetRenderer result={result} viz={config.viz} onDrill={onDrill} drillLabel={drillLabel} />;
}
