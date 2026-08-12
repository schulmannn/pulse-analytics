import { useState } from 'react';
import type { IgPost } from '@/api/schemas';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RichText } from '@/components/RichText';
import { SourceIdentity } from '@/components/SourceIdentity';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogSurface,
  DialogTitle,
  useRestoreOpenerFocus,
} from '@/components/ui/dialog';
import { Icon } from '@/components/nav-icons';
import { useLayerBack } from '@/lib/useLayerBack';
import { MEDIA_TYPE_LABEL } from '@/lib/igMetrics';
import { igEr, igHashtags, igInteractions } from '@/lib/igContentFilters';
import { type MedianComparison, medianDeltaLabel } from '@/lib/postMedian';

interface IgPostDetailModalProps {
  post: IgPost;
  /** Honest reach-vs-median context (null when the min-sample gate isn't met). */
  reachComparison: MedianComparison | null;
  /** Explain why no benchmark is shown instead of leaving an unexplained blank. */
  benchmarkUnavailable?: boolean;
  /** Optional «Добавить в кампанию» footer action (Content page). */
  onAddToCampaign?: () => void;
  onClose: () => void;
}

/** A labelled metric cell (tabular-aligned), «—» when the field is missing. */
function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-medium tabular-nums', accent && 'text-primary')}>{value}</div>
    </div>
  );
}

/** Neutral stroke glyph for a missing/broken preview — play for video, photo otherwise. */
function MediaFallback({ video }: { video: boolean }) {
  return (
    <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-muted text-muted-foreground">
      {video ? (
        <Icon name="playCircle" className="h-10 w-10" />
      ) : (
        <Icon name="image" className="h-10 w-10" />
      )}
    </div>
  );
}

/**
 * THE Instagram post overlay — the IG twin of {@link import('@/components/PostDetailModal')}, kept
 * separate because the fields (reach/plays/saves/shares, media_product_type, permalink to Instagram)
 * and the honest ER definition differ from Telegram's NormalizedPost. Same modal contract: portal,
 * focus trap, Escape / backdrop / × close, browser-Back close, body-scroll lock, focus restore.
 * Wide two-column layout on desktop (preview + caption left, metrics + benchmark right).
 */
export function IgPostDetailModal({
  post,
  reachComparison,
  benchmarkUnavailable = false,
  onAddToCampaign,
  onClose,
}: IgPostDetailModalProps) {
  const [previewFailed, setPreviewFailed] = useState(false);
  useLayerBack(onClose);
  const restoreOpener = useRestoreOpenerFocus();

  const isVideo = post.media_type === 'VIDEO' || post.media_product_type === 'REELS';
  // For video posts media_url is the video file (blank in <img>); only a real thumbnail is a cover.
  const cover = post.thumbnail_url || (!isVideo ? post.media_url : null) || null;
  const hasPreview = !!cover && !previewFailed;
  const typeLabel =
    (post.media_product_type === 'REELS' ? 'Reels' : MEDIA_TYPE_LABEL[post.media_type ?? '']) ?? 'Публикация';
  const hashtags = igHashtags(post);
  const interactions = igInteractions(post);
  const er = igEr(post);
  const reasonTone = reachComparison?.dir === 'above' ? 'positive' : reachComparison?.dir === 'below' ? 'negative' : 'neutral';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <div className="fixed inset-0 z-modal flex items-end justify-center sm:items-center">
          <DialogSurface
            aria-label="Детали публикации"
            onCloseAutoFocus={restoreOpener}
            className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border bg-card sm:rounded-2xl lg:max-w-4xl"
          >
            <DialogTitle className="sr-only">Детали публикации</DialogTitle>
            {/* Header */}
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div className="flex items-center gap-2.5">
                <span className="hidden lg:inline-flex">
                  <SourceIdentity network="ig" className="inline-flex" />
                </span>
                <span className="rounded bg-secondary px-2 py-0.5 text-2xs font-medium text-secondary-foreground">
                  {typeLabel}
                </span>
                {post.timestamp && (
                  <span className="text-sm text-muted-foreground">{fmt.date(post.timestamp)}</span>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть"
                className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:h-8 sm:w-8"
              >
                <Icon name="close" className="h-4 w-4" />
              </button>
            </div>

            {/* Body: single column on mobile, two grouped columns on desktop. */}
            <div
              className={cn(
                'flex flex-col gap-4 overflow-y-auto p-5 lg:p-6',
                'lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)] lg:items-start lg:gap-x-6',
              )}
            >
              {/* MEDIA column: preview + full caption + hashtags */}
              <div className="contents lg:flex lg:flex-col lg:gap-4">
                <div className="order-1">
                  {hasPreview ? (
                    <img
                      src={cover ?? undefined}
                      alt=""
                      referrerPolicy="no-referrer"
                      ref={(node) => {
                        if (node) node.onerror = () => setPreviewFailed(true);
                      }}
                      className="max-h-72 w-full rounded-lg object-cover lg:max-h-104"
                    />
                  ) : (
                    <MediaFallback video={isVideo} />
                  )}
                </div>

                <p className="order-3 whitespace-pre-line text-sm leading-relaxed text-foreground">
                  {post.caption ? (
                    <RichText text={post.caption} />
                  ) : (
                    <span className="italic text-muted-foreground">Без подписи</span>
                  )}
                </p>

                {hashtags.length > 0 && (
                  <div className="order-5 flex flex-wrap gap-1.5">
                    {hashtags.map((tag, i) => (
                      <span key={`${tag}-${i}`} className="text-xs font-medium text-primary">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* DATA column: benchmark context + metrics */}
              <div className="contents lg:flex lg:flex-col lg:gap-4">
                {reachComparison && (
                  // Зеркало PostDetailModal: дельта «к медиане» читается MUTED и в ячейке таблицы,
                  // и в модалке этой же строки — одно сравнение не может звучать двумя голосами.
                  <p className="order-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <span aria-hidden="true">
                      {reasonTone === 'positive' ? '▲' : reasonTone === 'negative' ? '▼' : '•'}
                    </span>
                    Охват {medianDeltaLabel(reachComparison)}
                  </p>
                )}
                {!reachComparison && benchmarkUnavailable && (
                  <p className="order-2 hidden text-xs text-muted-foreground lg:block">
                    Недостаточно публикаций для сравнения с медианой периода
                  </p>
                )}

                <div className="order-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
                  <Stat label="Охват" value={fmt.num(post.reach)} accent />
                  <Stat label="Просмотры" value={fmt.num(post.views)} />
                  <Stat label="Взаимодействия" value={fmt.num(interactions)} />
                  <Stat label="ER" value={er != null ? `${er.toFixed(2)}%` : '—'} />
                  <Stat label="Сохранения" value={fmt.num(post.saved)} />
                  <Stat label="Репосты" value={fmt.num(post.shares)} />
                  <Stat label="Лайки" value={fmt.num(post.like_count)} />
                  <Stat label="Комментарии" value={fmt.num(post.comments_count)} />
                </div>
              </div>
            </div>

            {/* Footer: permalink out + optional campaign action */}
            {(!!post.permalink || !!onAddToCampaign) && (
              <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
                {post.permalink ? (
                  <a
                    href={post.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                  >
                    Открыть в Instagram
                    <Icon name="external" className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span />
                )}
                {onAddToCampaign && (
                  <Button type="button" onClick={onAddToCampaign} size="xs" className="px-3.5">
                    Добавить в кампанию
                  </Button>
                )}
              </div>
            )}
          </DialogSurface>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
