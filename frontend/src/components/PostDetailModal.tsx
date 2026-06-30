import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { RichText } from '@/components/RichText';

interface PostDetailModalProps {
  post: NormalizedPost;
  rank: number;
  reason: string | null;
  onClose: () => void;
}

/** A labelled metric cell (tabular-aligned). */
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="text-[11px] tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-medium tabular-nums ${accent ? 'text-primary' : ''}`}>
        {value}
      </div>
    </div>
  );
}

/**
 * Post detail overlay opened from a top-post card. Shows the full caption (markdown-rendered),
 * the preview, the complete reactions breakdown, engagement ratios, hashtags, publish time, and
 * a link out to Telegram. Rendered in a portal so the card's `overflow-hidden` never clips it.
 * Closes on Escape, backdrop click, or the × button; locks body scroll while open.
 */
export function PostDetailModal({ post, rank, reason, onClose }: PostDetailModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
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
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Детали поста №${rank}`}
    >
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
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
            <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums text-secondary-foreground">
              №{rank}
            </span>
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
              alt={`Превью поста №${rank}`}
              referrerPolicy="no-referrer"
              className="max-h-72 w-full rounded-lg object-cover"
            />
          )}

          {reason && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-verdant/10 px-2.5 py-1 text-xs font-medium text-verdant">
              <span aria-hidden="true">▲</span>
              {reason}
            </div>
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
              <Stat label="ER" value={pct(post.er, 2)} accent />
              <Stat label="ERV" value={pct(post.erv, 1)} />
              <Stat label="Виральность" value={pct(post.virality, 1)} />
            </div>
          )}

          {post.reactionsDetail.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] tracking-wide text-muted-foreground">Реакции</div>
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
        {post.permalink && (
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
