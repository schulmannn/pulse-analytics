import { Link } from 'react-router-dom';
import { WidgetGroup, useHomeBlocks, setHomeBlocks } from '@/components/ChartWidget';
import { HOME_REGISTRY, HOME_DEFAULT_KEYS } from '@/lib/homeWidgets';

/**
 * Personal Home — a per-user board of the widgets the reader pinned via the ⋯ «На главную» item
 * on any screen. It renders each pinned registry key (in order) as a home-scoped card inside ONE
 * reorderable WidgetGroup (id="home"), so reorder/jiggle/FLIP, per-widget size/period and the
 * expand overlay all work for free — and the Home arrangement is a distinct prefs identity from
 * the source screen (home-<key> ids). Stale keys (a removed/renamed registry entry) are skipped
 * silently. Empty on first visit → a CTA explaining how to pin, plus a one-click default set.
 */
export function Home() {
  const pinned = useHomeBlocks();
  // Skip any pinned key whose registry entry is gone (renamed/removed widget) — never crash.
  const known = pinned.filter((key) => HOME_REGISTRY[key]);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-medium tracking-tight text-foreground">Главная</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Ваши закреплённые виджеты.</p>
      </div>

      {known.length === 0 ? (
        <HomeEmptyState />
      ) : (
        <WidgetGroup id="home" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
          {known.map((key) => (
            // The registry render() returns a complete home-scoped ChartSection (home-<key> id).
            // React key = the registry key (stable, unique in the list).
            <div key={key} className="contents">
              {HOME_REGISTRY[key]!.render()}
            </div>
          ))}
        </WidgetGroup>
      )}
    </div>
  );
}

/** First-ever Home: how to pin + a one-click default set (so the page is never a blank slate). */
function HomeEmptyState() {
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
        Откройте Обзор или Аналитику и нажмите ⋯ → «На главную» на любом виджете, чтобы закрепить
        его здесь.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/"
          className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Открыть Обзор
        </Link>
        <button
          type="button"
          onClick={() => setHomeBlocks(HOME_DEFAULT_KEYS)}
          className="btn-pill border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Собрать по умолчанию
        </button>
      </div>
    </div>
  );
}
