import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CSSProperties, ReactNode } from 'react';
import { observeSize } from '@/lib/observeSize';
import { DeltaPill } from '@/components/DeltaPill';
import type { MetricDelta } from '@/lib/delta';
import { ChartExpandOverlay, ExpandedChartHeightContext, WidgetTargetContext, type ChartExpandConfig } from '@/components/ExpandableChart';
import { WidgetErrorBoundary, ThrowInRender } from '@/components/WidgetErrorBoundary';
import { DEFAULT_WIDGET_DAYS, WidgetPeriodProvider, widgetPeriodValue, useChannelRecency, resolveEffectivePeriod, usePagePeriod } from '@/lib/period';
import { HomeEditContext, pinToHome, setPrefs, unpinFromHome, useIsPinnedToHome, useWidgetPrefs } from '@/lib/widgetPrefsStore';
import { useExitPresence } from '@/lib/useExitPresence';
import type { PeriodDays, WidgetPeriodValue } from '@/lib/period';
import type { SeriesGrain, WidgetPrefs, WidgetSeriesOpts, WidgetSize } from '@/lib/widgetPrefsStore';
import { EditWidgetDialog, WIDGET_PERIODS } from '@/components/widgets/EditWidgetDialog';
import { GroupCtx, prefersReducedMotion } from '@/components/widgets/WidgetGroup';
import { maxSize, type WidgetVariant } from '@/components/widgets/variants';

/**
 * Widget system for charts (steep Home): every chart is a card with a «⋯» menu — reorder
 * (Выше/Ниже within its WidgetGroup, applied via CSS order; or jiggle mode, where the card
 * follows the pointer and siblings FLIP-glide aside), Изменить (an edit dialog:
 * custom title, accent colour, tinted background) and Скрыть (with a restore bar under the
 * group). The accent works by scoping the `--brand-iris` CSS var over the widget subtree,
 * so every chart primitive (LineChart / BarChart / Sparkline / Breakdown) recolours without
 * prop plumbing. Prefs + ordering persist in localStorage.
 *
 * The card surface intentionally supersedes the flat hairline section for CHARTS (owner
 * call, steep pattern); KPI ledgers and tables stay open on the paper canvas.
 */

/** col-span on the 6-col grid — the steep row model (owner call): 33% · 66% · 100%. A row is
    three thirds, or a third beside a half (66%); the old 50/50 pair is gone. Stored pref KEYS
    are unchanged ('half' now MEANS 66%), so existing user layouts migrate by themselves. */
const SIZE_COL_SPAN: Record<WidgetSize, string> = {
  third: 'lg:col-span-2',
  half: 'lg:col-span-4',
  full: 'lg:col-span-6',
};

/** Fixed card height per size on the ≥lg grid (steep tiles) — so a row never mixes a tall card
    with a short one and the chart body fills the leftover space instead of leaving пустоты.
    `third`/`half` SHARE rows (2/6 + 3/6 pack together), so they lock to ONE exact height and stay
    aligned whatever they hold. `full` spans the whole row — it never shares one, so it needs no
    fixed height and stays content-height (hero KPI grids, post tables and bar+ledger self-size;
    a forced height would only pad short ones). Two half rows (264·2 + gap) clear a ~800px viewport
    under the KPI ledger + tabs. Mobile is single-column — no row-mates — so heights apply from lg up. */
// Fixed at EVERY breakpoint (not just lg): below lg the grid collapses to one column and a card with
// no bounded height let its flex-1 body grow with the chart it measures — a measure→height→content
// feedback loop that ran a chart to tens of thousands of px around ~900px width. A fixed card height
// bounds the body (overflow-y-auto scrolls the surplus), killing the loop on mobile/tablet too.
const SIZE_H: Record<WidgetSize, string> = {
  third: 'h-[264px]',
  half: 'h-[264px]',
  full: '',
};

// ── The widget card ───────────────────────────────────────────────────────────────────────
// Edit-mode «×» leave beat — MUST match the `home-remove-exit` CSS animation (var(--motion-fast),
// 200ms). The JS timer only decides WHEN the button unmounts; the CSS owns the visible motion.
const REMOVE_EXIT_MS = 200;

interface ChartSectionProps {
  /** Stable widget id for the prefs store; defaults to the title. */
  id?: string;
  title: string;
  /** Extra header controls (e.g. the chart-type switcher) between the title and the menu. */
  action?: ReactNode;
  /**
   * Alternative presentations (line / bar / list) selectable in the edit dialog. Either a static
   * array, or a FUNCTION of the card's own window — post-derived charts pass the function form so
   * their series recompute for THIS card's period (the fn runs with the widget's WidgetPeriodValue).
   */
  variants?: WidgetVariant[] | ((period: WidgetPeriodValue, series: WidgetSeriesOpts) => WidgetVariant[]);
  /** Extra classes on the card (grid spans etc.). */
  className?: string;
  /** Footprint this card takes when the user hasn't chosen one — 'full' for hero/table cards
      that want the whole row, else 'half' (the default). Still clamped up by the active
      variant's minSize. */
  defaultSize?: WidgetSize;
  /** Жёсткий размер поверхности: игнорирует сохранённый user-pref и прячет «Размер» в редакторе.
      Для карточек, чей ряд не должен уметь выглядеть сломанным (нарратив на IG-Обзоре: треть
      ширины + 2/3 пустого ряда читались как баг). Home-пин той же карточки живёт под другим id
      и остаётся ресайзабельным. */
  fixedSize?: WidgetSize;
  /** RICH (Tier-2) explorer config for the «Развернуть» overlay: period pills, line↔bar
      toggle, stats strip. Undefined = Tier-1 — the overlay renders the widget's own body
      (active variant or children) at full explorer axes. */
  expand?: ChartExpandConfig;
  /**
   * Route of this metric's dedicated explorer page (e.g. '/metrics/views'). ONE drill contract
   * for every chart card: when set, EVERY expand affordance — the whole-card click, the ↗
   * button, the «Развернуть» menu item — navigates there instead of opening the generic
   * overlay. The metric page IS the richer expanded view (breakdown · comparison · about ·
   * chart types), so a card whose metric has a page must never fork into the poorer fullscreen.
   * Cards without a metric page keep the ChartExpandOverlay via `expand`.
   */
  drillTo?: string;
  /**
   * Drop EVERY expand affordance (↗, the «Развернуть» menu item, the whole-card click, the
   * ?detail= overlay). For cards that ARE the expanded view already — the metric-page chart and
   * its rail — where a Tier-1 overlay would just re-render the same content in a dialog.
   */
  noExpand?: boolean;
  /**
   * Opt into the per-widget period control (header pill row + the «Период» segment in the edit
   * dialog). ONLY for cards whose body actually reads useWidgetPeriod() — the wired Overview /
   * TgAnalytics widgets. Off by default so cards that still read the global period (IG / Compare /
   * Posts / metric-page / report) don't grow a dead control.
   */
  periodControl?: boolean;
  /** STRIP contract (thin full-width summary rows): no card chrome, forced full span,
      content height, menu limited to Выше/Ниже/Переставить/Скрыть. */
  strip?: boolean;
  /**
   * Personal-Home registry key (e.g. 'kpi'). When set, the ⋯ menu grows a «На главную» /
   * «Убрать с главной» toggle that pins/unpins this widget on /home. Pass it on the SOURCE-screen
   * ChartSection so the pin originates where the user browses; the Home render passes the same key
   * (under its `home-<key>` id) so its menu reads «Убрать с главной» for an in-place unpin.
   */
  homeKey?: string;
  /**
   * Opt into the daily-series display options (steep Edit-widget parity): «Грануляция»
   * (день/неделя/месяц), «Включая сегодня» and «Целевой уровень» in the edit dialog. ONLY for
   * cards whose function-form `variants` actually consume the WidgetSeriesOpts argument —
   * otherwise the controls would be dead.
   */
  seriesOptions?: boolean;
  /**
   * Config-driven widgets (the metric builder): the ⋯«Изменить» opens THIS editor (owned by
   * ConfigWidget, writing to a WidgetConfig) instead of the legacy prefs dialog, and the card's
   * accent / background / size come from the config via these overrides rather than the prefs
   * store. Undefined = a normal prefs-driven card (unchanged behaviour).
   */
  configEditor?: {
    open: () => void;
    color?: number;
    tinted?: boolean;
    size?: WidgetSize;
    /** Goal line for the widget's charts (config.target, fixed goals only in S5). */
    target?: number | null;
  };
  /** A custom full-screen explorer for «Развернуть» — when set, it fully replaces the generic
   *  ChartExpandOverlay (config-widgets pass a mutable-config sandbox). Receives a `close` callback. */
  explorer?: (close: () => void, originRect?: DOMRect | null) => ReactNode;
  /** A signature of the body's inputs (config-widgets pass their WidgetConfig identity). When it
   *  changes, the per-widget error boundary around the body clears a caught error and re-renders —
   *  so reconfiguring a crashed widget recovers it without a manual «Повторить». */
  bodyResetKey?: unknown;
  /** Body; with `variants` it renders BELOW the active variant (shared captions etc.). */
  children?: ReactNode;
}

export function ChartSection({ id, title, action, variants, className, defaultSize, fixedSize, expand, drillTo, noExpand, periodControl, strip, homeKey, seriesOptions, configEditor, explorer, bodyResetKey, children }: ChartSectionProps) {
  const widgetId = id ?? title;
  const group = useContext(GroupCtx);
  const homeEditing = useContext(HomeEditContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // The detail overlay's open state lives in the URL (?detail=<widgetId>) so it is shareable and the
  // browser Back button closes it (steep). Deriving it from searchParams — not local state — means
  // Back / forward / a shared link all Just Work: open pushes a history entry, close replaces it away.
  const [searchParams, setSearchParams] = useSearchParams();
  const expandOpen = searchParams.get('detail') === widgetId;
  // Card footprint at click time — lets the detail overlay grow OUT of this card (shared-element).
  // Captured before the URL flips; stays null for URL / back-forward / shared-link opens (no morph).
  const originRectRef = useRef<DOMRect | null>(null);
  // Whole-card click drag guard: a press that travelled >5px before release is a drag-to-read
  // scrub over a chart, not a tap — without this, selecting/scrubbing the plot would drill.
  const cardPressRef = useRef<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  const openExpand = useCallback(() => {
    // The drill contract: a card whose metric has a dedicated page expands INTO that page —
    // one destination for every affordance (whole card, ↗, menu). See ChartSectionProps.drillTo.
    if (drillTo) {
      navigate(drillTo);
      return;
    }
    originRectRef.current = sectionRef.current?.getBoundingClientRect() ?? null;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('detail', widgetId);
        return next;
      },
      { replace: false },
    );
  }, [setSearchParams, widgetId, drillTo, navigate]);
  const closeExpand = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('detail');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  // Detail-open is URL-driven, and the browser BACK button closes the overlay WITHOUT running
  // closeExpand — so clearing the captured rect there would miss it and a later FORWARD (or any
  // non-click reopen) would morph from a stale, possibly off-screen footprint. Clear on every
  // transition to CLOSED instead: capture stays in openExpand (this no-ops while open, so the click
  // rect survives), and any close path → next non-click open sees originRect=null → plain appear.
  useEffect(() => {
    if (!expandOpen) originRectRef.current = null;
  }, [expandOpen]);
  const menuRef = useRef<HTMLDivElement>(null);
  // The ⋯ trigger — menu items refocus it when the menu closes under keyboard focus (Escape / item
  // click unmounts the focused item, which would otherwise drop focus to <body>).
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // The chart-body region (flex-1 inside the fixed-height card). We feed its measured pixel
  // height to the charts inside so they fill the tile (steep) — see the effect + fillHeight below.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyH, setBodyH] = useState<number | null>(null);

  // Depend on the STABLE register callback, not the ctx object (recreated every group
  // render) — otherwise the cleanup/register cycle feeds the group's state in a loop.
  const register = group?.register;
  useEffect(() => register?.(widgetId, title, sectionRef.current), [register, widgetId, title]);

  // Measure the body region so the charts inside fill the fixed tile height. The region is flex-1
  // inside a fixed-height card, so its clientHeight IS the space left after header/pills/caption —
  // no per-card height guesswork. A vertical scrollbar (long lists) trims width, never height, so
  // this never feedback-loops. null until measured → charts fall back to their own default height.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Defensive cap: a tile body is never legitimately taller than ~640px, so an absurd measurement
    // means the card is unbounded and the chart is chasing its own height — feed null (chart falls
    // back to its own default) rather than a runaway value. Belt-and-braces alongside the fixed
    // card height, so no future layout change can reintroduce the feedback loop.
    const measure = () => {
      const h = el.clientHeight;
      setBodyH(h > 0 && h < 640 ? h : null);
    };
    measure();
    return observeSize(el, measure);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        // APG menu button: Escape returns focus to the trigger (the focused item is unmounting).
        menuBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Selector subscriptions (not a whole-store tick): this card re-renders when ITS prefs row or
  // ITS pin state changes — another widget's hide/reorder/edit no longer re-renders every card
  // on the surface (with N cards that was O(N) re-renders × variant recompute per click).
  const prefs = useWidgetPrefs(widgetId);
  const update = (next: WidgetPrefs) => setPrefs(widgetId, next);

  // Personal-Home pin state (only when this card is registered as pinnable via `homeKey`).
  const pinned = useIsPinnedToHome(homeKey);
  // On /home in edit mode, a pinnable card shows a × that removes it from Home. Its mount is kept
  // for one exit beat after «Готово» so the × fades/scales OUT instead of teleporting (edit-mode
  // choreography). `exiting` drives the leave class; the expand ↗ stays hidden until it's fully gone.
  const showHomeRemove = homeEditing && !!homeKey;
  const removePresence = useExitPresence(showHomeRemove, prefersReducedMotion() ? 0 : REMOVE_EXIT_MS);

  // Per-widget window: the card's own period (default 30д). Charts inside read it via
  // useWidgetPeriod(); the WidgetPeriodProvider below scopes it to this card's subtree.
  // Memoized on the scalar `widgetDays` so `inRange`'s identity is stable across re-renders —
  // consumers key their derive memos on it (a fresh predicate each render would bust them).
  // An explicit per-card override (prefs.period) wins; otherwise the feed-header page period (when a
  // feed provides one) re-windows this untouched card; else the module default (30д). This is the
  // one bridge that makes a single header control drive every card that hasn't been individually set.
  const pagePeriod = usePagePeriod();
  const requestedDays: PeriodDays = prefs.period ?? pagePeriod?.days ?? DEFAULT_WIDGET_DAYS;
  // Auto-widen an empty window: when the feed reports the channel's newest data (useChannelRecency)
  // and the requested window holds none of it, show the smallest window that does. Kills the «0 /
  // нет данных» that a dormant or just-connected channel (all posts months old) shows under 7д/30д.
  // No-op when recency is unknown (outside the feed) or the requested window already has data.
  const channelRecency = useChannelRecency();
  const widgetDays: PeriodDays = useMemo(
    () => resolveEffectivePeriod(requestedDays, channelRecency),
    [requestedDays, channelRecency],
  );
  const periodWidened = periodControl === true && widgetDays !== requestedDays;
  const widgetPeriod = useMemo(() => widgetPeriodValue(widgetDays), [widgetDays]);

  // Resolve variants: the function form recomputes its series for THIS card's window (post-derived
  // charts); the array form is period-agnostic (server-summary / graphs-driven series). Memoized so
  // the (potentially heavy) function form runs once per (variants identity, widget window) — not on
  // every ChartSection re-render (menu open/close, hover, scrollspy, store notify).
  // Display options for grainable series widgets — a stable object so the memo below keys on
  // the two scalars, not a fresh literal every render.
  const seriesGrain: SeriesGrain = prefs.grain ?? 'day';
  const seriesIncludeToday = prefs.includeToday !== false;
  const seriesOpts = useMemo<WidgetSeriesOpts>(
    () => ({ grain: seriesGrain, includeToday: seriesIncludeToday }),
    [seriesGrain, seriesIncludeToday],
  );
  // Function-form variants compute from live data (post-derived charts) DURING this render — a throw
  // there escapes ChartSection itself, ABOVE the in-card body boundary (a React boundary can't catch
  // its own parent's render). Catch it here and re-throw it INSIDE that boundary (via ThrowInRender in
  // the body) so a derive crash becomes THIS widget's fallback instead of blanking the app shell; the
  // card chrome and its real col-span survive (activeVariant is null → the section keeps its chosen
  // size). Array-form variants are already built, so they can't throw here.
  const variantResult = useMemo<
    { ok: true; variants: WidgetVariant[] | undefined } | { ok: false; error: unknown }
  >(() => {
    if (typeof variants !== 'function') return { ok: true, variants };
    try {
      return { ok: true, variants: variants(widgetPeriod, seriesOpts) };
    } catch (error) {
      return { ok: false, error };
    }
  }, [variants, widgetPeriod, seriesOpts]);
  const resolvedVariants = variantResult.ok ? variantResult.variants : undefined;

  const activeVariant =
    resolvedVariants && resolvedVariants.length > 0
      ? (resolvedVariants.find((v) => v.key === prefs.variant) ?? resolvedVariants[0])
      : null;

  // The body content, with a failed variant-compute surfaced as a throw INSIDE the body boundary.
  const variantRender = variantResult.ok
    ? activeVariant?.render ?? null
    : <ThrowInRender error={variantResult.error} />;

  // Effective footprint on the 6-col group grid: the user's choice (or the card's defaultSize,
  // else 'half'), clamped UP to the active variant's minSize so a wide bar+ledger presentation
  // never renders in a third. col-span is applied on the OUTER section below.
  // Config-driven cards source accent / background / size from the WidgetConfig (via configEditor)
  // instead of the prefs store; a normal card reads prefs as before.
  const activeColor = configEditor ? configEditor.color : prefs.color;
  // Tint is default-ON now (a subtle muted wash — see --card-tint). `undefined` → on; an explicit
  // `false` (user turned it off) still wins. The storage layer preserves that false (setPrefs prune +
  // normStyle/legacyConfigSeed), so the opt-out survives reloads and legacy→config migration.
  const activeTinted = (configEditor ? configEditor.tinted : prefs.tinted) ?? true;
  const activeTarget = configEditor ? (configEditor.target ?? null) : (prefs.target ?? null);
  const chosenSize: WidgetSize = fixedSize ?? (configEditor ? configEditor.size : prefs.size) ?? defaultSize ?? 'third';
  const effectiveSize = strip ? 'full' : maxSize(chosenSize, activeVariant?.minSize ?? 'third');
  // Height fed to every chart in the body so it fills the tile. Only for the FIXED sizes
  // (third/half); a `full` card is content-height, so it passes null and charts keep their own
  // height (e.g. KpiHero's deliberate 64px mini-sparkline, the metric page's 280px chart).
  const fillHeight = effectiveSize === 'full' ? null : bodyH;

  // The widget's own body — the active variant plus the shared children (captions etc.). Reused
  // as the Tier-1 overlay content: the same chart, just rendered at full explorer axes. Wrapped
  // in the widget-period provider so every chart primitive inside filters to THIS card's window.
  const bodyNode = (
    <WidgetPeriodProvider value={widgetPeriod}>
      <WidgetTargetContext.Provider value={activeTarget}>
        {variantRender}
        {children}
      </WidgetTargetContext.Provider>
    </WidgetPeriodProvider>
  );
  // The «Развернуть» affordance renders on every widget. Tier-2 (a rich `expand` config)
  // drives its own overlay content; Tier-1 falls back to the widget body.
  const hasRichExpand = !!(expand && (expand.renderExpanded || expand.renderExpandedBar || expand.statsFor));

  // Reset signal for the per-widget error boundary around the body: the body's inputs (config
  // signature, active variant, effective window). A fresh array each render is fine — the boundary
  // compares entries by value, so it only clears a caught error when one of these actually changes.
  const bodyResetKeys = [bodyResetKey, activeVariant?.key ?? null, widgetDays];

  const seqIndex = group ? group.sequence.indexOf(widgetId) : -1;
  // Split the styles across two layers: the OUTER section owns grid placement + the FLIP
  // translate (set imperatively by WidgetGroup), the INNER div owns the visible card —
  // its jiggle rotation is a CSS animation on `transform` and would stomp the FLIP glide
  // if both lived on one element.
  const outerStyle: CSSProperties = {};
  if (seqIndex >= 0) outerStyle.order = seqIndex;
  if (prefs.hidden) outerStyle.display = 'none';

  const reorder = !!group?.reorderMode;
  const isDragging = reorder && group?.draggingId === widgetId;

  const innerStyle: CSSProperties = {};
  // Accent scoping: the widget subtree re-declares every accent-driven token to the RESOLVED
  // accent (--chart-N-accent — the categorical colour in light, a muted steep-pastel in dark).
  // Overriding --brand-iris alone is NOT enough: var() aliases resolve on their DECLARING
  // element (:root), so role consumers (BarChart/LineChart paint --chart-role-primary) never
  // see a subtree-scoped --brand-iris — the roles themselves must be re-declared here too.
  // Declared on the OUTER section so the card, its inline menus and the portal-bound expand
  // overlay (via accentStyle below) share one source; direct --brand-iris readers (Sparkline,
  // .kpi-accent, the tinted surface) inherit the same value.
  const accentVars: Record<string, string> | null = activeColor
    ? {
        '--brand-iris': `var(--chart-${activeColor}-accent)`,
        // Deep companion paints the card's tonal SURFACE (see div[data-widget-tinted]): a pale
        // line colour mixed into near-black can never reach steep's saturation — the fill needs
        // its own chromatic mid-tone of the same hue.
        '--brand-iris-deep': `var(--chart-${activeColor}-accent-deep)`,
        '--chart-role-primary': `var(--chart-${activeColor}-accent)`,
        '--chart-role-selection': `var(--chart-${activeColor}-accent)`,
      }
    : null;
  if (accentVars) Object.assign(outerStyle as Record<string, string>, accentVars);
  // Tinted background. An ACCENTED card paints via CSS (`div[data-widget-tinted]` in index.css):
  // light keeps the top-anchored radial wash, dark goes FLAT tonal (color-mix — steep's even
  // surface). The un-coloured card keeps the neutral --card-tint radial wash inline, both
  // themes (the "noble surface" default), so the default feed look doesn't change.
  if (activeTinted && !activeColor)
    innerStyle.background = `radial-gradient(120% 90% at 50% 0%, hsl(var(--card-tint) / var(--card-tint-alpha)), transparent 62%), hsl(var(--card))`;
  // Entrance stagger: one beat per grid slot, capped so deep feeds don't wait forever.
  (innerStyle as Record<string, string>)['--enter-delay'] = `${Math.min(Math.max(seqIndex, 0), 8) * 35}ms`;
  if (isDragging) {
    // the lifted card stops jiggling and pops slightly (iOS) — the pointer carries it
    innerStyle.animation = 'none';
    innerStyle.transform = 'scale(1.02)';
  } else if (reorder && seqIndex % 2 === 1) {
    // alternate the wobble phase by slot (the old :nth-child(even) died with the 2-layer split)
    innerStyle.animationDuration = '0.37s';
    innerStyle.animationDelay = '0.06s';
  }

  const menuItem =
    'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';
  // Card header affordances (expand / menu / remove) share ONE quiet circular icon-button shape —
  // uniform 28px hit target, hover surface, hover colour set per-button (foreground / destructive).
  // 32px hit target on touch (mobile), the quieter 28px on ≥sm where a cursor is precise — «no tiny
  // expand icons» on mobile (Mobile-nav card), same circular shape either way.
  const iconBtn =
    'inline-flex h-8 w-8 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted';

  return (
    <section
      ref={sectionRef}
      className={`min-w-0 ${reorder ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''} ${
        SIZE_COL_SPAN[effectiveSize]
      } ${
        // While the ⋯ menu is open, lift the WHOLE card above its sibling cards. The menu is
        // `z-popover`, but each card's entrance transform (widget-enter) makes it a stacking context
        // that traps that z-index inside the card — so the menu's overhang paints UNDER the next grid
        // card. The card is a direct grid item, which honours z-index without `position` (no
        // offset-parent change for the absolute menu). `z-10` is intra-content stacking (per the
        // z-token scale it stays BELOW sticky chrome=20), so the card clears its neighbours while the
        // menu still can't rise over the topbar if the user scrolls with it open.
        menuOpen ? 'z-10' : ''
      } ${className ?? ''}`}
      style={outerStyle}
      onPointerDown={
        reorder
          ? (e) => {
              if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
              e.preventDefault();
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* pointer already gone */
              }
              group?.dragStart(widgetId, e);
            }
          : undefined
      }
      onPointerMove={reorder ? (e) => group?.dragMove(e) : undefined}
      onPointerUp={reorder ? () => group?.dragEnd() : undefined}
      onPointerCancel={reorder ? () => group?.dragEnd() : undefined}
    >
      <div
        className={`${strip ? 'group/strip relative flex flex-col' : `flex flex-col ${SIZE_H[effectiveSize]} rounded-xl border bg-card p-4 sm:p-5 transition-colors hover:border-ink3/40 hover:[--card-tint-alpha:0.16] dark:hover:border-white/[0.12] dark:hover:[--card-tint-alpha:0.18]`} ${
          // Softer surface edge in dark (a faint white hairline instead of the hard #2b2b2b box —
          // steep-like "lit surface", less boxed); light mode keeps the full hairline (white cards on
          // paper need it for definition). Edit mode keeps a visible border.
          homeEditing && homeKey ? 'border-ink3/25' : 'border-border dark:border-white/[0.06]'
        } ${reorder ? 'widget-jiggle' : 'widget-enter cursor-pointer'} ${isDragging ? 'shadow-lg' : ''}`}
        style={innerStyle}
        data-widget-accented={activeColor ? '' : undefined}
        // Метрика карточки для нарратив-связки: ховер числа в рассказе подсвечивает секции с тем же
        // drillTo (data-narr-link из NarrativeProse; CSS-правило в index.css зеркалит card-hover).
        data-drill-to={drillTo || undefined}
        data-widget-tinted={activeTinted && activeColor ? '' : undefined}
        // Whole-card click opens the detail overlay (steep — the whole card is the target, not just
        // the small ↗ button). Guarded so header controls and any open dialog keep their behaviour,
        // and a reorder drag never triggers it. Chart svg is deliberately NOT in the guard — a click
        // on the plot must drill like the rest of the card (charts that handle their own point-drill
        // stopPropagation instead); the press-distance check below keeps a drag-to-read scrub from
        // registering as a click. Mouse convenience ONLY: the card carries no button role/tabIndex —
        // real controls (↗ ⋯ ×) nested inside a role="button" are invalid (axe nested-interactive)
        // and make screen readers announce the whole card as one opaque button. The semantic
        // keyboard/AT path to the same action is the header's labelled «Развернуть виджет …» button.
        onPointerDown={
          reorder || noExpand ? undefined : (e) => (cardPressRef.current = { x: e.clientX, y: e.clientY })
        }
        onClick={
          reorder || noExpand
            ? undefined
            : (e) => {
                if ((e.target as HTMLElement).closest('button, a, input, select, label, [role="dialog"]')) return;
                const press = cardPressRef.current;
                cardPressRef.current = null;
                if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
                openExpand();
              }
        }
      >
      {/* While REORDERING a strip shows its title inline — a nameless jiggling number row was
          unidentifiable next to labelled cards (аудит). */}
      <div className={strip && !reorder ? 'absolute -top-1 right-0 z-10 flex items-center' : 'flex shrink-0 items-center gap-3'}>
        <h3 className={strip && !reorder ? 'sr-only' : 'min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-foreground'}>
          {prefs.title || title}
        </h3>
        {action}
        {removePresence.mounted && (
          <button
            type="button"
            aria-label={`Убрать виджет «${prefs.title || title}» с главной`}
            title="Убрать с главной"
            // While exiting the mode the × is on its way out — inert (no clicks, out of the tab order,
            // hidden from AT) so it can't be actioned mid-leave.
            aria-hidden={removePresence.exiting || undefined}
            tabIndex={removePresence.exiting ? -1 : undefined}
            onClick={() => {
              if (!homeKey) return;
              unpinFromHome(homeKey);
              // The whole card unmounts with this button — park focus on the sticky «Готово»
              // edit toggle so a keyboard user removing several widgets never re-Tabs from the top.
              document.querySelector<HTMLElement>('.edit-toggle')?.focus();
            }}
            className={`${iconBtn} hover:text-destructive ${
              reorder
                ? 'pointer-events-none invisible'
                : removePresence.exiting
                  ? 'home-remove-exit pointer-events-none'
                  : 'home-remove-enter'
            }`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {!noExpand && (
          <button
            type="button"
            aria-label={`Развернуть виджет «${prefs.title || title}»`}
            title="Развернуть"
            onClick={() => openExpand()}
            // Stay hidden until the × has fully left (presence, not the raw flag) so the header never
            // shows both the leaving × and the returning ↗ at once.
            className={`${iconBtn} hover:text-foreground print:hidden ${
              removePresence.mounted ? 'hidden' : ''
            } ${reorder ? 'pointer-events-none invisible' : ''}`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className={`relative shrink-0 ${reorder ? 'pointer-events-none invisible' : ''}`} ref={menuRef}>
          <button
            ref={menuBtnRef}
            type="button"
            aria-label={`Меню виджета «${prefs.title || title}»`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((v) => !v)}
            onKeyDown={(e) => {
              // APG menu button: ArrowDown opens the menu and moves focus to its first item.
              if (e.key !== 'ArrowDown') return;
              e.preventDefault();
              if (!menuOpen) setMenuOpen(true);
              requestAnimationFrame(() =>
                menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(),
              );
            }}
            className={`${iconBtn} hover:text-foreground`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.25" />
              <circle cx="8" cy="8" r="1.25" />
              <circle cx="12.5" cy="8" r="1.25" />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label={`Меню виджета «${prefs.title || title}»`}
              className="absolute right-0 top-full z-popover mt-1 w-48 rounded-lg border border-border bg-card p-1.5"
              // This dropdown renders INSIDE the now-clickable card; stop clicks on its padding /
              // dividers (non-button dead space) from bubbling to the card and opening the detail
              // overlay while the menu is open.
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // Arrow/Home/End roving focus over the enabled items (role=menu implies it).
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
                e.preventDefault();
                const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
                if (!items.length) return;
                const i = items.indexOf(document.activeElement as HTMLElement);
                const next =
                  e.key === 'Home' || (e.key === 'ArrowDown' && i < 0)
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : e.key === 'ArrowDown'
                        ? (i + 1) % items.length
                        : i < 0
                          ? items.length - 1
                          : (i - 1 + items.length) % items.length;
                items[next]?.focus();
              }}
            >
              {!noExpand && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      // Refocus the trigger BEFORE the state change so the detail overlay's focus trap
                      // captures it as opener (and restores to it on close) — the menu item itself
                      // unmounts with the menu.
                      menuBtnRef.current?.focus();
                      setMenuOpen(false);
                      openExpand();
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="expand" /> Развернуть
                  </button>
                  <div role="separator" className="mx-1 my-1 h-px bg-border" />
                </>
              )}
              {group && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={seqIndex <= 0}
                    onClick={() => {
                      group.move(widgetId, -1);
                      // Reaching the first slot flips this item to disabled, which blurs it to
                      // <body> and kills the menu's roving arrows — re-park inside the menu.
                      requestAnimationFrame(() => {
                        if (document.activeElement === document.body)
                          menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
                      });
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="up" /> Выше
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={seqIndex < 0 || seqIndex >= group.sequence.length - 1}
                    onClick={() => {
                      group.move(widgetId, 1);
                      requestAnimationFrame(() => {
                        if (document.activeElement === document.body)
                          menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
                      });
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="down" /> Ниже
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      group.beginReorder();
                      // Reorder mode hides the card controls (visibility:hidden — unfocusable), so
                      // park focus on the one actionable control: the portaled «Готово» pill.
                      requestAnimationFrame(() =>
                        document.querySelector<HTMLElement>('[data-reorder-done]')?.focus(),
                      );
                    }}
                    className={menuItem}
                  >
                    <MenuIcon kind="drag" /> Переставить
                  </button>
                  <div role="separator" className="mx-1 my-1 h-px bg-border" />
                </>
              )}
              {/* «На главную» / «Убрать с главной» — only on cards registered as pinnable
                  (they pass a homeKey). Pins/unpins this widget on the personal /home surface. */}
              {homeKey && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    menuBtnRef.current?.focus();
                    setMenuOpen(false);
                    if (pinned) unpinFromHome(homeKey);
                    else pinToHome(homeKey);
                    // Unpinning ON /home unmounts this whole card with the just-focused trigger —
                    // park on the sticky edit toggle then (elsewhere the card survives, keep it).
                    requestAnimationFrame(() => {
                      if (!menuBtnRef.current?.isConnected)
                        document.querySelector<HTMLElement>('.edit-toggle')?.focus();
                    });
                  }}
                  className={menuItem}
                >
                  <MenuIcon kind="home" /> {pinned ? 'Убрать с главной' : 'На главную'}
                </button>
              )}
              {!strip && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  // Trigger first: the edit dialog's focus trap then records it as opener and
                  // restores focus to this card's ⋯ button when the dialog closes.
                  menuBtnRef.current?.focus();
                  setMenuOpen(false);
                  // Config-driven cards open their own editor (writes to the WidgetConfig).
                  if (configEditor) configEditor.open();
                  else setEditOpen(true);
                }}
                className={menuItem}
              >
                <MenuIcon kind="edit" /> Изменить
              </button>
              )}
              {group && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    update({ ...prefs, hidden: true });
                    // The card goes display:none in this commit (focus would blur to <body>) —
                    // park on this widget's restore chip in the «Скрытые виджеты» bar, so Enter
                    // again un-hides it. dataset match instead of a selector: ids are free-form.
                    requestAnimationFrame(() => {
                      const chips = document.querySelectorAll<HTMLElement>('[data-widget-chip]');
                      for (const chip of chips) {
                        if (chip.dataset.widgetChip === widgetId) {
                          chip.focus();
                          return;
                        }
                      }
                    });
                  }}
                  className={menuItem}
                >
                  <MenuIcon kind="hide" /> Скрыть
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Per-widget period — a compact pill row under the header (hidden while reordering / in
          print). Only on wired cards that read useWidgetPeriod(); the global topbar switcher is gone. */}
      {periodControl && (
        <>
          {/* An explicit number click is ALWAYS an override — the old «30д ⇒ undefined» shortcut
              made picking 30д silently mean «follow the page» (on a 7д page the card showed 7д
              right after the user chose 30д). Clearing the override is its own affordance now
              («Стр.»); off page-period surfaces prefs.period=30 ≡ undefined, so nothing shifts. */}
          <WidgetPeriodPills
            days={widgetDays}
            override={prefs.period}
            onChange={(next) => update({ ...prefs, period: next })}
            onFollow={() => update({ ...prefs, period: undefined })}
            hidden={reorder}
          />
          {periodWidened && !reorder && (
            <p className="mt-1 text-2xs text-muted-foreground print:hidden">
              За {PERIOD_WORD[requestedDays]} данных нет — показано за {PERIOD_WORD[widgetDays]}.
            </p>
          )}
        </>
      )}
      <div className={`${strip ? 'flex min-h-0 flex-col pr-8' : 'mt-3 flex min-h-0 flex-1 flex-col'} ${reorder ? 'pointer-events-none' : ''}`}>
        <WidgetPeriodProvider value={widgetPeriod}>
          <WidgetTargetContext.Provider value={activeTarget}>
            {/* Chart region — flex-1 eats the tile's leftover height. overflow-hidden (NOT auto): a
                dashboard tile must never grow an inner scrollbar — content adapts to the tile instead
                (charts reserve their below-axis rows so they fit; narrative/heavy widgets take a
                content-height `full` card). fillHeight feeds the leftover height to EVERY chart inside
                (variant or bare children) so they fill; a `full` card passes null, so its charts keep
                their own/explicit height. */}
            <div ref={bodyRef} className="min-h-0 flex-1 overflow-hidden">
              {/* Per-widget boundary: a body crash becomes a calm in-card fallback, the header + ⋯
                  menu survive (so the broken widget can still be hidden / edited), and every sibling
                  widget and the app shell keep rendering. */}
              <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={prefs.title || title} resetKeys={bodyResetKeys}>
                <ExpandedChartHeightContext.Provider value={fillHeight}>
                  {variantResult.ok ? (activeVariant ? activeVariant.render : children) : variantRender}
                </ExpandedChartHeightContext.Provider>
              </WidgetErrorBoundary>
            </div>
            {/* Caption (shared children under a variant — «лучший день» / «пик активности» / totals)
                sits below the chart at its natural height, never squeezed by the fill. */}
            {activeVariant && children != null && <div className="shrink-0">{children}</div>}
          </WidgetTargetContext.Provider>
        </WidgetPeriodProvider>
      </div>
      </div>

      {editOpen && !configEditor && (
        <EditWidgetDialog
          defaultTitle={title}
          prefs={prefs}
          variants={resolvedVariants}
          showPeriod={!!periodControl}
          showSeries={!!seriesOptions}
          showSource={widgetId.startsWith('home-')}
          showSize={!!group && !fixedSize}
          defaultSize={defaultSize ?? 'third'}
          minSize={activeVariant?.minSize ?? 'third'}
          onChange={update}
          onClose={() => setEditOpen(false)}
        />
      )}

      {/* Config-widgets pass a mutable-config explorer that fully replaces the generic overlay. */}
      {expandOpen && explorer
        ? explorer(closeExpand, originRectRef.current)
        : expandOpen && !noExpand && (
            <ChartExpandOverlay
              title={prefs.title || title}
              accentStyle={accentVars ?? undefined}
              initialDays={periodControl ? widgetDays : undefined}
              renderExpanded={hasRichExpand ? expand?.renderExpanded : undefined}
              renderExpandedBar={hasRichExpand ? expand?.renderExpandedBar : undefined}
              statsFor={hasRichExpand ? expand?.statsFor : undefined}
              statsSum={expand?.statsSum ?? true}
              grainable={hasRichExpand ? expand?.grainable : undefined}
              onClose={closeExpand}
              originRect={originRectRef.current}
            >
              <WidgetErrorBoundary variant="inline" widgetId={widgetId} label={prefs.title || title} resetKeys={bodyResetKeys}>
                {bodyNode}
              </WidgetErrorBoundary>
            </ChartExpandOverlay>
          )}
    </section>
  );
}

// ── Per-widget period control ─────────────────────────────────────────────────────────────

export const PERIOD_WORD: Record<PeriodDays, string> = { 7: '7 дней', 30: '30 дней', 90: '90 дней', 0: 'всё время' };

/** Compact underline-tab period row for one widget card (7д / 30д / 90д / Всё). Same visual
    language as the retired topbar switcher, scoped to this card. Hidden while reordering /
    in print (period is not a print concern). */
function WidgetPeriodPills({
  days,
  override,
  onChange,
  onFollow,
  hidden,
}: {
  days: PeriodDays;
  /** The card's explicit prefs.period; undefined = the card FOLLOWS the page period. */
  override: PeriodDays | undefined;
  onChange: (days: PeriodDays) => void;
  /** Clear the override (follow the page). Absent when no page period exists on this surface. */
  onFollow?: () => void;
  hidden?: boolean;
}) {
  const pagePeriod = usePagePeriod();
  if (hidden) return null;
  const following = override === undefined && pagePeriod != null;
  const pillClass = (active: boolean) =>
    `relative inline-flex min-h-8 min-w-8 items-center justify-center rounded px-2 text-2xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:min-h-0 sm:min-w-0 sm:justify-start sm:px-0.5 sm:pb-1 sm:pt-0.5 ${
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
    }`;
  return (
    <div role="group" aria-label="Период виджета" className="mt-2 flex items-center gap-3 print:hidden">
      {/* The hierarchy made VISIBLE (аудит: два одинаковых ряда пиллов не читались): a card on a
          page-period feed leads with «Стр.» — active while the card follows the page (the default),
          so an overridden card is instantly recognizable AND has a way back. Off page-period
          surfaces (Home, IG bodies) the chip vanishes and the row is exactly the old one. */}
      {pagePeriod != null && onFollow && (
        <button
          type="button"
          aria-pressed={following}
          title="Следовать периоду страницы"
          onClick={onFollow}
          className={pillClass(following)}
        >
          Стр.
          {following && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-primary sm:-bottom-px" />}
        </button>
      )}
      {WIDGET_PERIODS.map((p) => {
        // While following, the page's value shows WHERE the window comes from without claiming the
        // active underline — only an explicit override lights a number pill.
        const active = !following && days === p.days;
        const echoed = following && days === p.days;
        return (
          <button
            key={p.days}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p.days)}
            // Touch: ≥32px tap target on mobile (period is a primary filter — Mobile-nav card); the
            // underline sits at the label baseline via inset-y so the compact ≥sm look is unchanged.
            className={pillClass(active)}
          >
            {p.label}
            {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-primary sm:-bottom-px" />}
            {echoed && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-border sm:-bottom-px" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The steep chart-card anatomy (owner rule): the headline number + its MANDATORY comparison sit
 * bottom-LEFT, and the chart fills the remaining width to the RIGHT of the number block (inset —
 * it starts after the comparison, not at the card edge), bottom-anchored. Cards whose data can't
 * produce a comparison simply omit `delta` — «кроме тех мест, где не можем предоставить».
 */
export function ChartCardBody({
  label,
  value,
  delta,
  caption,
  onValueClick,
  hero = false,
  children,
}: {
  /** Quiet metric label above the number (e.g. «Просмотры · 30 дн.» + info icon). */
  label?: ReactNode;
  /** Headline for the visible window (already formatted — fmt.kpi). */
  value: string;
  /** Comparison vs the previous same-length window; null/undefined when honestly unavailable. */
  delta?: MetricDelta | null;
  /** Quiet line under the pill (e.g. «к пред. периоду», «за всё время»). */
  caption?: ReactNode;
  /** Makes the number a real drill button (metric-page navigation), KpiCard-style. */
  onValueClick?: () => void;
  /** Hero cards render the number a size up (the «Показатели» lead metric). */
  hero?: boolean;
  children: ReactNode;
}) {
  const numberClass = `kpi-accent ${hero ? 'text-hero' : 'text-3xl'} font-medium leading-none tabular-nums tracking-tight`;
  return (
    <div className="flex h-full min-h-0 items-end gap-4">
      <div className="flex shrink-0 flex-col items-start gap-1.5 pb-0.5">
        {label != null && <div className="text-xs tracking-wide text-muted-foreground">{label}</div>}
        {onValueClick ? (
          <button
            type="button"
            title="Подробный разбор"
            onClick={onValueClick}
            className={`${numberClass} rounded text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
          >
            {value}
          </button>
        ) : (
          <div className={numberClass}>{value}</div>
        )}
        <DeltaPill delta={delta} />
        {caption != null && <div className="text-2xs text-muted-foreground">{caption}</div>}
      </div>
      <div className="min-h-0 min-w-0 flex-1 self-stretch">{children}</div>
    </div>
  );
}

function MenuIcon({ kind }: { kind: 'up' | 'down' | 'edit' | 'hide' | 'drag' | 'expand' | 'home' }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
      {kind === 'expand' && <path d="M5 11 11 5M6.5 5H11v4.5" />}
      {kind === 'home' && (
        <>
          <path d="m2 7 6-5 6 5" />
          <path d="M3.5 6.2V14h9V6.2" />
          <path d="M6.5 14v-4h3v4" />
        </>
      )}
      {kind === 'up' && <path d="m4 10 4-4 4 4" />}
      {kind === 'down' && <path d="m4 6 4 4 4-4" />}
      {kind === 'drag' && (
        <>
          <path d="M8 2v12M2 8h12" />
          <path d="m6 3.5 2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
        </>
      )}
      {kind === 'edit' && <path d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L5.5 13.5l-3 .5.5-3z" />}
      {kind === 'hide' && (
        <>
          <path d="M2 2l12 12" />
          <path d="M6.5 3.8A6.5 6.5 0 0 1 14 8s-.7 1.3-2 2.4M4 5.6C2.7 6.7 2 8 2 8a6.9 6.9 0 0 0 7.5 4.2" />
        </>
      )}
    </svg>
  );
}
