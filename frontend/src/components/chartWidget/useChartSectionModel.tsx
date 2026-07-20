import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { WidgetTargetContext } from '@/components/ExpandableChart';
import { ThrowInRender } from '@/components/WidgetErrorBoundary';
import { GroupCtx, prefersReducedMotion } from '@/components/widgets/WidgetGroup';
import { maxSize } from '@/components/widgets/variants';
import { observeSize } from '@/lib/observeSize';
import {
  WidgetPeriodProvider,
  resolveEffectivePeriod,
  resolveRequestedWidgetDays,
  usePeriod,
  useChannelRecency,
  usePagePeriod,
  widgetPeriodValue,
} from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { useExitPresence } from '@/lib/useExitPresence';
import {
  HomeEditContext,
  setPrefs,
  unpinFromHome,
  useIsPinnedToHome,
  useWidgetPrefs,
} from '@/lib/widgetPrefsStore';
import type { SeriesGrain, WidgetPrefs, WidgetSeriesOpts, WidgetSize } from '@/lib/widgetPrefsStore';
import { REMOVE_EXIT_MS } from './constants';
import type { ChartSectionProps } from './types';

export function useChartSectionModel(props: ChartSectionProps) {
  const {
    id,
    title,
    variants,
    defaultSize,
    defaultColor,
    fixedSize,
    expand,
    drillTo,
    periodControl,
    strip,
    homeKey,
    configEditor,
    bodyResetKey,
    children,
  } = props;
  const widgetId = id ?? title;
  const group = useContext(GroupCtx);
  const homeEditing = useContext(HomeEditContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const sectionRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const originRectRef = useRef<DOMRect | null>(null);
  const cardPressRef = useRef<{ x: number; y: number } | null>(null);
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const pagePeriod = usePagePeriod();
  const explorerPeriod = usePeriod();

  // A `drillTo` card never opens the in-place overlay — its expand affordance navigates to a
  // dedicated metric route. Guard the URL-driven open too, so a stale `?detail=<id>` deep-link can't
  // resurrect the retired overlay for a card that has since moved to a full metric page.
  const legacyDetailMatch = searchParams.get('detail') === widgetId;
  const expandOpen = !drillTo && legacyDetailMatch;
  useEffect(() => {
    if (!drillTo || !legacyDetailMatch) return;
    if (pagePeriod?.range) explorerPeriod.setRange(pagePeriod.range);
    else if (pagePeriod) explorerPeriod.setDays(pagePeriod.days);
    navigate(drillTo, { replace: true });
  }, [drillTo, explorerPeriod, legacyDetailMatch, navigate, pagePeriod]);
  const openExpand = useCallback(() => {
    if (drillTo) {
      // A detail route owns the global explorer period. Seed it from the authoritative feed top bar
      // before navigating so 7/30/90/custom never snaps back to an unrelated old metric-page value.
      if (pagePeriod?.range) explorerPeriod.setRange(pagePeriod.range);
      else if (pagePeriod) explorerPeriod.setDays(pagePeriod.days);
      navigate(drillTo);
      return;
    }
    originRectRef.current = sectionRef.current?.getBoundingClientRect() ?? null;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('detail', widgetId);
        return next;
      },
      { replace: false },
    );
  }, [drillTo, explorerPeriod, navigate, pagePeriod, setSearchParams, widgetId]);
  const closeExpand = useCallback(() => {
    // Закрытие (Escape/крестик/backdrop) чистит ?detail= из ЖИВОГО URL, а не из снапшота рендера:
    // react-router передаёт функциональному апдейтеру searchParams из замыкания ПОСЛЕДНЕГО рендера
    // этого компонента, и устаревший снапшот (повторный Escape до ре-рендера, параллельная запись
    // других параметров) мог собрать URL, где ?detail= уцелел, — URL-driven open (expandOpen выше)
    // тут же показывал оверлей снова. Live-чтение + no-op, когда параметра уже нет, делают закрытие
    // идемпотентным: replace (не push), без лишней записи в историю и без воскрешения оверлея.
    const next = new URLSearchParams(window.location.search);
    if (next.get('detail') === null) return;
    next.delete('detail');
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (!expandOpen) originRectRef.current = null;
  }, [expandOpen]);

  const register = group?.register;
  useEffect(() => register?.(widgetId, title, sectionRef.current), [register, widgetId, title]);

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => {
      const height = element.clientHeight;
      setBodyHeight(height > 0 && height < 640 ? height : null);
    };
    measure();
    return observeSize(element, measure);
  }, []);

  const prefs = useWidgetPrefs(widgetId);
  const updatePrefs = useCallback((next: WidgetPrefs) => setPrefs(widgetId, next), [widgetId]);
  const pinned = useIsPinnedToHome(homeKey);
  const showHomeRemove = homeEditing && !!homeKey;
  const removePresence = useExitPresence(
    showHomeRemove,
    prefersReducedMotion() ? 0 : REMOVE_EXIT_MS,
  );
  const removeFromHome = useCallback(() => {
    if (!homeKey) return;
    unpinFromHome(homeKey);
    document.querySelector<HTMLElement>('.edit-toggle')?.focus();
  }, [homeKey]);
  const openEdit = useCallback(() => {
    if (configEditor) configEditor.open();
    else setEditOpen(true);
  }, [configEditor]);

  const pageControlled = pagePeriod != null;
  const pageRange = pagePeriod?.range ?? null;
  const requestedDays: PeriodDays = resolveRequestedWidgetDays(pagePeriod?.days, prefs.period);
  const channelRecency = useChannelRecency();
  const widgetDays = useMemo(
    // A feed top bar is authoritative: never silently widen its 7/30/90-day selection per card.
    // Auto-widen remains useful on Home, where every widget owns its period and can explain it.
    () => (pageControlled ? requestedDays : resolveEffectivePeriod(requestedDays, channelRecency)),
    [requestedDays, channelRecency, pageControlled],
  );
  const widgetPeriod = useMemo(() => widgetPeriodValue(widgetDays, pageRange), [widgetDays, pageRange]);
  const periodWidened = periodControl === true && !pageControlled && widgetDays !== requestedDays;

  const seriesGrain: SeriesGrain = prefs.grain ?? 'day';
  const seriesIncludeToday = prefs.includeToday !== false;
  const seriesOptions = useMemo<WidgetSeriesOpts>(
    () => ({ grain: seriesGrain, includeToday: seriesIncludeToday }),
    [seriesGrain, seriesIncludeToday],
  );
  const variantResult = useMemo(() => {
    if (typeof variants !== 'function') return { ok: true as const, variants };
    try {
      return { ok: true as const, variants: variants(widgetPeriod, seriesOptions) };
    } catch (error) {
      return { ok: false as const, error };
    }
  }, [variants, widgetPeriod, seriesOptions]);
  const resolvedVariants = variantResult.ok ? variantResult.variants : undefined;
  const activeVariant =
    resolvedVariants && resolvedVariants.length > 0
      ? (resolvedVariants.find((variant) => variant.key === prefs.variant) ?? resolvedVariants[0])
      : null;
  const primaryBody = variantResult.ok
    ? activeVariant
      ? activeVariant.render
      : children
    : <ThrowInRender error={variantResult.error} />;

  const activeColor = (configEditor ? configEditor.color : prefs.color) ?? defaultColor;
  const activeTinted = (configEditor ? configEditor.tinted : prefs.tinted) ?? true;
  const activeTarget = configEditor ? (configEditor.target ?? null) : (prefs.target ?? null);
  const chosenSize: WidgetSize =
    fixedSize ?? (configEditor ? configEditor.size : prefs.size) ?? defaultSize ?? 'third';
  const effectiveSize = strip ? 'full' : maxSize(chosenSize, activeVariant?.minSize ?? 'third');
  const fillHeight = effectiveSize === 'full' ? null : bodyHeight;
  const label = prefs.title || title;
  const bodyResetKeys = [bodyResetKey, activeVariant?.key ?? null, widgetDays];
  const richExpand = !!(
    expand &&
    (expand.renderExpanded || expand.renderExpandedBar || expand.statsFor)
  );
  const overlayBody = (
    <WidgetPeriodProvider value={widgetPeriod}>
      <WidgetTargetContext.Provider value={activeTarget}>
        {variantResult.ok
          ? activeVariant
            ? activeVariant.render
            : children
          : <ThrowInRender error={variantResult.error} />}
        {activeVariant ? children : null}
      </WidgetTargetContext.Provider>
    </WidgetPeriodProvider>
  );

  const sequenceIndex = group ? group.sequence.indexOf(widgetId) : -1;
  const reorder = !!group?.reorderMode;
  const dragging = reorder && group?.draggingId === widgetId;
  const outerStyle: CSSProperties = {};
  if (sequenceIndex >= 0) outerStyle.order = sequenceIndex;
  if (prefs.hidden) outerStyle.display = 'none';

  const accentVars: Record<string, string> | null = activeColor
    ? {
        '--brand-iris': `var(--chart-${activeColor}-accent)`,
        '--brand-iris-deep': `var(--chart-${activeColor}-accent-deep)`,
        '--chart-role-primary': `var(--chart-${activeColor}-accent)`,
        '--chart-role-selection': `var(--chart-${activeColor}-accent)`,
      }
    : null;
  if (accentVars) Object.assign(outerStyle as Record<string, string>, accentVars);

  const innerStyle: CSSProperties = {};
  if (activeTinted && !activeColor) {
    innerStyle.background =
      'linear-gradient(145deg, hsl(var(--card)) 35%, color-mix(in oklab, hsl(var(--primary)) 8%, hsl(var(--card))))';
  }
  (innerStyle as Record<string, string>)['--enter-delay'] = `${Math.min(Math.max(sequenceIndex, 0), 8) * 35}ms`;
  if (dragging) {
    innerStyle.animation = 'none';
    innerStyle.transform = 'scale(1.02)';
  } else if (reorder && sequenceIndex % 2 === 1) {
    innerStyle.animationDuration = '0.37s';
    innerStyle.animationDelay = '0.06s';
  }

  return {
    identity: { widgetId, label },
    refs: { sectionRef, bodyRef, originRectRef, cardPressRef },
    preferences: { prefs, updatePrefs, pinned },
    period: {
      requestedDays,
      widgetDays,
      widgetPeriod,
      periodWidened,
      pageControlled,
    },
    variants: { resolvedVariants, activeVariant, primaryBody },
    layout: {
      group,
      sequenceIndex,
      reorder,
      dragging,
      effectiveSize,
      fillHeight,
      outerStyle,
      innerStyle,
      activeColor,
      activeTinted,
      activeTarget,
    },
    controls: {
      homeEditing,
      menuOpen,
      setMenuOpen,
      editOpen,
      setEditOpen,
      removePresence,
      removeFromHome,
      openEdit,
    },
    expansion: {
      open: expandOpen,
      openExpand,
      closeExpand,
      richExpand,
      accentStyle: accentVars as CSSProperties | null,
      overlayBody,
    },
    bodyResetKeys,
  };
}
