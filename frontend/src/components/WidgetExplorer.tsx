import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { WidgetConfigControls } from '@/components/ConfigEditDialog';
import { WidgetBody } from '@/components/ConfigWidget';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { ChannelScope } from '@/lib/channel-context';
import type { MetricDef } from '@/lib/widgetMetrics';
import { normalizeWidget, type WidgetConfig } from '@/lib/widgetConfig';

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
  metric,
  onApply,
  onClose,
}: {
  config: WidgetConfig;
  metric: MetricDef;
  onApply?: (config: WidgetConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<WidgetConfig>(config);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const patch = (p: Partial<WidgetConfig>) => setDraft((d) => normalizeWidget({ ...d, ...p }) ?? d);
  const changed = JSON.stringify(draft) !== JSON.stringify(config);

  const chart = (
    <ChartExpandedContext.Provider value={true}>
      <ExpandedChartHeightContext.Provider value={420}>
        <WidgetBody config={draft} />
      </ExpandedChartHeightContext.Provider>
    </ChartExpandedContext.Provider>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={`Explorer «${draft.title || metric.label}»`}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 truncate text-sm font-medium text-foreground">{draft.title || metric.label}</div>
        <div className="flex shrink-0 items-center gap-3">
          {onApply && (
            <button
              type="button"
              disabled={!changed}
              onClick={() => {
                onApply(draft);
                onClose();
              }}
              className="btn-pill bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Применить к виджету
            </button>
          )}
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {draft.source != null ? <ChannelScope channelId={draft.source}>{chart}</ChannelScope> : chart}
        </div>
        <aside className="min-w-0">
          <div className="mb-1 text-2xs font-medium tracking-wider text-muted-foreground">Настройки</div>
          <WidgetConfigControls config={draft} metric={metric} onChange={patch} />
        </aside>
      </div>
    </div>,
    document.body,
  );
}
