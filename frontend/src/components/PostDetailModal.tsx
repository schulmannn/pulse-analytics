import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePostStats } from '@/api/queries';
import type { NormalizedPost } from '@/lib/posts';
import { fmt, ruAxisLabel } from '@/lib/format';
import { MetricInfo } from '@/components/InfoTooltip';
import { getDrillMetric, getMetric, type MetricDef } from '@/lib/widgetMetrics';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useLayerBack } from '@/lib/useLayerBack';
import { LineChart } from '@/components/LineChart';
import { RichText } from '@/components/RichText';
import { Skeleton } from '@/components/ui/skeleton';

interface PostDetailModalProps {
  post: NormalizedPost;
  /** Leaderboard position badge; omit where the list order is a transient sort. */
  rank?: number;
  reason: string | null;
  onClose: () => void;
}

/** A labelled metric cell (tabular-aligned). */
function Stat({ label, value, accent, info }: { label: string; value: string; accent?: boolean; info?: MetricDef }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="flex items-center gap-1 text-2xs tracking-wide text-muted-foreground">
        <span>{label}</span>
        {info && <MetricInfo def={info} />}
      </div>
      <div className={`mt-0.5 text-lg font-medium tabular-nums ${accent ? 'text-primary' : ''}`}>
        {value}
      </div>
    </div>
  );
}

/**
 * THE post overlay — the app's single post modal (the Posts table used to open its own
 * simpler one, D6.2). Shows the full caption (markdown-rendered), the preview, the view
 * velocity graph («жизнь поста», when Telegram has stats), the complete reactions breakdown,
 * engagement ratios, hashtags, publish time, and a link out to Telegram. Rendered in a portal
 * so the card's `overflow-hidden` never clips it. Closes on Escape, backdrop click, or the ×
 * button; locks body scroll while open.
 */
export function PostDetailModal({ post, rank, reason, onClose }: PostDetailModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  // Browser Back / the phone's back gesture closes the modal instead of leaving the page.
  useLayerBack(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const pct = (v: number | null, digits: number) => (v != null ? `${v.toFixed(digits)}%` : '—');

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={rank != null ? `Детали поста №${rank}` : 'Детали поста'}
    >
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm backdrop-grayscale"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border bg-card focus:outline-none sm:rounded-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2.5">
            {rank != null && (
              <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums text-secondary-foreground">
                №{rank}
              </span>
            )}
            {post.date && (
              <span className="text-sm text-muted-foreground">{fmt.date(post.date)}</span>
            )}
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

        {/* Scrollable body */}
        <div className="space-y-4 overflow-y-auto p-5">
          {post.thumb && (
            <img
              src={`${post.thumb}?size=lg`}
              alt={rank != null ? `Превью поста №${rank}` : 'Превью поста'}
              referrerPolicy="no-referrer"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
              className="max-h-72 w-full rounded-lg object-cover"
            />
          )}

          {reason && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-verdant">
              <span aria-hidden="true">▲</span>
              {reason}
            </p>
          )}

          <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
            {post.caption ? (
              <RichText text={post.caption} />
            ) : (
              <span className="italic text-muted-foreground">Без подписи</span>
            )}
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Просмотры" value={fmt.num(post.reach)} />
            <Stat label="Реакции" value={fmt.num(post.likes)} />
            <Stat label="Репосты" value={fmt.num(post.shares)} />
            <Stat label="Комментарии" value={fmt.num(post.comments)} />
          </div>

          {(post.er != null || post.erv != null || post.virality != null) && (
            <div className="grid grid-cols-3 gap-2">
              {/* ⓘ с формулами: модалка — первая встреча новичка с терминами (аудит). */}
              <Stat label="ER" value={pct(post.er, 2)} accent info={getDrillMetric('er')} />
              <Stat label="ERV" value={pct(post.erv, 1)} info={getMetric('tg.erv')} />
              <Stat label="Виральность" value={pct(post.virality, 1)} info={getMetric('tg.virality')} />
            </div>
          )}

          <PostVelocity postId={post.id} />

          {post.reactionsDetail.length > 0 && (
            <div>
              <div className="mb-1.5 text-2xs tracking-wide text-muted-foreground">Реакции</div>
              <div className="flex flex-wrap gap-1.5">
                {post.reactionsDetail.map((r, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-sm font-medium tabular-nums text-secondary-foreground"
                  >
                    <span>{r.emoji}</span>
                    <span>{fmt.num(r.count)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {post.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {post.hashtags.map((tag, i) => (
                <span key={i} className="text-xs font-medium text-primary">
                  #{tag.replace(/^#/, '')}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!!post.permalink && (
          <div className="border-t px-5 py-3">
            <a
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              Открыть в Telegram
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * «Жизнь поста» — the incremental view-velocity graph from Telegram's per-post stats
 * (absorbed from the Posts table's former own modal, D6.2). Quietly renders nothing when
 * Telegram has no stats for the post — the modal has plenty of content without it.
 */
function PostVelocity({ postId }: { postId: number | null }) {
  const stats = usePostStats(postId);

  if (postId == null) return null;
  if (stats.isPending) {
    return (
      <div className="space-y-3 border-t border-border pt-4">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const graphX = stats.data?.views_graph?.x ?? [];
  const graphValues = stats.data?.views_graph?.series?.[0]?.values ?? [];
  if (!(stats.data?.available ?? false) || graphValues.length <= 1) return null;

  const titles = graphX.map((ts, i) => {
    const dateStr = new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit' });
    return `${dateStr}: ${fmt.num(graphValues[i] ?? 0)}`;
  });
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formatLabel = (ts: number) => {
    const d = new Date(ts);
    // ruAxisLabel: «24 Jun 21:00» → «24 июн 21:00» — axis labels must be Russian in the RU UI.
    return ruAxisLabel(`${d.getDate()} ${months[d.getMonth()] ?? ''} ${String(d.getHours()).padStart(2, '0')}:00`);
  };
  const first = graphX[0];
  const mid = graphX[Math.floor(graphX.length / 2)];
  const last = graphX[graphX.length - 1];
  const labels = [first ? formatLabel(first) : '', mid ? formatLabel(mid) : '', last ? formatLabel(last) : ''];

  return (
    <div className="border-t border-border pt-4">
      <h4 className="mb-3 text-xs font-medium tracking-wider text-muted-foreground">
        Динамика набора просмотров
      </h4>
      <LineChart values={graphValues} titles={titles} labels={labels} />
    </div>
  );
}
