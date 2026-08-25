import { KpiNumber } from '@/components/KpiNumber';
import { cn } from '@/lib/utils';

/**
 * ЕДИНСТВЕННОЕ место, где живёт рецепт крупного числа карточки.
 *
 * До этого компонента строка классов была скопирована в четыре места (ChartCardBody, CompareStat
 * дважды, ExpandableChart), и копии успели разойтись: канон давно чинил line-box на `leading-[1.15]`
 * — «глиф-бокс дисплейного начертания примерно на 4px выше line-box, `leading-none` клипал цифры в
 * фикс-тайле», — а две копии так и остались на `leading-none`. Одинаковые 44px, разная высота
 * строки: число сидит на другой базовой линии, и карточки перестают читаться как одна система
 * (замечено владельцем на сравнении IG и TG).
 *
 * Правило: `text-hero` не набирается больше нигде — это проверяет `scripts/design-motion-lint.mjs`.
 * Нужен другой размер числа — он появляется здесь вариантом, а не строкой классов на месте.
 */
export interface KpiValueProps {
  /** Уже отформатированное значение: морф цифр делает KpiNumber, нечисловые строки снапаются. */
  text: string;
  /** `hero` — герой истории (44px); `compact` — вторая величина карточки (30px). */
  size?: 'hero' | 'compact';
  /** Клик по числу — тихий вход в разбор. Без него число остаётся текстом. */
  onDrill?: () => void;
  /** Имя метрики для читалки: «Разбор: …». */
  drillLabel?: string;
  className?: string;
}

/**
 * `leading-[1.15]`, а не `leading-none`: глиф-бокс дисплейного начертания выше line-box, и на
 * `leading-none` цифры клипались внутри фикс-тайла с `overflow-hidden`. Значение общее для обоих
 * размеров — иначе рецепт снова разъедется.
 */
const RECIPE = 'kpi-accent font-medium leading-[1.15] tabular-nums tracking-tight';

export function KpiValue({ text, size = 'hero', onDrill, drillLabel, className }: KpiValueProps) {
  const classes = cn(RECIPE, size === 'hero' ? 'text-hero' : 'text-3xl', className);
  if (!onDrill) return <div className={classes}><KpiNumber text={text} /></div>;
  return (
    <button
      type="button"
      aria-label={drillLabel ? `Разбор: ${drillLabel}` : undefined}
      title="Подробный разбор"
      onClick={onDrill}
      className={cn(
        classes,
        'rounded text-left transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
    >
      <KpiNumber text={text} />
    </button>
  );
}
