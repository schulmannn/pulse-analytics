import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider } from '@/lib/period';
import {
  HomeEditContext,
  WidgetGroup,
  getWidgetPrefs,
  getWidgetSource,
  pinToHome,
  remapGroupOrder,
  setHomeBlocks,
  setWidgetHidden,
  useHomeBlocks,
} from '@/components/ChartWidget';
import { ChannelScope } from '@/lib/channel-context';
import { HOME_REGISTRY, HOME_DEFAULT_KEYS } from '@/lib/homeWidgets';
import { ConfigWidget } from '@/components/ConfigWidget';
import { WidgetErrorBoundary } from '@/components/WidgetErrorBoundary';
import { isWiredLegacyKey } from '@/components/legacyAdapters';
import { WidgetCatalogModal } from '@/components/WidgetCatalogModal';
import { CreateWidgetDialog } from '@/components/CreateWidgetDialog';
import { addWidgetConfig, getWidgetConfig, useWidgetConfigs } from '@/lib/widgetStore';
import { legacyConfigId } from '@/lib/legacyWidgets';
import { configIdFromKey, customKey, healedLegacyConfig, isCustomKey, type WidgetConfig } from '@/lib/widgetConfig';

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
 */
export function Home() {
  const pinned = useHomeBlocks();
  // Subscribe to the config store so a custom widget's edit / removal re-renders Home.
  useWidgetConfigs();
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

  // Persist a deterministic-id WidgetConfig for each pinned WIRED legacy widget (kpi / digest /
  // growth / top-posts) so its per-instance settings (period / source / title / size / style) stick
  // when edited. Runs ONCE per device (guarded by !getWidgetConfig) — which is also the one-time
  // MIGRATION seam: the card's identity moves from the old `home-<key>` prefs row to the config
  // (`custom-legacy-<key>`), so we carry the user's saved settings across instead of resetting them
  // (adversarial review found period/size/title/accent AND the pinned source — wrong-channel data —
  // would otherwise be orphaned). `hidden` isn't a config field → set it on the NEW ChartSection id;
  // the reorder slot follows via remapGroupOrder. Keyed on the membership string so it only re-runs
  // when the pinned set changes (getHomeBlocks returns a fresh array each render). The render below
  // heals from the same old prefs, so there's no first-paint reset before this lands. The bare
  // registry key stays in the (account-synced) pinned list as the stable cross-device pointer; the
  // config is device-local (widgetStore) and re-heals per device from that device's prefs.
  const pinnedSig = pinned.join('|');
  useEffect(() => {
    for (const key of pinned) {
      if (!isWiredLegacyKey(key) || getWidgetConfig(legacyConfigId(key))) continue;
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
      {/* Sticky page header — the Edit action stays reachable while scrolling the board (steep).
          Solid bg + a hairline (no blur/shadow per governance); bg bleeds to the content padding. */}
      <div className="sticky top-0 z-20 -mx-4 mb-6 flex items-start justify-between gap-3 border-b border-border bg-background px-4 py-3 sm:-mx-6 sm:px-6">
        <div>
          <h2 className="text-2xl font-medium tracking-tight text-foreground">Главная</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Ваши закреплённые виджеты.</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing}
          data-active={editing}
          className="edit-toggle btn-pill inline-flex h-9 shrink-0 items-center gap-1.5 px-3.5 text-sm font-medium"
        >
          <span className="edit-toggle-icons" aria-hidden="true">
            <svg className="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <svg className="i-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <span key={editing ? 'done' : 'edit'} className="edit-toggle-label">
            {editing ? 'Готово' : 'Изменить'}
          </span>
        </button>
      </div>

      {known.length === 0 && !editing ? (
        <HomeEmptyState onEdit={() => setEditing(true)} />
      ) : (
        <HomeEditContext.Provider value={editing}>
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
                // Wired legacy widget (U6.3a): render through ConfigWidget too, backed by a
                // deterministic-id config (persisted by the effect above; the fallback heals from the
                // same old `home-<key>` prefs so the first paint already carries the migrated period /
                // source / accent — no reset flash, right channel from frame one). homeKey stays the
                // bare registry key so the ⋯«Убрать с главной» / edit-mode × unpin work unchanged.
                if (isWiredLegacyKey(key)) {
                  const config =
                    getWidgetConfig(legacyConfigId(key)) ?? healedLegacyConfig(key, getWidgetPrefs(`home-${key}`));
                  if (!config) return null;
                  return (
                    <div key={key} className="contents">
                      <ConfigWidget config={config} homeKey={key} />
                    </div>
                  );
                }
                // Own-chrome legacy widget (history / velocity / heatmap / mentions): render() returns
                // a complete home-scoped ChartSection (home-<key> id) — still the legacy path until
                // U6.3b extracts its body. ChannelScope pins it to its «Источник» at the RENDER site.
                const def = HOME_REGISTRY[key];
                if (!def) return null;
                // Own-chrome legacy cards draw their own ChartSection, so a crash in their variant
                // compute (the one seam the in-card body boundary can't reach) is caught here with a
                // self-chromed «card» fallback — the flagship Home stays whole per-widget.
                return (
                  <div key={key} className="contents">
                    <WidgetErrorBoundary
                      variant="card"
                      widgetId={`home-${key}`}
                      label={def.label}
                      size={getWidgetPrefs(`home-${key}`).size ?? def.defaultSize ?? 'half'}
                    >
                      <ChannelScope channelId={getWidgetSource(`home-${key}`) ?? null}>
                        {def.render()}
                      </ChannelScope>
                    </WidgetErrorBoundary>
                  </div>
                );
              })}
            </WidgetGroup>
          </ChannelRecencyProvider>
          {editing && <AddWidgetBar pinned={pinned} />}
        </HomeEditContext.Provider>
      )}
    </div>
  );
}

/** Edit-mode picker: opens the metric catalogue (adds a config-driven `custom:<id>` widget) or
    pins a legacy registry widget not already on Home. Popover closes on outside click / Escape. */
function AddWidgetBar({ pinned }: { pinned: string[] }) {
  const [open, setOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [createMetric, setCreateMetric] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const available = Object.keys(HOME_REGISTRY).filter((key) => !pinned.includes(key));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Pick a metric → open the build step (preview + config), then pin the configured widget on «Добавить».
  const pickMetric = (metricId: string) => {
    setCatalogOpen(false);
    setCreateMetric(metricId);
  };
  const addConfigured = (config: WidgetConfig) => {
    const w = addWidgetConfig(config);
    if (w) pinToHome(customKey(w.id));
    setCreateMetric(null);
  };

  return (
    <div ref={ref} className="add-widget-enter relative mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="btn-pill border border-dashed border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
      >
        + Добавить виджет
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-card p-1.5">
          {/* Metric-first path: the searchable catalogue → a config-driven widget. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setCatalogOpen(true);
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
      {catalogOpen && <WidgetCatalogModal onPick={pickMetric} onClose={() => setCatalogOpen(false)} />}
      {createMetric && (
        <CreateWidgetDialog metricId={createMetric} onAdd={addConfigured} onClose={() => setCreateMetric(null)} />
      )}
    </div>
  );
}

/** First-ever Home: how to pin + a one-click default set (so the page is never a blank slate). */
function HomeEmptyState({ onEdit }: { onEdit: () => void }) {
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
          onClick={() => setHomeBlocks(HOME_DEFAULT_KEYS)}
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
