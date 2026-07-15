import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider } from '@/lib/period';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import {
  HomeEditContext,
  getWidgetPrefs,
  pinToHome,
  remapGroupOrder,
  setGroupOrder,
  setHomeBlocks,
  setPrefs,
  setWidgetHidden,
  useHomeBlocks,
  useWidgetPrefs,
} from '@/lib/widgetPrefsStore';
import { ChannelScope } from '@/lib/channel-context';
import { HOME_REGISTRY, type HomeWidgetDef } from '@/lib/homeWidgets';
import { defaultHomeKeys, HOME_LEGACY_DEFAULT_KEYS } from '@/lib/homeDefaults';
import { ConfigWidget } from '@/components/ConfigWidget';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { WidgetCatalogModal } from '@/components/WidgetCatalogModal';
import { CreateWidgetDialog } from '@/components/CreateWidgetDialog';
import { addWidgetConfig, getWidgetConfig, useWidgetConfigs } from '@/lib/widgetStore';
import { isLegacyKey, legacyConfigId } from '@/lib/legacyWidgets';
import { configIdFromKey, customKey, healedLegacyConfig, isCustomKey, type WidgetConfig } from '@/lib/widgetConfig';
import { HomeSourceProvider } from '@/lib/homeSourceContext';
import { useActiveNetwork } from '@/components/layout/nav';
import { networkByKey } from '@/lib/networks';

/**
 * Personal Home — a per-user board of the widgets the reader pinned via the ⋯ «На главную» item
 * on any screen. It renders each pinned registry key (in order) as a home-scoped card inside ONE
 * reorderable WidgetGroup (id="home"), so reorder/jiggle/FLIP, per-widget size/period and the
 * expand overlay all work for free — and the Home arrangement is a distinct prefs identity from
 * the source screen (home-<key> ids). Stale keys (a removed/renamed registry entry) are skipped
 * silently. Empty on first visit → a CTA explaining how to pin, plus a one-click default set.
 *
 * On-page editing: «Изменить» flips edit mode (HomeEditContext) — every card grows a × that
 * unpins it (unpinFromHome), and a «+ Добавить виджет» picker at the bottom pins any catalog
 * widget not already on Home (pinToHome). Both write the same localStorage-first pin store that
 * syncs to /api/prefs, so edits persist + cross-device exactly like a ⋯-menu pin.
 *
 * Desktop vs mobile chrome: the header controls and empty state have a desktop branch (md+) — a
 * stable «Добавить виджет» + «Изменить/Готово» toolbar and an unframed empty surface — while the
 * mobile branch (<md) is preserved verbatim (the compact expand-on-touch edit chip + framed empty
 * card). The board grid, widget engine, pin store and data fetches are shared across both.
 */
export function Home() {
  const pinned = useHomeBlocks();
  // Subscribe to the config store so a custom widget's edit / removal re-renders Home.
  useWidgetConfigs();
  const channelsQuery = useChannels();
  const channels = channelsQuery.data?.channels ?? [];
  const activeNetwork = useActiveNetwork();
  // md+ gets the desktop toolbar / empty surface; <md keeps the mobile chip + framed card verbatim.
  const isDesktop = useMediaQuery('(min-width: 768px)');
  // A single catalog → create flow, shared by the header button, the edit-mode dock and the empty
  // state — so «Добавить виджет» always lands in the same builder and never double-mutates.
  const add = useHomeAdd();
  // Skip any pinned key whose backing is gone (a removed registry entry, or a `custom:<id>` whose
  // config was deleted) — never crash.
  const known = pinned.filter((key) =>
    isCustomKey(key) ? !!getWidgetConfig(configIdFromKey(key) ?? '') : !!HOME_REGISTRY[key],
  );
  const [editing, setEditing] = useState(false);
  // Channel recency (same deduped fetch the pinned cards make) → widget cards widen an empty window
  // so a dormant channel's pinned KPIs aren't blank. See resolveEffectivePeriod / TgFeed.
  const { data: tgFull } = useTgFull(0);
  const { data: history } = useHistory(730);
  const recency = useMemo(() => latestDataMs(tgFull?.posts, history), [tgFull, history]);

  const seedDefaults = () => {
    if (!isDesktop) {
      setHomeBlocks([...HOME_LEGACY_DEFAULT_KEYS]);
      return;
    }

    const keys = defaultHomeKeys(channels);
    // The desktop composition is a deliberate 100 / 50+50 / 100 / 100 rhythm. Preserve any old
    // per-widget choice, but give a genuinely new board enough room for its narrative and line chart.
    if (keys.includes('growth') && !getWidgetConfig(legacyConfigId('growth'))) {
      const oldPrefs = getWidgetPrefs('home-growth');
      const growth = healedLegacyConfig('growth', oldPrefs);
      if (growth) addWidgetConfig(oldPrefs.size ? growth : { ...growth, size: 'half' });
    }
    if (keys.includes('ig-reach')) {
      const igPrefs = getWidgetPrefs('home-ig-reach');
      if (!igPrefs.size) setPrefs('home-ig-reach', { ...igPrefs, size: 'full' });
    }

    // WidgetGroup registration can be asynchronous (an IG card waits for its query). Seed the
    // persisted section ids up front so data arrival never changes the promised board order.
    setGroupOrder(
      'home',
      keys.map((key) => (isLegacyKey(key) ? `custom-${legacyConfigId(key)}` : `home-${key}`)),
    );
    setHomeBlocks(keys);
  };

  // Persist a deterministic-id WidgetConfig for every pinned legacy widget so its per-instance
  // settings (period / source / title / size / visualisation / style) stick when edited. Runs ONCE
  // per device (guarded by !getWidgetConfig) — which is also the one-time
  // MIGRATION seam: the card's identity moves from the old `home-<key>` prefs row to the config
  // (`custom-legacy-<key>`), so we carry the user's saved settings across instead of resetting them
  // (period/size/title/accent/source and the old line/bar variant would otherwise be orphaned).
  // `hidden` isn't a config field → set it on the NEW ChartSection id;
  // the reorder slot follows via remapGroupOrder. Keyed on the membership string so it only re-runs
  // when the pinned set changes (getHomeBlocks returns a fresh array each render). The render below
  // heals from the same old prefs, so there's no first-paint reset before this lands. The bare
  // registry key stays in the (account-synced) pinned list as the stable cross-device pointer; the
  // config is device-local (widgetStore) and re-heals per device from that device's prefs.
  const pinnedSig = pinned.join('|');
  useEffect(() => {
    for (const key of pinned) {
      if (!isLegacyKey(key) || getWidgetConfig(legacyConfigId(key))) continue;
      const oldId = `home-${key}`;
      const prefs = getWidgetPrefs(oldId);
      const cfg = healedLegacyConfig(key, prefs);
      if (!cfg) continue;
      addWidgetConfig(cfg);
      const newId = `custom-${legacyConfigId(key)}`; // ConfigWidget's ChartSection id
      if (prefs.hidden) setWidgetHidden(newId, true);
      remapGroupOrder('home', oldId, newId);
    }
    // pinned is captured via pinnedSig (its content signature); a fresh array each render is expected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedSig]);

  return (
    <div>
      {/* Sticky page header — the Add / Edit actions stay reachable while scrolling the board.
          Solid bg + a hairline (no blur/shadow per governance); bg bleeds to the content padding.
          Desktop (md+): a stable «Добавить виджет» + «Изменить/Готово» toolbar (fixed footprint, no
          hover-reflow). Mobile (<md): the compact expand-on-touch edit chip, preserved verbatim. */}
      <div className="sticky top-0 z-sticky -mx-4 mb-6 flex items-start justify-between gap-3 border-b border-border bg-background px-4 py-3 sm:-mx-6 sm:px-6 md:items-center">
        <h2 className="text-2xl font-medium tracking-tight text-foreground">Главная</h2>
        <div className="flex items-center gap-2">
          {/* Desktop read mode owns one direct catalog command. Empty and edit states expose their
              own single add affordance instead, so identical CTAs never compete on one screen. */}
          {known.length > 0 && !editing && (
            <button
              type="button"
              onClick={() => add.openCatalog()}
              aria-label="Добавить виджет"
              title="Добавить виджет"
              className="hidden items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted md:inline-flex"
            >
              <svg className="h-4 w-4 shrink-0 text-primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
              Добавить виджет
            </button>
          )}
          <div className="edit-toggle-slot">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              aria-pressed={editing}
              data-active={editing}
              // Both state labels live in the DOM (aria-hidden — the accessible name is the aria-label).
              // On mobile the slot keeps header layout fixed while the chip expands over that reserved
              // space; on desktop the chip renders at its full labelled size (no reflow).
              aria-label={editing ? 'Готово' : 'Изменить'}
              title={editing ? 'Готово' : 'Изменить'}
              className="edit-toggle btn-pill text-sm font-medium"
            >
              <span className="edit-toggle-icons" aria-hidden="true">
                <svg className="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                <svg className="i-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {/* pathLength=1 normalises the stroke length so the CSS draw-on (dasharray/offset) needs no measuring */}
                  <path d="M20 6 9 17l-5-5" pathLength={1} />
                </svg>
              </span>
              <span className="edit-toggle-label" aria-hidden="true">
                <span className="edit-toggle-label-edit">Изменить</span>
                <span className="edit-toggle-label-done">Готово</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      {known.length === 0 && !editing ? (
        <HomeEmptyState
          desktop={isDesktop}
          onEdit={() => setEditing(true)}
          onAdd={() => add.openCatalog()}
          overviewTo={networkByKey(activeNetwork).home}
          defaultsPending={isDesktop && channelsQuery.isPending}
          onSeedDefaults={seedDefaults}
        />
      ) : (
        <HomeEditContext.Provider value={editing}>
          {/* Edit-mode board — the grid keeps its full width and single 6-col footprint (no
              decorative narrowing / nested «page card»). A quiet desktop state label replaces
              the old canvas effect; mobile keeps its full-bleed board verbatim. */}
          <div className="home-board-canvas" data-editing={editing}>
            {editing && (
              <div
                className="hidden items-center gap-2 border-b border-border pb-3 text-xs font-medium text-muted-foreground md:flex"
                aria-live="polite"
              >
                <svg
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                </svg>
                <span>Редактирование</span>
              </div>
            )}
            <ChannelRecencyProvider value={recency}>
              <WidgetGroup id="home" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
                {known.map((key) => {
                  // Custom (metric-builder) widget: a `custom:<id>` key → its stored WidgetConfig,
                  // rendered via ConfigWidget (which wraps its own ChannelScope from config.source).
                  if (isCustomKey(key)) {
                    const config = getWidgetConfig(configIdFromKey(key) ?? '');
                    if (!config) return null; // stale (filtered above, but be defensive)
                    return (
                      <div key={key} className="contents">
                        <ConfigWidget config={config} homeKey={key} />
                      </div>
                    );
                  }
                  // Legacy composite (U6.3): render through ConfigWidget, backed by a
                  // deterministic-id config (persisted by the effect above; the fallback heals from the
                  // same old `home-<key>` prefs so the first paint already carries the migrated period /
                  // source / accent — no reset flash, right channel from frame one). homeKey stays the
                  // bare registry key so the ⋯«Убрать с главной» / edit-mode × unpin work unchanged.
                  if (isLegacyKey(key)) {
                    const config =
                      getWidgetConfig(legacyConfigId(key)) ??
                      healedLegacyConfig(key, getWidgetPrefs(`home-${key}`));
                    if (!config) return null;
                    return (
                      <div key={key} className="contents">
                        <ConfigWidget config={config} homeKey={key} />
                      </div>
                    );
                  }
                  // Curated non-legacy entry: it still owns a complete home-scoped ChartSection. A
                  // dedicated component subscribes to its old prefs row for source and fallback size.
                  const def = HOME_REGISTRY[key];
                  if (!def?.render) return null;
                  return (
                    <div key={key} className="contents">
                      <CuratedHomeCard homeKey={key} def={def} />
                    </div>
                  );
                })}
              </WidgetGroup>
            </ChannelRecencyProvider>
            {editing && <AddWidgetBar pinned={pinned} onOpenCatalog={add.openCatalog} />}
          </div>
        </HomeEditContext.Provider>
      )}
      {add.node}
    </div>
  );
}

/**
 * The single Home add flow: the metric catalogue → build dialog → pin. Lifted out of the edit-mode
 * dock so the desktop header button, the dock and the empty state all open the SAME modal chain and
 * add through one path (no duplicate catalog instance, no double mutation). Focus restore is handled
 * by the modals themselves (useFocusTrap snapshots whatever element opened them, restores on close).
 */
function useHomeAdd(): { openCatalog: () => void; node: ReactNode } {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [createMetric, setCreateMetric] = useState<string | null>(null);

  const openCatalog = () => setCatalogOpen(true);
  const pickMetric = (metricId: string) => {
    setCatalogOpen(false);
    setCreateMetric(metricId);
  };
  const addConfigured = (config: WidgetConfig) => {
    const w = addWidgetConfig(config);
    if (w) pinToHome(customKey(w.id));
    setCreateMetric(null);
  };

  const node = (
    <>
      {catalogOpen && <WidgetCatalogModal onPick={pickMetric} onClose={() => setCatalogOpen(false)} />}
      {createMetric && (
        <CreateWidgetDialog metricId={createMetric} onAdd={addConfigured} onClose={() => setCreateMetric(null)} />
      )}
    </>
  );
  return { openCatalog, node };
}

/** A curated own-chrome pinned card (week / Instagram / compare / insights). Subscribes to ITS
 *  `home-<key>` prefs row (Home only re-renders on pin-list / config changes now), so editing this
 *  card's source or size re-renders exactly this card. Its own ChartSection means a crash in its
 *  variant compute escapes the in-card body boundary — the self-chromed «card» fallback here keeps
 *  the flagship Home whole per-widget. ChannelScope pins it to its «Источник» at the RENDER site. */
const CuratedHomeCard = memo(function CuratedHomeCard({ homeKey, def }: { homeKey: string; def: HomeWidgetDef }) {
  const prefs = useWidgetPrefs(`home-${homeKey}`);
  if (!def.render) return null;
  return (
    <WidgetErrorBoundary
      variant="card"
      widgetId={`home-${homeKey}`}
      label={def.label}
      size={prefs.size ?? def.defaultSize ?? 'half'}
    >
      <HomeSourceProvider value={{ network: def.network, channelId: prefs.source }}>
        <ChannelScope channelId={prefs.source ?? null}>{def.render()}</ChannelScope>
      </HomeSourceProvider>
    </WidgetErrorBoundary>
  );
});

/** Edit-mode picker (bottom dock): opens the shared metric catalogue (→ a config-driven
    `custom:<id>` widget) or pins a legacy registry widget not already on Home. Popover closes on
    outside click / Escape. The catalog/create modals live in the shared useHomeAdd controller, so
    the dock and the desktop header add through ONE flow. */
function AddWidgetBar({ pinned, onOpenCatalog }: { pinned: string[]; onOpenCatalog: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const available = Object.keys(HOME_REGISTRY).filter((key) => !pinned.includes(key));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="add-widget-dock add-widget-enter">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="add-widget-trigger btn-pill text-sm font-medium"
      >
        + Добавить виджет
      </button>
      {open && (
        <div className="add-widget-popover absolute bottom-full left-1/2 z-popover mb-2 w-72 -translate-x-1/2 rounded-lg border border-border bg-card p-1.5">
          {/* Metric-first path: the shared searchable catalogue → a config-driven widget. */}
          <button
            type="button"
            onClick={() => {
              // Trigger first so the catalog's focus trap snapshots it as opener and restores focus
              // here on close (the menu item itself unmounts with the popover); then hand off to the
              // shared controller so the dock and the header open the SAME catalog instance.
              triggerRef.current?.focus();
              setOpen(false);
              onOpenCatalog();
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <svg className="h-4 w-4 shrink-0 text-primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            Метрика из каталога…
          </button>
          {available.length > 0 && (
            <>
              <div aria-hidden="true" className="mx-1 my-1 h-px bg-border" />
              <div className="px-2.5 py-1 text-2xs font-medium tracking-wider text-muted-foreground">Готовые виджеты</div>
              {available.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    pinToHome(key);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className="block w-full rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {HOME_REGISTRY[key]!.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * First-ever Home. Desktop (md+): a calm UNFRAMED working surface — a headline, guidance and two
 * actions laid out on the page, not boxed in a decorative card. Mobile (<md): the framed card is
 * preserved verbatim (its «Добавить виджет» primary still enters edit mode → bottom dock). The
 * primary desktop CTA opens the catalog directly; «Собрать по умолчанию» seeds the availability-aware
 * default board.
 */
function HomeEmptyState({
  desktop,
  onEdit,
  onAdd,
  overviewTo,
  defaultsPending,
  onSeedDefaults,
}: {
  desktop: boolean;
  onEdit: () => void;
  onAdd: () => void;
  overviewTo: string;
  defaultsPending: boolean;
  onSeedDefaults: () => void;
}) {
  if (desktop) {
    return (
      <div className="max-w-xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-muted-foreground">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
            <path d="M9 21v-6h6v6" />
          </svg>
        </div>
        <h3 className="mt-4 text-lg font-medium text-foreground">На Главной пока пусто</h3>
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
          Соберите личную доску из ключевых метрик и сохранённых виджетов.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onAdd}
            className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Добавить виджет
          </button>
          <button
            type="button"
            onClick={onSeedDefaults}
            disabled={defaultsPending}
            className="btn-pill border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            Собрать по умолчанию
          </button>
          <Link
            to={overviewTo}
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Открыть Обзор
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-6 text-center sm:p-8">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-border text-muted-foreground">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
          <path d="M9 21v-6h6v6" />
        </svg>
      </div>
      <h3 className="mt-4 text-base font-medium text-foreground">На Главной пока пусто</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Нажмите «Изменить» → «Добавить виджет», либо откройте Обзор или Аналитику и нажмите ⋯ →
        «На главную» на любом виджете.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Добавить виджет
        </button>
        <button
          type="button"
          onClick={onSeedDefaults}
          className="btn-pill border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Собрать по умолчанию
        </button>
        <Link
          to="/"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Открыть Обзор
        </Link>
      </div>
    </div>
  );
}
