import { useId, useLayoutEffect, useRef, useState } from 'react';
import type * as React from 'react';
import type { CSSProperties } from 'react';
import { observeSize } from '@/lib/observeSize';
import { DEFAULT_WIDGET_DAYS, usePagePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { useChannels } from '@/api/queries';
import { PillSelect } from '@/components/PillSelect';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { SwatchButton } from '@/components/ui/swatch-button';
import type { SeriesGrain, WidgetPrefs, WidgetSize } from '@/lib/widgetPrefsStore';
import { SIZE_RANK, type WidgetVariant } from '@/components/widgets/variants';

const SWATCHES = [1, 2, 3, 4, 5, 6] as const;

export const WIDGET_PERIODS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];


/** The edit dialog's «Период» segment — the same follow/override semantics as the card's pill
    row, in the dialog's bordered-segment form. Split out so it can call usePagePeriod itself. */
function DialogPeriodSegment({
  prefs,
  onChange,
}: {
  prefs: WidgetPrefs;
  onChange: (next: WidgetPrefs) => void;
}) {
  const pagePeriod = usePagePeriod();
  const following = prefs.period === undefined && pagePeriod != null;
  // «Стр.» (follow-page) + the presets are one mutually-exclusive set, so they ride the shared
  // shared shadcn/Radix ToggleGroup primitive.
  const value = following ? 'follow' : String(prefs.period ?? DEFAULT_WIDGET_DAYS);
  const options = [
    ...(pagePeriod != null
      ? ([{ value: 'follow', content: 'Стр.', title: 'Следовать периоду страницы' }] as const)
      : []),
    ...WIDGET_PERIODS.map((p) => ({ value: String(p.days), content: p.label })),
  ];
  return (
    <SegmentedControl
      ariaLabel="Период виджета"
      className="mt-2 w-full"
      segmentClassName="px-2 tabular-nums"
      value={value}
      onChange={(next) => onChange({ ...prefs, period: next === 'follow' ? undefined : (Number(next) as PeriodDays) })}
      options={options}
    />
  );
}

// ── Edit dialog (steep «Edit widget»): title + accent + tinted background ─────────────────
export interface EditWidgetDialogProps {
  defaultTitle: string;
  prefs: WidgetPrefs;
  variants?: WidgetVariant[];
  /** Show the «Период» segment — only for cards that read useWidgetPeriod() (see periodControl). */
  showPeriod?: boolean;
  /** Show the daily-series options (Грануляция / Включая сегодня / Целевой уровень) —
      only for cards that opted in via `seriesOptions` (their variants consume the opts). */
  showSeries?: boolean;
  /** Show the «Источник» select — cross-source surfaces only (Home cards; the feeds follow
      the switcher by design). */
  showSource?: boolean;
  /** Show the «Размер» segment — only inside a WidgetGroup (a lone card can't be resized). */
  showSize?: boolean;
  /** The card's size when the user hasn't chosen one (defaultSize prop, else 'half'). */
  defaultSize?: WidgetSize;
  /** Metric-identity accent shown by the standard swatch when no override is stored. */
  defaultColor?: number;
  /** «Цветной фон» of the card when the user hasn't chosen one (see defaultWidgetTint) — the
      switch must show what the card actually renders, not a hardcoded «on». */
  defaultTinted: boolean;
  /** Active variant's floor — sizes below it are disabled (the variant needs the width). */
  minSize?: WidgetSize;
  onChange: (next: WidgetPrefs) => void;
  onClose: () => void;
}

const SIZE_OPTIONS: Array<{ size: WidgetSize; label: string }> = [
  { size: 'third', label: 'S' },
  { size: 'half', label: 'M' },
  { size: 'full', label: 'L' },
];

// Carousel geometry — must match the Tailwind classes on the cards (w-56, gap-3).
const CAROUSEL_CARD_W = 224;
const CAROUSEL_GAP = 12;

/**
 * Variant picker as a steep-style carousel: live preview cards on a translated track
 * (active card centered, neighbours peeking), ‹ › arrows, dot pagination, pointer swipe.
 * The centered card IS the chosen presentation — arrows/dots/card clicks all select.
 */
function VariantCarousel({
  variants,
  prefs,
  tinted,
  onChange,
}: {
  variants: WidgetVariant[];
  prefs: WidgetPrefs;
  /** Effective «цветной фон» of the live card, so the preview matches it. */
  tinted: boolean;
  onChange: (prefs: WidgetPrefs) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(0);
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => setViewportW(node.clientWidth);
    measure();
    return observeSize(node, measure);
  }, []);

  const activeKey = prefs.variant ?? variants[0].key;
  const activeIdx = Math.max(
    0,
    variants.findIndex((v) => v.key === activeKey),
  );
  const select = (i: number) => {
    const next = Math.min(variants.length - 1, Math.max(0, i));
    onChange({ ...prefs, variant: variants[next].key === variants[0].key ? undefined : variants[next].key });
  };

  // Pointer swipe flips to the neighbour; a real drag suppresses the card's click-select.
  const dragStartX = useRef<number | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    dragStartX.current = e.clientX;
    dragged.current = false;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragStartX.current == null) return;
    const delta = e.clientX - dragStartX.current;
    dragStartX.current = null;
    if (Math.abs(delta) > 40) {
      dragged.current = true;
      select(activeIdx + (delta < 0 ? 1 : -1));
    }
  };

  // Center the active card: track shift = half viewport − half card − active offset.
  const offset = viewportW / 2 - CAROUSEL_CARD_W / 2 - activeIdx * (CAROUSEL_CARD_W + CAROUSEL_GAP);

  const arrowCls =
    'absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground sm:h-7 sm:w-7';

  return (
    <div>
      <div className="relative">
        <button
          type="button"
          data-mobile-touch-target=""
          aria-label="Предыдущий тип"
          disabled={activeIdx === 0}
          onClick={() => select(activeIdx - 1)}
          className={`${arrowCls} left-1`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          data-mobile-touch-target=""
          aria-label="Следующий тип"
          disabled={activeIdx === variants.length - 1}
          onClick={() => select(activeIdx + 1)}
          className={`${arrowCls} right-1`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <div
          ref={viewportRef}
          className="touch-pan-y overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <div
            className={`flex gap-3 motion-reduce:transition-none ${
              viewportW > 0 ? 'transition-transform dur-reveal ease-house' : ''
            }`}
            style={{ transform: `translateX(${offset}px)` }}
          >
            {variants.map((v, i) => {
              const active = i === activeIdx;
              // Wide (minSize:'full') variants preview at half the scale so the whole
              // chart+ledger row fits the same w-56 preview card.
              const wide = v.minSize === 'full';
              const previewStyle: CSSProperties = {};
              if (prefs.color) {
                // Same three tokens as the live card (see accentVars): role aliases resolve on
                // their declaring element, so the preview must re-declare them too.
                const acc = `var(--chart-${prefs.color}-accent)`;
                Object.assign(previewStyle as Record<string, string>, {
                  '--brand-iris': acc,
                  '--chart-role-primary': acc,
                  '--chart-role-selection': acc,
                });
              }
              if (tinted)
                previewStyle.backgroundColor = `hsl(var(${prefs.color ? `--chart-${prefs.color}-accent` : '--card-tint'}) / 0.07)`;
              return (
                <button
                  key={v.key}
                  type="button"
                  aria-pressed={active}
                  aria-label={`Тип виджета: ${v.label}`}
                  onClick={() => {
                    if (dragged.current) {
                      dragged.current = false;
                      return;
                    }
                    select(i);
                  }}
                  className={`w-56 shrink-0 overflow-hidden rounded-lg border text-left transition-[opacity,transform,border-color] dur-reveal ease-house motion-reduce:transition-none ${
                    active
                      ? 'border-primary ring-1 ring-primary/40'
                      : 'scale-[0.96] opacity-60 border-border hover:opacity-90'
                  }`}
                >
                  <div aria-hidden="true" className="pointer-events-none h-32 overflow-hidden bg-card" style={previewStyle}>
                    <div
                      className="p-3"
                      style={
                        wide
                          ? { width: 896, transform: 'scale(0.25)', transformOrigin: 'top left' }
                          : { width: 448, transform: 'scale(0.5)', transformOrigin: 'top left' }
                      }
                    >
                      {v.render}
                    </div>
                  </div>
                  <div
                    className={`border-t px-2.5 py-1.5 text-xs font-medium ${
                      active ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground'
                    }`}
                  >
                    {v.label}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {/* Dot pagination — one per presentation, the active one stretched. */}
      <div className="mt-2.5 flex justify-center gap-0 sm:gap-1.5">
        {variants.map((v, i) => (
          <button
            key={v.key}
            type="button"
            data-mobile-touch-target=""
            aria-label={`Тип ${i + 1}: ${v.label}`}
            aria-current={i === activeIdx || undefined}
            onClick={() => select(i)}
            // The visual dot stretches inside a fixed 44px phone target; ≥sm restores the original
            // compact pagination geometry.
            className={`group flex h-11 w-11 items-center justify-center rounded-full sm:h-1.5 ${
              i === activeIdx ? 'sm:w-4' : 'sm:w-1.5'
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 rounded-full transition-[width,background-color] dur-fast ease-house motion-reduce:transition-none ${
                i === activeIdx ? 'w-4 bg-primary' : 'w-1.5 bg-border group-hover:bg-ink3/60'
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

const GRAIN_OPTIONS: Array<{ value: SeriesGrain; label: string }> = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
];

/** «Источник» — pin the widget to a fixed channel (default: follow the switcher). Offered on
    cross-source surfaces (Home); standalone Instagram sources are excluded — the Home catalog
    is TG-data widgets, an IG-only source would render them honestly empty. */
function SourceSelect({ prefs, onChange }: { prefs: WidgetPrefs; onChange: (next: WidgetPrefs) => void }) {
  const sourceId = useId();
  const channels = useChannels();
  const list = (channels.data?.channels ?? []).filter((c) => c.source !== 'ig');
  return (
    <label htmlFor={sourceId} className="mt-4 block">
      <span className="text-2xs tracking-wide text-muted-foreground">Источник</span>
      <div className="mt-1">
        <PillSelect
          id={sourceId}
          ariaLabel="Источник"
          className="w-full"
          value={String(prefs.source ?? '')}
          options={[
            { value: '', label: 'Как в свитчере' },
            ...list.map((c) => ({
              value: String(c.id),
              label: c.title || (c.username ? `@${c.username}` : `Канал ${c.id}`),
            })),
          ]}
          onValueChange={(v) => onChange({ ...prefs, source: v === '' ? undefined : Number(v) })}
        />
      </div>
    </label>
  );
}

export function EditWidgetDialog({ defaultTitle, prefs, variants, showPeriod, showSeries, showSource, showSize, defaultSize = 'half', defaultColor, defaultTinted, minSize = 'third', onChange, onClose }: EditWidgetDialogProps) {
  // Сохранённый выбор пользователя главнее дефолта карточки (тот уже посчитан хостом).
  const tinted = prefs.tinted ?? defaultTinted;
  const titleRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={variants && variants.length > 1 ? 'max-w-lg' : 'max-w-sm'}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogTitle>{`Настройка виджета «${prefs.title || defaultTitle}»`}</DialogTitle>

        {variants && variants.length > 1 && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Тип виджета</span>
            {/* Live preview cards on a steep-style carousel: the centered card is the active
                presentation; each renders for real, scaled down, and inherits accent/tint. */}
            <div className="mt-2">
              <VariantCarousel variants={variants} prefs={prefs} tinted={tinted} onChange={onChange} />
            </div>
          </div>
        )}

        {showSize && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Размер</span>
            {/* S / M / L on the 6-col grid. Selecting the card's defaultSize
                clears the pref (fall back to the default). Sizes below the active variant's
                floor are disabled — that presentation needs the width. */}
            <div className="mt-2 flex overflow-hidden rounded-full border border-border">
              {(() => {
                // Highlight the EFFECTIVE size (a full-only variant clamps the card up even when
                // the stored/default is smaller) — never a disabled button that the card ignores.
                const chosen = prefs.size ?? defaultSize;
                const shownSize = SIZE_RANK[chosen] < SIZE_RANK[minSize] ? minSize : chosen;
                return SIZE_OPTIONS.map((o) => {
                const active = shownSize === o.size;
                const disabled = SIZE_RANK[o.size] < SIZE_RANK[minSize];
                return (
                  <button
                    key={o.size}
                    type="button"
                    data-mobile-touch-target=""
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => onChange({ ...prefs, size: o.size === defaultSize ? undefined : o.size })}
                    className={`min-h-11 flex-1 border-r border-border px-2 py-1.5 text-xs font-medium transition-colors last:border-r-0 disabled:pointer-events-none disabled:opacity-40 sm:min-h-0 ${
                      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                );
                });
              })()}
            </div>
          </div>
        )}

        {showSource && <SourceSelect prefs={prefs} onChange={onChange} />}

        <label className="mt-4 block">
          <span className="text-2xs tracking-wide text-muted-foreground">Заголовок</span>
          <input
            data-mobile-touch-target=""
            ref={titleRef}
            value={prefs.title ?? ''}
            placeholder={defaultTitle}
            onChange={(e) => onChange({ ...prefs, title: e.target.value || undefined })}
            className="mt-1 min-h-11 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:min-h-0"
          />
        </label>

        {showPeriod && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Период</span>
            {/* Presets only for now (per-widget custom range is a noted follow-up). Same semantics
                as the card's pill row: a number is ALWAYS an explicit override; «Стр.» (only on
                page-period feeds) clears it so the card follows the page again. */}
            <DialogPeriodSegment prefs={prefs} onChange={onChange} />
          </div>
        )}

        {showSeries && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Грануляция</span>
            {/* Bucket the daily series by week/month (sums). День clears the pref. */}
            <SegmentedControl
              ariaLabel="Грануляция виджета"
              className="mt-2 w-full"
              segmentClassName="px-2"
              value={prefs.grain ?? 'day'}
              onChange={(next) => onChange({ ...prefs, grain: next === 'day' ? undefined : next })}
              options={GRAIN_OPTIONS.map((g) => ({ value: g.value, content: g.label }))}
            />
          </div>
        )}

        {showSeries && (
          <label className="mt-4 block">
            <span className="text-2xs tracking-wide text-muted-foreground">Целевой уровень</span>
            {/* Draws a dashed goal line on the widget's line charts. Empty = none. */}
            <input
              data-mobile-touch-target=""
              type="number"
              inputMode="numeric"
              min={0}
              value={prefs.target ?? ''}
              placeholder="нет"
              onChange={(e) => {
                const raw = e.target.value.trim();
                const num = raw === '' ? undefined : Number(raw);
                onChange({ ...prefs, target: num !== undefined && Number.isFinite(num) && num > 0 ? num : undefined });
              }}
              className="mt-1 min-h-11 w-full rounded border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:min-h-0"
            />
          </label>
        )}

        {showSeries && (
          <div className="mt-4 flex w-full items-center justify-between gap-2 text-sm text-muted-foreground">
            <label htmlFor="widget-include-today">Включая сегодня</label>
            <Switch
              id="widget-include-today"
              checked={prefs.includeToday !== false}
              onCheckedChange={(checked) => onChange({ ...prefs, includeToday: checked ? undefined : false })}
            />
          </div>
        )}

        <div className="mt-4">
          <span className="text-2xs tracking-wide text-muted-foreground">Акцент</span>
          <div className="mt-2 flex items-center gap-2">
            <SwatchButton
              aria-label="Стандартный акцент"
              aria-pressed={!prefs.color}
              onClick={() => onChange({ ...prefs, color: undefined })}
              // Дефолт хоста красится общим слотом --accent-card (он следует акценту темы), а не
              // номерным --chart-N-accent: свотч обязан показывать тот же цвет, что и карточка.
              color={defaultColor ? 'hsl(var(--accent-card))' : 'hsl(var(--primary))'}
              selected={!prefs.color}
            />
            {SWATCHES.map((n) => (
              <SwatchButton
                key={n}
                aria-label={`Акцент ${n}`}
                aria-pressed={prefs.color === n}
                onClick={() => onChange({ ...prefs, color: n })}
                color={`hsl(var(--chart-${n}-accent))`}
                selected={prefs.color === n}
              />
            ))}
          </div>
        </div>

        <div className="mt-4 flex w-full items-center justify-between gap-2 text-sm text-muted-foreground">
          <label htmlFor="widget-tinted">Цветной фон</label>
          <Switch
            id="widget-tinted"
            checked={tinted}
            onCheckedChange={(checked) => onChange({ ...prefs, tinted: checked })}
          />
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-border pt-3">
          <button
            type="button"
            data-mobile-touch-target=""
            onClick={() => onChange({ hidden: prefs.hidden })}
            className="inline-flex min-h-11 items-center px-2 text-xs text-muted-foreground transition-colors hover:text-foreground sm:min-h-0"
          >
            Сбросить
          </button>
          <Button type="button" onClick={onClose} size="sm" className="px-4 text-sm">
            Готово
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
