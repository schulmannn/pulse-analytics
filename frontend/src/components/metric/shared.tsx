/**
 * Общие элементы каркаса metric-страниц (/metrics/*). Каркас этих страниц исторически
 * скопирован по вертикалям (TG/IG/MS/кампании/упоминания/Метрика) — см. очередь в
 * PROJECT_MEMORY; сюда выносится то, что уже дословно совпадает во всех копиях, чтобы
 * новая вертикаль не клонировала разметку дальше.
 */

import type { ReactNode } from 'react';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { setMetricRailHidden, useMetricRailHidden } from '@/lib/metricRail';
// Реэкспорт: правило дельты живёт в своём лёгком модуле (см. comparisonDelta), но все прежние
// импорты `from '@/components/metric/shared'` продолжают работать.
import { ComparisonDelta } from '@/components/metric/comparisonDelta';
import { isPlainLeftClick, useViewTransitionNavigate } from '@/lib/viewTransitionNavigate';

export { ComparisonDelta };

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
/**
 * Шапка страницы метрики: возврат слева, действия страницы справа — ОДНОЙ строкой.
 *
 * Шесть источников (TG, IG, МойСклад, Метрика, упоминания, кампании, СДЭК) держали одинаковый
 * скелет копиями, и всякая правка доезжала до одного из них. Переключатель колонки так и жил
 * только у СДЭКа, хотя полотну не хватает 300px на любой метрике.
 *
 * Кнопка сворачивания стоит ЗДЕСЬ, а не в самой колонке: спрятанную колонку нечем было бы вернуть.
 */
export function MetricPageHeader({
  back,
  actions,
}: {
  back: { to: string; label: string };
  /** Действия конкретной страницы (например, «Сохранить») — левее переключателя. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <MetricBackLink to={back.to}>{back.label}</MetricBackLink>
      <span className="flex shrink-0 items-center gap-2">
        {actions}
        <MetricRailToggle />
      </span>
    </div>
  );
}

/**
 * Сам переключатель — отдельно от шапки: у страницы метрик Telegram шапка своя, со «Закрепить».
 *
 * Называется он «правая панель», а не «фильтры»: колонка держит ещё сравнение, цели и разбивку,
 * и на метрике без единого фильтра прежнее имя обещало не то. Слово «правая» обязательно —
 * «Скрыть панель» уже занято сворачиванием САЙДБАРА, и два разных контрола звучали одинаково
 * (поймано тестом: strict mode violation, два элемента на одно имя). Прячется он ТОЛЬКО на десктопе — ниже
 * lg колонка и так стоит под графиком, горизонтального места не занимает, и скрывать её значило
 * бы просто отнять у человека сравнение.
 */
export function MetricRailToggle() {
  const railHidden = useMetricRailHidden();
  return (
    <>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // Ниже lg колонка стоит под графиком — скрывать там нечего.
          className="hidden lg:inline-flex"
          aria-pressed={railHidden}
          aria-label={railHidden ? 'Показать правую панель' : 'Скрыть правую панель'}
          title={railHidden ? 'Показать правую панель' : 'Скрыть правую панель'}
          onClick={() => setMetricRailHidden(!railHidden)}
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            <rect x="1.15" y="2.15" width="13.7" height="11.7" rx="2.2" />
            <path d="M9.9 2.6v10.8" />
            {!railHidden && <rect x="9.9" y="2.6" width="4.5" height="10.8" fill="currentColor" stroke="none" opacity="0.35" />}
          </svg>
        </Button>
    </>
  );
}

export function MetricColumns({
  children,
  rail,
  railHidden,
}: {
  children: ReactNode;
  rail: ReactNode;
  /** Колонка свёрнута: полотно занимает её место. Панель уходит ИЗ ПОТОКА, а не прячется
      прозрачностью — иначе широкий график остался бы обрезанным по прежней сетке.
      По умолчанию состояние берётся из общего хранилища: переключатель стоит в шапке страницы, и
      требовать от каждой из шести страниц метрик прокидывать одно и то же значение значило бы
      снова развести одну настройку по шести копиям. */
  railHidden?: boolean;
}) {
  const storedHidden = useMetricRailHidden();
  const hidden = railHidden ?? storedHidden;
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-6 xl:gap-8',
        !hidden && 'lg:grid-cols-[minmax(0,1fr)_300px]',
      )}
    >
      <div className="min-w-0 space-y-6">{children}</div>
      {/* Ниже lg колонка остаётся ВСЕГДА: там она под графиком и места у него не отнимает, а
          вместе с ней ушли бы сравнение, цели и разбивка — без всякой выгоды по ширине. */}
      <aside className={cn('space-y-6', hidden && 'lg:hidden')}>{rail}</aside>
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
/**
 * ИТОГ ОКНА В РЕЙЛЕ СРАВНЕНИЯ — одна разметка на все вертикали (аудит #554, D12).
 *
 * После тихой шапки итог окна — доминанта рейла, и обе страницы это записали в комментариях
 * одними словами — а рисовали по-разному: TG крупным KpiValue под подписью, IG — `text-base`
 * в одну строку с подписью, то есть очередной копией рецепта крупного числа мимо KpiValue.
 */
export function RailWindowTotal({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
      <KpiValue size="compact" text={value} className="mt-1 text-foreground" />
    </div>
  );
}

export function WindowBarShell({ label = 'Окно', children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
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
