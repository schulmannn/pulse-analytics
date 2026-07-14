import { useState } from 'react';
import { WidgetConfigControls } from '@/components/ConfigEditDialog';
import { WidgetBody } from '@/components/ConfigWidget';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { DetailShell } from '@/components/DetailShell';
import { ChannelScope } from '@/lib/channel-context';
import { editorSpec } from '@/lib/widgetCapabilities';
import { normalizeWidget, type WidgetConfig } from '@/lib/widgetConfig';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';

/**
 * The universal fullscreen explorer — one place, every config widget. «Развернуть» opens a SANDBOX:
 * a big chart on the left (full axes) driven by a LOCAL draft config, the whole control set on the
 * right (the same WidgetConfigControls the editor uses). The user explores viz / period / grain /
 * comparison / filter / target freely WITHOUT touching the pinned widget; «Применить к виджету»
 * commits the draft, otherwise the widget is untouched on close. No per-chart explorer code — a
 * widget only needs a WidgetConfig + WidgetRenderer, and this works for all of them.
 */
export function WidgetExplorer({
  config,
  onApply,
  onClose,
  originRect,
}: {
  config: WidgetConfig;
  onApply?: (config: WidgetConfig) => void;
  onClose: () => void;
  /** Clicked-card rect for the shared-element grow (forwarded to DetailShell). */
  originRect?: DOMRect | null;
}) {
  const [draft, setDraft] = useState<WidgetConfig>(config);
  const spec = editorSpec(draft);
  const chartHeight = useExplorerChartHeight();

  const patch = (p: Partial<WidgetConfig>) => setDraft((d) => normalizeWidget({ ...d, ...p }) ?? d);
  const changed = JSON.stringify(draft) !== JSON.stringify(config);

  // The sandbox is where users deliberately push a widget into edge-case configs, so guard the live
  // preview: a throwing draft shows a calm fallback here instead of blanking the whole app behind the
  // overlay. resetKeys on the draft signature → a corrected draft auto-clears the fallback, and the
  // control panel (right side, outside this boundary) stays usable throughout.
  const chart = (
    <WidgetErrorBoundary variant="inline" widgetId={`explorer-${draft.id}`} label={draft.title || spec.label} resetKeys={[JSON.stringify(draft)]}>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartHeight}>
          <WidgetBody config={draft} />
        </ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </WidgetErrorBoundary>
  );

  return (
    <DetailShell variant="fullscreen" ariaLabel={`Explorer «${draft.title || spec.label}»`} onClose={onClose} originRect={originRect}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 pr-14">
        <div className="min-w-0 truncate text-sm font-medium text-foreground">{draft.title || spec.label}</div>
        <div className="flex shrink-0 items-center gap-3">
          {onApply && (
            <button
              type="button"
              disabled={!changed}
              onClick={() => {
                onApply(draft);
                onClose();
              }}
              className="btn-pill bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Применить к виджету
            </button>
          )}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {draft.source != null ? <ChannelScope channelId={draft.source}>{chart}</ChannelScope> : chart}
        </div>
        <aside className="min-w-0">
          <div className="mb-1 text-2xs font-medium tracking-wider text-muted-foreground">Настройки</div>
          <WidgetConfigControls config={draft} spec={spec} onChange={patch} />
        </aside>
      </div>
    </DetailShell>
  );
}
