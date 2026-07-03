import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider } from '@/lib/period';
import {
  HomeEditContext,
  WidgetGroup,
  getWidgetSource,
  pinToHome,
  setHomeBlocks,
  useHomeBlocks,
} from '@/components/ChartWidget';
import { ChannelScope } from '@/lib/channel-context';
import { HOME_REGISTRY, HOME_DEFAULT_KEYS } from '@/lib/homeWidgets';

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
  // Skip any pinned key whose registry entry is gone (renamed/removed widget) — never crash.
  const known = pinned.filter((key) => HOME_REGISTRY[key]);
  const [editing, setEditing] = useState(false);
  // Channel recency (same deduped fetch the pinned cards make) → widget cards widen an empty window
  // so a dormant channel's pinned KPIs aren't blank. See resolveEffectivePeriod / TgFeed.
  const { data: tgFull } = useTgFull(0);
  const { data: history } = useHistory(730);
  const recency = useMemo(() => latestDataMs(tgFull?.posts, history), [tgFull, history]);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-medium tracking-tight text-foreground">Главная</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Ваши закреплённые виджеты.</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          aria-pressed={editing}
          className={
            editing
              ? 'btn-pill shrink-0 bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
              : 'btn-pill shrink-0 border border-border px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          {editing ? 'Готово' : 'Изменить'}
        </button>
      </div>

      {known.length === 0 && !editing ? (
        <HomeEmptyState onEdit={() => setEditing(true)} />
      ) : (
        <HomeEditContext.Provider value={editing}>
          <ChannelRecencyProvider value={recency}>
            <WidgetGroup id="home" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
              {known.map((key) => (
                // The registry render() returns a complete home-scoped ChartSection (home-<key> id).
                // React key = the registry key (stable, unique in the list). ChannelScope pins the
                // card to its «Источник» (edit dialog): it wraps the RENDER site because the
                // block's own data hooks must read the override, not just the card body.
                <div key={key} className="contents">
                  <ChannelScope channelId={getWidgetSource(`home-${key}`) ?? null}>
                    {HOME_REGISTRY[key]!.render()}
                  </ChannelScope>
                </div>
              ))}
            </WidgetGroup>
          </ChannelRecencyProvider>
          {editing && <AddWidgetBar pinned={pinned} />}
        </HomeEditContext.Provider>
      )}
    </div>
  );
}

/** Edit-mode picker: pins any catalog widget not already on Home. Hidden entirely once every
    registry widget is pinned (the button disables). Popover closes on outside click / Escape. */
function AddWidgetBar({ pinned }: { pinned: string[] }) {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={ref} className="relative mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={available.length === 0}
        aria-expanded={open}
        className="btn-pill border border-dashed border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-solid hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        {available.length === 0 ? 'Все виджеты добавлены' : '+ Добавить виджет'}
      </button>
      {open && available.length > 0 && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-card p-1.5">
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
        </div>
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
