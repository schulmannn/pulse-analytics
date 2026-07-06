import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { WidgetConfigControls } from '@/components/ConfigEditDialog';
import { WidgetBody } from '@/components/ConfigWidget';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { ChannelScope } from '@/lib/channel-context';
import { editorSpec } from '@/lib/widgetCapabilities';
import { getMetric } from '@/lib/widgetMetrics';
import { defaultWidget, normalizeWidget, type WidgetConfig } from '@/lib/widgetConfig';

/**
 * «Собрать виджет» — the steep create step. After picking a metric from the catalogue the user lands
 * here: a LIVE preview of the exact card on the left (WidgetBody over a draft config, real data), the
 * full control set on the right (the same WidgetConfigControls the edit dialog uses), and «Добавить».
 * So a widget is configured + seen BEFORE it's pinned, instead of dropped onto Home blind.
 */
export function CreateWidgetDialog({
  metricId,
  onAdd,
  onClose,
}: {
  metricId: string;
  onAdd: (config: WidgetConfig) => void;
  onClose: () => void;
}) {
  const metric = getMetric(metricId);
  const [draft, setDraft] = useState<WidgetConfig>(
    () => defaultWidget(metricId) ?? { id: 'draft', metricId, viz: 'kpi' },
  );

  // Modal focus contract (declared before the `!metric` early return — hooks rule). The catalog that
  // opened this dialog unmounts in the same commit, so without the trap focus lands on <body> behind
  // an aria-modal overlay and Tab walks the obscured page.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

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

  if (!metric) return null;

  // Every edit re-validates the whole draft (same path as the store's updateWidgetConfig), so the
  // preview and the eventual stored widget can never diverge.
  const patch = (p: Partial<WidgetConfig>) => setDraft((d) => normalizeWidget({ ...d, ...p }) ?? d);

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm backdrop-grayscale sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`Собрать виджет «${draft.title || metric.label}»`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto grid w-full max-w-3xl grid-cols-1 gap-5 rounded-xl border border-border bg-card p-5 focus:outline-none sm:grid-cols-[minmax(0,1fr)_300px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left — live preview of the card body. */}
        <div className="min-w-0">
          <div className="mb-2 text-sm font-medium text-foreground">Предпросмотр</div>
          <div className="flex h-[280px] flex-col overflow-hidden rounded-xl border border-border bg-card p-4">
            <div className="text-xs font-medium tracking-wider text-muted-foreground">
              {draft.title || metric.label}
            </div>
            <div className="mt-3 min-h-0 flex-1">
              {/* null height context → charts use their own default; the box gives a tile-like frame.
                  ChannelScope so the preview honours the draft's «Источник» like the real card will. */}
              <ExpandedChartHeightContext.Provider value={null}>
                {/* Guard the live preview: a draft config that throws shows a calm fallback in the
                    preview frame instead of blanking the app and dropping the user out of the create
                    flow. resetKeys on the draft signature → a corrected draft auto-recovers. */}
                <WidgetErrorBoundary variant="inline" label={draft.title || metric.label} resetKeys={[JSON.stringify(draft)]}>
                  {draft.source != null ? (
                    <ChannelScope channelId={draft.source}>
                      <WidgetBody config={draft} />
                    </ChannelScope>
                  ) : (
                    <WidgetBody config={draft} />
                  )}
                </WidgetErrorBoundary>
              </ExpandedChartHeightContext.Provider>
            </div>
          </div>
        </div>

        {/* Right — the shared control set + actions. */}
        <div className="flex max-h-[70vh] min-w-0 flex-col">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-sm font-medium text-foreground">Настройки</div>
            <div className="truncate text-xs text-muted-foreground">{metric.label}</div>
          </div>
          <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
            <WidgetConfigControls config={draft} spec={editorSpec(draft)} onChange={patch} />
          </div>
          <div className="mt-4 flex items-center justify-end gap-3 border-t border-border pt-3">
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => onAdd(draft)}
              className="btn-pill bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Добавить на главную
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
