/**
 * Общие элементы каркаса metric-страниц (/metrics/*). Каркас этих страниц исторически
 * скопирован по вертикалям (TG/IG/MS/кампании/упоминания/Метрика) — см. очередь в
 * PROJECT_MEMORY; сюда выносится то, что уже дословно совпадает во всех копиях, чтобы
 * новая вертикаль не клонировала разметку дальше.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { isPlainLeftClick, useViewTransitionNavigate } from '@/lib/viewTransitionNavigate';

/** Back-ссылка metric-страницы («← Обзор» / «← Instagram» / …): единый глиф (скрыт от SR),
    размер и hover-переход хлебной крошки — чтобы копии вертикалей не расходились. */
export function MetricBackLink({ to, children }: { to: string; children: ReactNode }) {
  // View Transitions (волна B): возврат метрик-страница → фид тем же кроссфейдом, что и drill.
  const vtNavigate = useViewTransitionNavigate();
  return (
    <Link
      to={to}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        vtNavigate(to);
      }}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <span aria-hidden="true">←</span> {children}
    </Link>
  );
}

/** Двухколоночный каркас metric-страницы: main (min-w-0, чтобы графики не распирали грид)
    + правый rail 300px; на <lg rail уезжает под основной блок. Инспекторные гриды
    (var(--inspector-w) + InspectorHandle в MetricPage/IgMetricPage) сюда намеренно НЕ входят —
    у них другая колонка, обёртка и ритм rail'а. */
export function MetricColumns({
  children,
  rail,
  railHidden = false,
}: {
  children: ReactNode;
  rail: ReactNode;
  /** Колонка свёрнута: полотно занимает её место. Панель уходит ИЗ ПОТОКА, а не прячется
      прозрачностью — иначе широкий график остался бы обрезанным по прежней сетке. */
  railHidden?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-6 xl:gap-8',
        !railHidden && 'lg:grid-cols-[minmax(0,1fr)_300px]',
      )}
    >
      <div className="min-w-0 space-y-6">{children}</div>
      {!railHidden && <aside className="space-y-6">{rail}</aside>}
    </div>
  );
}

/** Дескриптор-строка тихой шапки: пояснение-подзаголовок под именем метрики/источником. */
export function MetricDescriptor({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 text-xs text-muted-foreground">{children}</div>;
}

/** Rail-секция metric-страницы в двух канонах. `variant="flat"` (по умолчанию) — плоский заголовок
    с hairline («ничего не кричит», без рамки), так живут шесть вертикалей. `variant="card"` —
    аналитическая карточка composer-rail'а MetricPage: заголовок без hairline на card-поверхности.
    Card-ветка НЕ несёт `space-y-*`: её дети расставляют собственные `mt-*` (см. MetricPage), и
    вертикальный ритм от контейнера их бы перебил. `mark` → `data-rail-card` в обеих ветках —
    на него смотрят e2e (interactions.spec). */
export function RailSection({
  title,
  mark,
  variant = 'flat',
  icon,
  action,
  children,
}: {
  title: string;
  mark?: string;
  variant?: 'flat' | 'card' | 'row';
  /** Моно-значок 16px слева от названия (только `row`). */
  icon?: ReactNode;
  /** Действие у ПРАВОГО края строки названия — «+» добавления (только `row`). */
  action?: ReactNode;
  children: ReactNode;
}) {
  if (variant === 'row') {
    // Анатомия снята с метрик Steep по просьбе владельца («сделай также») — не по памяти о
    // скриншоте, а замером живой страницы: строка названия 32px, значок 16px в приглушённом цвете,
    // отступ 10px до названия, действие 28×28 у правого края, волосяная линия ПОД строкой во всю
    // ширину. Название идёт ОСНОВНЫМ цветом обычного размера, а не приглушённой разрядкой: у них
    // раздел читается как заголовок списка, а не как микроподпись.
    //
    // Взята анатомия, не поверхность: тёмное стекло с backdrop-blur и свечением тени остаётся у
    // них — у нас канон «без теней, только волосяные линии», и чужая поверхность встала бы пятном.
    //
    // ЛИНИЯ ОТДЕЛЯЕТ РАЗДЕЛ ОТ РАЗДЕЛА, а не заголовок от собственного тела. Прошлая редакция
    // ставила её сразу под строкой названия, и раздел визуально разваливался: подпись оставалась
    // сверху, а её содержимое уезжало под черту — читалось как начало СЛЕДУЮЩЕГО раздела. У Steep
    // раздел — блок `px-2.5 py-2` с волосяной чертой ПО НИЖНЕМУ краю всего блока (замер: шаг 49px
    // при строке 32px), поэтому заголовок и его содержимое всегда по одну сторону линии.
    return (
      <section data-rail-card={mark} data-rail-row="" className="border-b border-border px-2.5 py-2">
        <div className="flex h-8 items-center justify-between gap-2.5 pl-2">
          <span className="flex min-w-0 items-center gap-2.5">
            {icon && (
              <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                {icon}
              </span>
            )}
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
          </span>
          {action}
        </div>
        {children}
      </section>
    );
  }
  if (variant === 'card') {
    return (
      <section
        data-rail-card={mark}
        className="rounded-2xl border border-border bg-card p-4 shadow-xs dark:border-white/6 sm:p-5"
      >
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground">{title}</h3>
        <div className="mt-3">{children}</div>
      </section>
    );
  }
  return (
    <section data-rail-card={mark} className="space-y-3">
      <h3 className="flex items-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
        <span className="whitespace-nowrap">{title}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

/** Единый chrome тайм-бара окна: hairline сверху + метка слева; контролы (PeriodChips /
    SegmentedControl / спейсер) остаются у страницы — семантики периода различаются. */
export function WindowBarShell({ label = 'Окно', children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Строка «О метрике»: термин + пояснение внутри `<dl>`. */
export function AboutRow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-foreground">{text}</dd>
    </div>
  );
}

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

/** Строка «Изменение» comparison-rail'а — одна разметка на все вертикали (TG/IG/MS/Метрика/
    упоминания), чтобы копии не расходились по глифам, цветам и точности. `evaluative={false}` —
    для метрик без сентимента (объём упоминаний), см. {@link ComparisonDelta}. */
export function ComparisonDeltaRow({
  delta,
  format,
  evaluative,
}: {
  delta: number;
  format?: (abs: number) => string;
  evaluative?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
      <span className="text-xs text-muted-foreground">Изменение</span>
      <ComparisonDelta delta={delta} format={format} evaluative={evaluative} className="text-xs" />
    </div>
  );
}
