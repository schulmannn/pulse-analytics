import type { ReactNode } from 'react';
import { MediaThumb } from '@/components/MediaThumb';

export interface PinnedPostRow {
  key: string | number;
  thumb?: string | null;
  thumbLabel?: string;
  text: string;
  value: string;
  /** In-app open (TG → PostDetailModal). */
  onOpen?: () => void;
  /** External permalink (IG — the app has no in-app IG post modal). */
  href?: string | null;
}

/** Visual register. `default` keeps the shared caption/rows look (IG); `detail` is the metric
    explorer's redesigned card — prominent date, bordered stat tiles — matching its chart tooltip. */
type PinnedAppearance = 'default' | 'detail';

/**
 * The pinned-point panel (steep's point drill, adapted): a click on a chart point pins it —
 * this panel anchors under the chart with the day's numbers and THE POSTS OF THAT DAY, so a
 * spike is explained without leaving the page. Shared by the TG and IG metric pages; the pin
 * marker itself is drawn by LineChart/BarChart via `pinnedIndex`. The `appearance` prop is
 * backward-compatible (default = the original look) — only the TG metric page opts into `detail`.
 */
export function PinnedDayPanel({
  dateLabel,
  rows,
  posts,
  postsTitle = 'Посты этого дня',
  postsEmpty = 'В этот день публикаций не было.',
  showPosts = true,
  appearance = 'default',
  onClose,
  footer,
}: {
  dateLabel: string;
  rows: { label: string; value: ReactNode }[];
  posts?: PinnedPostRow[];
  postsTitle?: string;
  postsEmpty?: string;
  /** Off for metrics whose series isn't post-addressable (subscriber levels on «Всё»/weeks). */
  showPosts?: boolean;
  appearance?: PinnedAppearance;
  onClose: () => void;
  /** Host-page extras under the panel (метрик-страница: события дня — chart_annotations). */
  footer?: ReactNode;
}) {
  const detail = appearance === 'detail';
  return (
    <section
      data-pinned-day={appearance}
      className={`rounded-2xl border border-border bg-card p-4 dark:border-white/[0.06] sm:p-5 ${detail ? 'shadow-sm' : ''}`}
    >
      <div className="flex items-center gap-3">
        {detail ? (
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-medium tracking-wider text-muted-foreground">Точка дня</div>
            <h3 title={dateLabel} className="mt-0.5 truncate text-base font-medium tracking-tight text-foreground">
              {dateLabel}
            </h3>
          </div>
        ) : (
          <h3 className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-muted-foreground">
            Точка · {dateLabel}
          </h3>
        )}
        <button
          type="button"
          aria-label="Снять выделение точки"
          title="Снять выделение"
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {detail ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {rows.map((r) => (
            <div key={r.label} className="rounded-lg border border-border bg-background/40 px-3 py-2 dark:border-white/[0.06]">
              <div className="text-2xs tracking-wide text-muted-foreground">{r.label}</div>
              <div className="mt-1 text-sm font-medium tabular-nums text-foreground">{r.value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {rows.map((r) => (
            <div key={r.label}>
              <div className="text-2xs tracking-wide text-muted-foreground">{r.label}</div>
              <div className="mt-0.5 text-sm font-medium tabular-nums">{r.value}</div>
            </div>
          ))}
        </div>
      )}

      {showPosts && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="text-2xs tracking-wide text-muted-foreground">{postsTitle}</div>
          {posts && posts.length > 0 ? (
            <ul className="mt-1">
              {posts.map((p) => {
                const inner = (
                  <>
                    <MediaThumb src={p.thumb} label={p.thumbLabel} className="h-8 w-8" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{p.text}</span>
                    <span className="shrink-0 text-sm font-medium tabular-nums">{p.value}</span>
                  </>
                );
                const rowCls = `flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-hover-row ${
                  detail ? 'rounded-lg px-2' : ''
                }`;
                return (
                  <li key={p.key} className={detail ? '' : 'border-t border-border first:border-t-0'}>
                    {p.onOpen ? (
                      <button type="button" onClick={p.onOpen} className={rowCls}>
                        {inner}
                      </button>
                    ) : p.href ? (
                      <a href={p.href} target="_blank" rel="noreferrer" className={rowCls}>
                        {inner}
                      </a>
                    ) : (
                      <div className={rowCls}>{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{postsEmpty}</p>
          )}
        </div>
      )}
      {footer}
    </section>
  );
}
