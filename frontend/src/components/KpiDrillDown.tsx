import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NormalizedPost } from '@/lib/posts';
import type { MetricDelta } from '@/lib/delta';
import type { MetricKey } from '@/lib/metricDefs';
import { METRIC_DEFS } from '@/lib/metricDefs';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { DeltaPill } from '@/components/DeltaPill';
import { MetricInfo } from '@/components/InfoTooltip';
import { BarChart } from '@/components/BarChart';
import { LineChart } from '@/components/LineChart';
import { PostDetailModal } from '@/components/PostDetailModal';

// Which NormalizedPost field a metric attributes to. null = no per-post attribution (subscribers).
const FIELD: Partial<Record<MetricKey, keyof Pick<NormalizedPost, 'reach' | 'likes' | 'shares' | 'eng'>>> = {
  views: 'reach',
  avgReach: 'reach',
  reactions: 'likes',
  forwards: 'shares',
  er: 'eng',
};

const CONTRIB_LABEL: Partial<Record<MetricKey, string>> = {
  views: 'просмотрам',
  avgReach: 'охвату',
  reactions: 'реакциям',
  forwards: 'репостам',
  er: 'вовлечённости',
};

// Per-day section heading. Ratio metrics (avgReach/ER) are derived from a sum, so the bars show
// that underlying sum (reach / engagement), not the ratio itself — the heading says so.
const DAY_TITLE: Partial<Record<MetricKey, string>> = {
  subscribers: 'Подписчики по дням',
  avgReach: 'Просмотры по дням',
  er: 'Вовлечённость по дням',
};
// What a per-post contribution is a share OF. For ratio metrics the share is of the underlying
// sum (total reach / total engagement), NOT of the shown average/percentage.
const SHARE_LABEL: Partial<Record<MetricKey, string>> = {
  avgReach: '% охвата',
  er: '% вовлечённости',
};

interface DailySeries {
  labels: string[];
  values: number[];
}

interface KpiDrillDownProps {
  metricKey: MetricKey;
  /** Normalized posts already filtered to the active window. */
  posts: NormalizedPost[];
  /** Subscriber daily series (for the subscribers metric, which has no per-post attribution). */
  subsSeries: DailySeries;
  total: string;
  trend?: MetricDelta | null;
  caption?: string | null;
  /** Subscriber count — the ER divisor, used to reconcile the ER drill (ER = Σ eng ÷ members). */
  members?: number;
  onClose: () => void;
}

function bucketByDay(posts: NormalizedPost[], field: keyof NormalizedPost): DailySeries {
  const byDay = new Map<string, number>();
  for (const post of posts) {
    if (!post.date) continue;
    const t = Date.parse(post.date);
    if (!Number.isFinite(t)) continue;
    const key = new Date(t).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(post[field] ?? 0));
  }
  const entries = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { labels: entries.map(([k]) => fmt.day(k)), values: entries.map(([, v]) => v) };
}

/**
 * Drill-down for a KPI: how the number breaks down by day and which posts drove it. Opened from
 * a KPI card. For SUM metrics (views/reactions/forwards) the per-post attribution reconciles
 * exactly with the headline. For RATIO metrics (avgReach = Σviews÷posts, ER = Σeng÷members) the
 * headline is a derived ratio, so the breakdown shows the underlying SUM it's built from and the
 * footer states the reconciliation explicitly. Subscribers (a channel count) shows the daily
 * line. Rows open the full post detail. Reuses the PostDetailModal shell (portal, Escape, scroll
 * lock, focus trap); Escape closes the post sub-modal first, then this.
 */
export function KpiDrillDown({ metricKey, posts, subsSeries, total, trend, caption, members, onClose }: KpiDrillDownProps) {
  const [openPost, setOpenPost] = useState<NormalizedPost | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  const def = METRIC_DEFS[metricKey];
  const field = FIELD[metricKey];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Let the post sub-modal consume Escape first; only close the drill when it's not open.
      if (e.key === 'Escape' && !openPost) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, openPost]);

  const daily = field ? bucketByDay(posts, field) : subsSeries;
  const contributors = field
    ? posts
        .filter((p) => Number(p[field] ?? 0) > 0)
        .sort((a, b) => Number(b[field] ?? 0) - Number(a[field] ?? 0))
        .slice(0, 8)
    : [];
  const contribTotal = field ? contributors.reduce((s, p) => s + Number(p[field] ?? 0), 0) : 0;
  const fieldSumAll = field ? posts.reduce((s, p) => s + Number(p[field] ?? 0), 0) : 0;

  // Footer line: for ratio metrics, show the reconciliation (sum ÷ divisor = headline); for sum
  // metrics, how much of the period the shown posts account for.
  let reconcile = '';
  if (field) {
    if (metricKey === 'er' && members && members > 0) {
      reconcile = `ER = ${fmt.short(fieldSumAll)} вовлечений ÷ ${fmt.num(members)} подписчиков × 100% = ${total}`;
    } else if (metricKey === 'avgReach' && posts.length > 0) {
      reconcile = `Средний охват = ${fmt.short(fieldSumAll)} просмотров ÷ ${posts.length} постов = ${total}`;
    } else if (contributors.length > 0 && contribTotal > 0 && fieldSumAll > 0) {
      reconcile = `Эти ${contributors.length} постов дали ${Math.round((contribTotal / fieldSumAll) * 100)}% от периода.`;
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Разбор: ${def.term}`}
    >
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border bg-card shadow-xl focus:outline-none sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{def.term}</span>
              <MetricInfo def={def} />
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">{total}</span>
              <DeltaPill delta={trend} />
            </div>
            {caption && <div className="text-xs text-muted-foreground">{caption}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 overflow-y-auto p-5">
          {/* Per-day breakdown */}
          <div>
            <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
              {DAY_TITLE[metricKey] ?? 'По дням'}
            </div>
            {metricKey === 'subscribers' ? (
              daily.values.length > 1 ? (
                <LineChart
                  values={daily.values}
                  labels={daily.labels}
                  titles={daily.values.map((v, i) => `${daily.labels[i]}: ${fmt.num(v)}`)}
                  height={180}
                />
              ) : (
                <EmptyHint />
              )
            ) : daily.values.length > 0 ? (
              <BarChart
                values={daily.values}
                labels={daily.labels}
                titles={daily.values.map((v, i) => `${daily.labels[i]}: ${fmt.short(v)}`)}
                height={160}
              />
            ) : (
              <EmptyHint />
            )}
          </div>

          {/* Contributing posts (post-based metrics only) */}
          {field && (
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
                Топ постов по {CONTRIB_LABEL[metricKey] ?? 'метрике'}
              </div>
              {contributors.length > 0 ? (
                <ul className="space-y-1.5">
                  {contributors.map((post, i) => {
                    const value = Number(post[field] ?? 0);
                    const share = fieldSumAll > 0 ? Math.round((value / fieldSumAll) * 100) : 0;
                    const text = post.caption ? markdownToPlainText(post.caption) : 'Без подписи';
                    return (
                      <li key={post.id ?? i}>
                        <button
                          type="button"
                          onClick={() => setOpenPost(post)}
                          className="flex w-full items-center gap-3 rounded-lg border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-muted/40"
                        >
                          <span className="w-5 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">
                            {i + 1}
                          </span>
                          {post.thumb ? (
                            <img
                              src={`${post.thumb}?size=sm`}
                              alt=""
                              referrerPolicy="no-referrer"
                              className="h-9 w-9 shrink-0 rounded object-cover"
                            />
                          ) : (
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-[9px] text-muted-foreground">
                              текст
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{text}</span>
                          <span className="shrink-0 text-right">
                            <span className="block text-sm font-semibold tabular-nums">{fmt.short(value)}</span>
                            {share > 0 && (
                              <span className="block text-[10px] text-muted-foreground">
                                {share}
                                {SHARE_LABEL[metricKey] ?? '% периода'}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyHint />
              )}
              {reconcile && <p className="mt-2 text-xs text-muted-foreground">{reconcile}</p>}
            </div>
          )}
        </div>
      </div>

      {openPost && (
        <PostDetailModal post={openPost} rank={contributors.indexOf(openPost) + 1} reason={null} onClose={() => setOpenPost(null)} />
      )}
    </div>,
    document.body,
  );
}

function EmptyHint() {
  return <div className="py-6 text-center text-sm text-muted-foreground">Недостаточно данных за период.</div>;
}
