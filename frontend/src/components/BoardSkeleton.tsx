import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { WidgetGrid } from '@/components/widgets/WidgetGrid';

/**
 * СКЕЛЕТОН БОРДА ПОВТОРЯЕТ ФОРМУ БОРДА (аудит #554, D16).
 *
 * Обзоры Метрики и МойСклада рисовали ДВЕ половинные плитки там, где загрузится девятнадцать
 * карточек (Метрика) или семь (МойСклад). Страница на время загрузки была высотой в один ряд, а
 * потом вырастала на тысячи пикселей — скачок раскладки на каждом заходе, скролл и ссылки под
 * курсором уезжали.
 *
 * Скелетон обязан занимать столько же места, сколько займёт борд. Поэтому он принимает СПИСОК
 * размеров, а не число: половинная плитка держит фикс-высоту тайла, полноширинная полоса —
 * свою. Список рядом с бордом и должен меняться вместе с ним.
 */

export type BoardTile = 'half' | 'full' | 'strip';

const SPAN: Record<BoardTile, string> = {
  half: 'lg:col-span-3 h-[264px]',
  full: 'lg:col-span-6 h-[264px]',
  // Полоса — не карточка-график: своя невысокая высота (качество трафика Метрики).
  strip: 'lg:col-span-6 h-[168px]',
};

export function BoardSkeleton({ tiles, className }: { tiles: readonly BoardTile[]; className?: string }) {
  return (
    <WidgetGrid className={className ?? 'grid grid-cols-1 gap-6 lg:grid-cols-6'}>
      {tiles.map((tile, i) => (
        <div
          // Плитки скелетона неразличимы и неподвижны — индекс здесь единственный ключ и он честный.
          key={`${tile}-${i}`}
          data-board-skeleton-tile={tile}
          className={`rounded-2xl border border-border bg-card p-5 ${SPAN[tile]}`}
        >
          <ChartSkeleton />
        </div>
      ))}
    </WidgetGrid>
  );
}
