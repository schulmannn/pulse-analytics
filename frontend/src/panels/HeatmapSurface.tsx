import { ChartTooltip, useHeatmapTip } from '@/components/ChartTooltip';
import { fmt, pluralRu } from '@/lib/format';
import { TG_DAY_NAMES, type HeatmapBestSlot, type HeatmapCell } from '@/lib/tgHeatmap';
import { useScrollEdgeFade } from '@/lib/useScrollEdgeFade';

/** The interactive heatmap surface owns hover state and edge-fade in a lazy leaf, so neither a
    mousemove nor the horizontal-rail runtime weighs on routes that never reveal this chart. */
export function HeatmapSurface({
  grid,
  maxErv,
  bestSlot,
  hourRange,
}: {
  grid: HeatmapCell[][];
  maxErv: number;
  bestSlot: HeatmapBestSlot | null;
  hourRange: { from: number; to: number };
}) {
  const { wrapRef, tip } = useHeatmapTip();
  const scrollFadeRef = useScrollEdgeFade<HTMLDivElement>();
  const hours = Array.from({ length: hourRange.to - hourRange.from + 1 }, (_, i) => hourRange.from + i);
  const cols = `30px repeat(${hours.length}, minmax(14px, 1fr))`;
  const labelStride = hours.length <= 8 ? 1 : hours.length <= 16 ? 2 : 3;

  return (
    // Сетка называет ТОЛЬКО себя. Вывод про лучший слот переехал в видимую строку-вердикт над
    // картой (HeatmapVerdict) и здесь был бы дублем: скринридер читал бы один и тот же факт
    // дважды подряд — сначала текстом, потом как описание картинки.
    <div ref={wrapRef} role="img" aria-label="Тепловая карта публикаций по дням и часам" className="relative">
      <div ref={scrollFadeRef} className="scroll-fade-x overflow-x-auto pb-2">
        <div className="min-w-[420px] space-y-[2px]">
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: cols }}>
            <div />
            {hours.map((hr) => (
              <div key={hr} className="select-none whitespace-nowrap text-center text-2xs font-medium tabular-nums text-muted-foreground">
                {hr % labelStride === 0 ? `${hr}:00` : ''}
              </div>
            ))}
          </div>

          {TG_DAY_NAMES.map((dayName, w) => {
            const currentRow = grid[w] ?? [];
            return (
              <div key={w} className="grid items-center gap-[2px]" style={{ gridTemplateColumns: cols }}>
                <div className="select-none text-2xs font-medium text-muted-foreground">{dayName}</div>
                {hours.map((hr) => {
                  const cell = currentRow[hr];
                  if (!cell || cell.n === 0) return <div key={hr} className="h-4 rounded-sm bg-muted/40" />;
                  const avgErv = cell.ervSum / cell.n;
                  const opacity = maxErv > 0 ? Math.max(0.18, avgErv / maxErv) : 0;
                  const isBest = bestSlot && bestSlot.weekday === w && bestSlot.hour === hr;
                  const titleText = `${dayName} ${hr}:00 · ${cell.n} ${pluralRu(cell.n, ['пост', 'поста', 'постов'])} · ERV ${avgErv.toFixed(1)}% · ср.охват ${fmt.short(cell.reachSum / cell.n)}`;
                  return (
                    <div
                      key={hr}
                      className={`relative h-4 cursor-crosshair rounded-sm transition-opacity dur-base ease-house${isBest ? ' border-2 border-verdant' : ''}`}
                      data-heatmap-tip={titleText}
                      style={{ backgroundColor: 'hsl(var(--brand-iris))', opacity }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <ChartTooltip tip={tip} />
    </div>
  );
}
