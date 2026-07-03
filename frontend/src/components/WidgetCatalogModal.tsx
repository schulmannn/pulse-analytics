import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  metricsForSource,
  type MetricDef,
  type WidgetViz,
} from '@/lib/widgetMetrics';

/**
 * The «Добавить метрику» catalogue — a searchable picker over the whole metric catalogue, grouped
 * by category, replacing the old fixed registry list with the steep-style «what do you want to
 * measure?» surface. Picking a metric hands its id back to the caller (which creates a WidgetConfig
 * with the metric's default visualisation and pins it). Legacy registry widgets stay addable via the
 * existing picker; this is the metric-first path alongside it.
 */

const VIZ_LABEL: Record<WidgetViz, string> = {
  kpi: 'Число',
  line: 'Линия',
  bar: 'Столбцы',
  donut: 'Круговая',
  list: 'Список',
  rank: 'Рейтинг',
  pivot: 'Сводная',
  table: 'Таблица',
  ledger: 'Значения',
};

const SOURCE_LABEL: Record<'tg' | 'ig', string> = { tg: 'Telegram', ig: 'Instagram' };
// Only sources the resolver can actually produce data for are offered — IG resolves to empty until
// S11 wires its paths, so showing IG metrics now would add cards that render «Нет данных». Add 'ig'
// here once S11 lands.
const AVAILABLE_SOURCES: Array<'tg' | 'ig'> = ['tg'];

export function WidgetCatalogModal({
  onPick,
  onClose,
}: {
  onPick: (metricId: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<'tg' | 'ig'>(AVAILABLE_SOURCES[0]);
  const [query, setQuery] = useState('');

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
  const groups = useMemo(() => {
    const all = metricsForSource(source).filter(
      (m) => !q || m.label.toLowerCase().includes(q) || (m.formula ?? '').toLowerCase().includes(q),
    );
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      metrics: all.filter((m) => m.category === cat),
    })).filter((g) => g.metrics.length > 0);
  }, [source, q]);

  const empty = groups.length === 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Каталог метрик"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-2xl rounded-xl border border-border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Добавить метрику</div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Source tabs (only when more than one source is available) + search. */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {AVAILABLE_SOURCES.length > 1 && (
            <div role="group" aria-label="Источник" className="flex overflow-hidden rounded border border-border">
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
            autoFocus
            value={query}
            placeholder="Поиск метрики…"
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Grouped metric cards. */}
        <div className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {empty ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Ничего не найдено.</div>
          ) : (
            groups.map((g) => (
              <div key={g.cat}>
                <div className="mb-2 text-2xs font-medium tracking-wider text-muted-foreground">{CATEGORY_LABEL[g.cat]}</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {g.metrics.map((m) => (
                    <MetricCard key={m.id} metric={m} onPick={() => onPick(m.id)} />
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

function MetricCard({ metric, onPick }: { metric: MetricDef; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-ink3/40 hover:bg-hover-row"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{metric.label}</span>
        <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
          {VIZ_LABEL[metric.defaultViz]}
        </span>
      </div>
      {metric.formula ? <span className="line-clamp-2 text-xs text-muted-foreground">{metric.formula}</span> : null}
    </button>
  );
}
