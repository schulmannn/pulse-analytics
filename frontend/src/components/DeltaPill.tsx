import type { MetricDelta } from '@/lib/delta';

/**
 * Shared trend indicator, deliberately QUIET (steep register): a muted ↑/↓ + percentage with no
 * evaluative colour and no tinted chip — direction lives in the arrow, judgement stays with the
 * reader (владелец: «ничего не кричит»). Hidden when flat or unknown. Single source of truth for
 * KPI cards, the drill-down, the comparison tables, and the IG panel. Positive/negative COLOUR
 * belongs to the ONE evaluated period-vs-period Δ of a comparison rail (`ComparisonDeltaRow`) and
 * to chart roles (DivergingBars) — never to this chip.
 */
/**
 * Текст дельты — или null, если печатать нечего. Вынесен из компонента, чтобы хост мог СПРОСИТЬ,
 * заговорит ли пилюля, и поставить свой честный заменитель вместо пустого места (см. CompactStatHeadline).
 */
export function deltaLabel(delta?: MetricDelta | null): string | null {
  if (!delta || delta.dir === 'flat') return null;
  const percentage = delta.pct >= 100 ? delta.pct.toFixed(0) : delta.pct.toFixed(1);
  // «↑0.0%» — заявка на движение, которую опровергает само же напечатанное число. Ниже разрешения
  // печати направление недоказуемо, и стрелка молчит так же, как на flat (аудит #554, найдено при D9).
  if (Number.parseFloat(percentage) === 0) return null;
  return `${delta.dir === 'up' ? '↑' : '↓'}${percentage}%`;
}

/**
 * ОСНОВАНИЕ ДЕЛЬТЫ — с чем сравнили. `label` — окно базы («29 июл. – 4 авг.») или её единственный
 * день у уровневых метрик («6 авг.»); `value` — уже отформатированное число базы.
 *
 * Пилюля печатала «↑12.3%» и молчала о базе, а соседний слот говорил «пред. период» — слово, за
 * которым для читателя не стояло ни дат, ни числа. Проверить процент было нечем, не уходя со
 * страницы.
 */
export interface DeltaBasis {
  label: string;
  value: string;
}

/** «против 29 июл. – 4 авг.: 9.9k» — одна формулировка на подсказку и на озвучку скринридером. */
export function deltaBasisTitle(basis: DeltaBasis): string {
  return `против ${basis.label}: ${basis.value}`;
}

/**
 * ОДИН тихий слот дельты на все карточки: пилюля процента, готовая строка («+531», «−1.2 п.п.») и
 * честная заглушка «нет базы» — всё это стояло тремя дословными копиями одного класса в
 * KpiGrid/KpiCard/CompactStatHeadline. Копии и разъезжались бы по одной: подсказку об основании
 * пришлось бы добавлять в каждую отдельно.
 *
 * `title` — нативная подсказка по ховеру; тот же текст уходит в `sr-only` (абсолютно
 * спозиционирован, из потока выпадает — ширина слота и базовая линия не меняются), потому что
 * `title` недоступен с клавиатуры и на тач.
 */
export function DeltaNote({ text, title }: { text: string; title?: string }) {
  return (
    <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground" title={title}>
      {text}
      {title && <span className="sr-only">, {title}</span>}
    </span>
  );
}

export function DeltaPill({ delta, basis }: { delta?: MetricDelta | null; basis?: DeltaBasis | null }) {
  const label = deltaLabel(delta);
  if (label == null) return null;
  return <DeltaNote text={label} title={basis ? deltaBasisTitle(basis) : undefined} />;
}
