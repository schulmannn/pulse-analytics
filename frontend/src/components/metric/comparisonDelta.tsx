import { cn } from '@/lib/utils';

/**
 * Оценочная дельта сравнения живёт в СВОЁМ модуле, а не в metric/shared: её читает и ChartTooltip,
 * а тот попадает в чанк каждой вертикали. Импорт из shared тащил бы за собой весь модуль страницы
 * метрики (Link, роутер, MetricColumns) — гейт бюджета поймал ровно это: маршрут «TG обзор» вырос
 * до 363.5KB при потолке 363.0KB. Разделять правило на две копии нельзя (глиф, тон и озвучка
 * обязаны совпадать всюду), поэтому разделены зависимости, а не правило.
 */
/** Оценочная дельта сравнения — единственное место, где verdant/ember красят ТЕКСТ дельты
    (залитая pill `DeltaBadge` выпилена; карточное `DeltaPill` и табличные дельты к медиане читаются
    muted — см. «One voice for deltas» в DESIGN_TOKENS.md). Направление НЕ живёт в одном цвете
    (WCAG 1.4.1): зрячий читает глиф ▲/▼/±, скринридер — слово «рост/снижение» рядом с ним. Сам глиф
    от AT скрыт намеренно: «▲» озвучивается как «чёрный треугольник вверх», а это шум поверх уже
    сказанного слова. Ноль нейтрален. `format` — для единиц, отличных от процента (штуки
    подписчиков, п.п.); формулу дельты считает страница (семантики окон различаются). */
export function ComparisonDelta({
  delta,
  format = (abs) => `${abs.toFixed(1)}%`,
  className,
  evaluative = true,
}: {
  delta: number;
  format?: (abs: number) => string;
  className?: string;
  /** Несёт ли рост этой метрики оценку. `false` — для метрик, у которых «больше» НЕ значит «лучше»:
      объём упоминаний бренда сентимента не несёт (см. `DeltaLine` в `MentionsDesktop.tsx`,
      «never green/red — mention counts carry no sentiment»), и красить его в verdant/ember значило
      бы вынести вердикт, которого вертикаль сознательно не выносит. Разметка при этом ОДНА:
      меняется только тон, глиф и озвучка направления остаются. */
  evaluative?: boolean;
}) {
  const glyph = delta > 0 ? '▲' : delta < 0 ? '▼' : '±';
  const spoken = delta > 0 ? 'рост на ' : delta < 0 ? 'снижение на ' : 'без изменений, ';
  const ink =
    !evaluative || delta === 0 ? 'text-muted-foreground' : delta > 0 ? 'text-verdant' : 'text-ember';
  return (
    <span className={cn('font-medium tabular-nums', ink, className)}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{spoken}</span>
      {format(Math.abs(delta))}
    </span>
  );
}
