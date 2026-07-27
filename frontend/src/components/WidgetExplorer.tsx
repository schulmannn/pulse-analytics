import { useState } from 'react';
import { WidgetConfigControls } from '@/components/ConfigEditDialog';
import { WidgetBody } from '@/components/ConfigWidget';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { Button } from '@/components/ui/button';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { MetricBackLink } from '@/components/metric/shared';
import { ChannelScope } from '@/lib/channel-context';
import { editorSpec } from '@/lib/widgetCapabilities';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { normalizeWidget, type WidgetConfig } from '@/lib/widgetConfig';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { useWidgetSourceChannel } from '@/lib/useWidgetSource';

/**
 * The universal full-page explorer — one place, every config widget. A card opens a SANDBOX:
 * a big chart on the left (full axes) driven by a LOCAL draft config, the whole control set on the
 * right (the same WidgetConfigControls the editor uses). The user explores viz / period / grain /
 * comparison / filter / target freely WITHOUT touching the pinned widget; «Применить к виджету»
 * commits the draft. Leaving the page without applying keeps the widget untouched. No per-chart
 * explorer code — a widget only needs a WidgetConfig + WidgetRenderer, and this works for all of them.
 */
export function WidgetExplorer({
  config,
  onApply,
  backTo = '/home',
}: {
  config: WidgetConfig;
  onApply?: (config: WidgetConfig) => void;
  backTo?: string;
}) {
  const [draft, setDraft] = useState<WidgetConfig>(config);
  const spec = editorSpec(draft);
  const chartHeight = useExplorerChartHeight();
  // Источник резолвится ТЕМ ЖЕ хуком, что и карточка, из которой открыт эксплорер: без явного
  // «Источника» берётся канал сети виджета, а не глобальный свитчер. Иначе TG/IG-виджет,
  // открытый при активном МойСклад/Метрика-канале, читал бы чужой канал (пустой ряд нулей).
  // До resolved (холодный deep-link: список каналов ещё летит) график не монтируем — иначе
  // data-хуки выстрелили бы по глобальному каналу и перещёлкнулись после ответа.
  const { channelId: sourceChannel, resolved: sourceResolved } = useWidgetSourceChannel(draft, { pinned: true });

  const patch = (p: Partial<WidgetConfig>) => setDraft((d) => normalizeWidget({ ...d, ...p }) ?? d);
  const changed = JSON.stringify(draft) !== JSON.stringify(config);

  // The sandbox is where users deliberately push a widget into edge-case configs, so guard the live
  // preview: a throwing draft shows a calm fallback here instead of blanking the whole explorer
  // page. resetKeys on the draft signature → a corrected draft auto-clears the fallback, and the
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

  const label = draft.title || spec.label;
  return (
    <div className="space-y-5">
      <MetricBackLink to={backTo}>Главная</MetricBackLink>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-medium tracking-tight text-foreground">{label}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Полноэкранный график · настройки применятся только после сохранения
          </p>
        </div>
        {onApply && (
          <Button
            type="button"
            disabled={!changed}
            onClick={() => onApply(draft)}
            size="sm"
            className="shrink-0 px-4 text-sm"
          >
            Применить к виджету
          </Button>
        )}
      </header>

      {/* Намеренно НЕ MetricColumns: здесь grid-item'ы другие — левая колонка сама является
          card-рамкой графика, а aside несёт min-w-0 (плотные контролы у фикс. rail 320px),
          а не space-y-6. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:gap-8">
        <div className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5">
          {!sourceResolved ? (
            <ChartSkeleton />
          ) : sourceChannel != null ? (
            <ChannelScope channelId={sourceChannel}>{chart}</ChannelScope>
          ) : (
            chart
          )}
        </div>
        <aside className="min-w-0">
          <div className="lg:sticky lg:top-4">
            <div className="mb-1 text-2xs font-medium tracking-wider text-muted-foreground">Настройки</div>
            <WidgetConfigControls config={draft} spec={spec} onChange={patch} />
          </div>
        </aside>
      </div>
    </div>
  );
}
