/**
 * Общие листовые элементы metric-страниц (/metrics/*). Каркас этих страниц исторически
 * скопирован по вертикалям (TG/IG/MS/кампании/упоминания/Метрика) — см. очередь в
 * PROJECT_MEMORY; сюда выносится то, что уже дословно совпадает во всех копиях, чтобы
 * новая вертикаль не клонировала разметку дальше.
 */

import type { ReactNode } from 'react';

/** Каноническая rail-секция metric-страницы: плоский заголовок с hairline (канон «ничего не
    кричит», без card-рамки). `mark` → `data-rail-card` — на него смотрят e2e (interactions.spec). */
export function RailSection({ title, mark, children }: { title: string; mark?: string; children: ReactNode }) {
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

/** Строка «Изменение» comparison-rail'а: ▲/▼ + |Δ|% в verdant/ember. Формулу дельты считает
    страница (семантики окон различаются) — здесь только каноничная отрисовка, чтобы rail'ы
    вертикалей не расходились по глифам, цветам и точности. */
export function ComparisonDeltaRow({ delta }: { delta: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
      <span className="text-xs text-muted-foreground">Изменение</span>
      <span className={`text-xs font-medium tabular-nums ${delta >= 0 ? 'text-verdant' : 'text-ember'}`}>
        {delta >= 0 ? '▲' : '▼'}
        {Math.abs(delta).toFixed(1)}%
      </span>
    </div>
  );
}
