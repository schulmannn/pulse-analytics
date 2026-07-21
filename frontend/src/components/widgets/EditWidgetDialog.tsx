import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { observeSize } from '@/lib/observeSize';
import { DEFAULT_WIDGET_DAYS, usePagePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useChannels } from '@/api/queries';
import { PillSelect } from '@/components/PillSelect';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Switch } from '@/components/ui/switch';
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
  // sliding-glider primitive.
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
  onChange,
}: {
  variants: WidgetVariant[];
  prefs: WidgetPrefs;
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
    'absolute top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground';

  return (
    <div>
      <div className="relative">
        <button
          type="button"
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
              viewportW > 0 ? 'transition-transform duration-300 ease-out' : ''
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
              if (prefs.tinted ?? true)
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
                  className={`w-56 shrink-0 overflow-hidden rounded-lg border text-left transition-[opacity,transform,border-color] duration-300 motion-reduce:transition-none ${
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
      <div className="mt-2.5 flex justify-center gap-1.5">
        {variants.map((v, i) => (
          <button
            key={v.key}
            type="button"
            aria-label={`Тип ${i + 1}: ${v.label}`}
            aria-current={i === activeIdx || undefined}
            onClick={() => select(i)}
            className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${
              i === activeIdx ? 'w-4 bg-primary' : 'w-1.5 bg-border hover:bg-ink3/60'
            }`}
          />
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
  const channels = useChannels();
  const list = (channels.data?.channels ?? []).filter((c) => c.source !== 'ig');
  return (
    <label className="mt-4 block">
      <span className="text-2xs tracking-wide text-muted-foreground">Источник</span>
      <div className="mt-1">
        <PillSelect
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

export function EditWidgetDialog({ defaultTitle, prefs, variants, showPeriod, showSeries, showSource, showSize, defaultSize = 'half', defaultColor, minSize = 'third', onChange, onClose }: EditWidgetDialogProps) {
  // Modal focus contract. The trap's effect must run BEFORE the title-focus effect (declaration
  // order) so it snapshots the real opener; an `autoFocus` attribute would fire during commit —
  // before the trap — corrupting the opener snapshot and then losing focus to panel.focus().
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useFocusTrap(panelRef);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-background/70 p-4 backdrop-blur-xs backdrop-grayscale"
      role="dialog"
      aria-modal="true"
      aria-label={`Настройка виджета «${prefs.title || defaultTitle}»`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`max-h-[85vh] w-full ${variants && variants.length > 1 ? 'max-w-lg' : 'max-w-sm'} overflow-y-auto rounded-xl border border-border bg-card p-5 focus:outline-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-foreground">Настройка виджета</div>

        {variants && variants.length > 1 && (
          <div className="mt-4">
            <span className="text-2xs tracking-wide text-muted-foreground">Тип виджета</span>
            {/* Live preview cards on a steep-style carousel: the centered card is the active
                presentation; each renders for real, scaled down, and inherits accent/tint. */}
            <div className="mt-2">
              <VariantCarousel variants={variants} prefs={prefs} onChange={onChange} />
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
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => onChange({ ...prefs, size: o.size === defaultSize ? undefined : o.size })}
                    className={`flex-1 border-r border-border px-2 py-1.5 text-xs font-medium transition-colors last:border-r-0 disabled:pointer-events-none disabled:opacity-40 ${
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
            ref={titleRef}
            value={prefs.title ?? ''}
            placeholder={defaultTitle}
            onChange={(e) => onChange({ ...prefs, title: e.target.value || undefined })}
            className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
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
              className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
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
            <button
              type="button"
              aria-label="Стандартный акцент"
              aria-pressed={!prefs.color}
              onClick={() => onChange({ ...prefs, color: undefined })}
              className={`h-5 w-5 rounded-full transition-shadow ${!prefs.color ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: defaultColor ? `hsl(var(--chart-${defaultColor}-accent))` : 'hsl(var(--primary))' }}
            />
            {SWATCHES.map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Акцент ${n}`}
                aria-pressed={prefs.color === n}
                onClick={() => onChange({ ...prefs, color: n })}
                className={`h-5 w-5 rounded-full transition-shadow ${prefs.color === n ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
                style={{ backgroundColor: `hsl(var(--chart-${n}-accent))` }}
              />
            ))}
          </div>
        </div>

        <div className="mt-4 flex w-full items-center justify-between gap-2 text-sm text-muted-foreground">
          <label htmlFor="widget-tinted">Цветной фон</label>
          <Switch
            id="widget-tinted"
            checked={prefs.tinted ?? true}
            onCheckedChange={(checked) => onChange({ ...prefs, tinted: checked })}
          />
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-border pt-3">
          <button
            type="button"
            onClick={() => onChange({ hidden: prefs.hidden })}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Сбросить
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-pill bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Готово
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
