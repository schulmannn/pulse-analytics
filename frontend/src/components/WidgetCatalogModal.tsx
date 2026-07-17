import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { CATEGORY_LABEL, CATEGORY_ORDER, metricsForSource, type MetricDef, type WidgetViz } from '@/lib/widgetMetrics';

/**
 * The «Добавить метрику» catalogue — a searchable picker over the whole metric catalogue, grouped
 * by category, replacing the old fixed registry list with the steep-style «what do you want to
 * measure?» surface. Picking a metric hands its id back to the caller (which creates a WidgetConfig
 * with the metric's default visualisation and pins it). Legacy registry widgets stay addable via the
 * existing picker; this is the metric-first path alongside it.
 */

const SOURCE_LABEL: Record<'tg' | 'ig' | 'ms', string> = { tg: 'Telegram', ig: 'Instagram', ms: 'МойСклад' };
// All sources resolve now (TG: S3; IG: S11; МС: слайс 4). A metric with no data for the active
// channel still renders an honest «Нет данных» card, but the catalogue only offers metrics the
// resolver handles — вкладки не гейтятся по подключённости (канон TG/IG сохранён и для МС).
const AVAILABLE_SOURCES: Array<'tg' | 'ig' | 'ms'> = ['tg', 'ig', 'ms'];

export function WidgetCatalogModal({
  onPick,
  onClose,
}: {
  onPick: (metricId: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<'tg' | 'ig' | 'ms'>(AVAILABLE_SOURCES[0]);
  const [query, setQuery] = useState('');

  // Modal focus contract. Order matters: useFocusTrap's effect must run FIRST so it snapshots the
  // real opener before focus moves; the search field is then focused from the second effect (an
  // `autoFocus` attribute would fire during commit — before the trap — corrupting the opener
  // snapshot and getting overridden by the trap's panel.focus()).
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusTrap(panelRef);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  // Group the source's metrics by category, applying the search filter (label + formula text).
  // Table-kind metrics (weekly table / top posts) are served by the report + analytics surfaces —
  // a rich table doesn't read in a story-card tile — so the builder catalogue omits them.
  const groups = useMemo(() => {
    const all = metricsForSource(source).filter(
      (m) => m.kind !== 'table' && (!q || m.label.toLowerCase().includes(q) || (m.formula ?? '').toLowerCase().includes(q)),
    );
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      // Core metrics (those with a dedicated metric page = drillKey) lead their category so the
      // headline measures surface first for a new user.
      metrics: all
        .filter((m) => m.category === cat)
        .sort((a, b) => (a.drillKey ? 0 : 1) - (b.drillKey ? 0 : 1)),
    })).filter((g) => g.metrics.length > 0);
  }, [source, q]);

  const empty = groups.length === 0;

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm backdrop-grayscale sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Каталог метрик"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto w-full max-w-2xl rounded-xl border border-border bg-card p-5 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Добавить метрику</div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Source tabs (only when more than one source is available) + search. */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {AVAILABLE_SOURCES.length > 1 && (
            <div role="group" aria-label="Источник" className="flex overflow-hidden rounded-full border border-border">
              {AVAILABLE_SOURCES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={source === s}
                  onClick={() => setSource(s)}
                  className={`border-r border-border px-3 py-1.5 text-xs font-medium transition-colors last:border-r-0 ${
                    source === s ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  {SOURCE_LABEL[s]}
                </button>
              ))}
            </div>
          )}
          <input
            ref={searchRef}
            aria-label="Поиск метрики"
            value={query}
            placeholder="Поиск метрики…"
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Grouped metric cards. */}
        <div className="mt-4 max-h-[60vh] space-y-6 overflow-y-auto pr-1">
          {empty ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Ничего не найдено.</div>
          ) : (
            groups.map((g) => (
              <div key={g.cat}>
                <div className="mb-2.5 text-2xs font-medium tracking-wider text-muted-foreground">{CATEGORY_LABEL[g.cat]}</div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {g.metrics.map((m) => (
                    <MetricCard key={m.id} metric={m} q={q} onPick={() => onPick(m.id)} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MetricCard({ metric, q, onPick }: { metric: MetricDef; q: string; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-ink3/40 hover:bg-hover-row"
    >
      {/* Mini preview glyph — the visualisation the metric renders as (line/bar/donut/list/value). */}
      <VizGlyph viz={metric.defaultViz} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            <Highlight text={metric.label} q={q} />
          </span>
          {metric.drillKey && (
            <span className="shrink-0 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-2xs font-medium text-primary">
              Основная
            </span>
          )}
        </div>
        {metric.formula ? (
          <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            <Highlight text={metric.formula} q={q} />
          </span>
        ) : null}
      </div>
    </button>
  );
}

/** Highlight the matched search substring (case-insensitive, first match) so a filtered result
    shows WHY it matched. No match / empty query → plain text. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-primary/15 px-0.5 text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** A small stroke-only preview of the metric's default visualisation (steep-like «mini chart»
    hint), on a quiet chip. Kept lean per the icon governance — no fills except the kpi dot. */
function VizGlyph({ viz }: { viz: WidgetViz }) {
  const glyph = VIZ_GLYPH[viz] ?? VIZ_GLYPH.line;
  return (
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {glyph}
      </svg>
    </span>
  );
}

const VIZ_GLYPH: Partial<Record<WidgetViz, JSX.Element>> = {
  line: <path d="M3 16l5-6 4 3 5-8 4 5" />,
  bar: (
    <>
      <path d="M5 20V11" />
      <path d="M12 20V5" />
      <path d="M19 20v-6" />
    </>
  ),
  donut: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  list: <path d="M4 7h16M4 12h16M4 17h10" />,
  kpi: (
    <>
      <rect x="4" y="6.5" width="16" height="11" rx="2" />
      <path d="M8 13h6" />
      <circle cx="8" cy="10" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
};
