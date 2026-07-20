import { useState } from 'react';
import { fmt } from '@/lib/format';
import { EmptyState } from '@/components/EmptyState';
import { BarChart } from '@/components/BarChart';
import { RichText } from '@/components/RichText';
import { KpiCard, Stat } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { breakdownVariants } from '@/components/widgets/variants';
import type { IgPost, IgStory, IgTag } from '@/api/schemas';
import {
  hashtagStats,
  postEr,
  fmtDay,
  MEDIA_PRODUCT_LABEL,
  MEDIA_PRODUCT_CHART,
  MEDIA_TYPE_LABEL,
  NAV_LABEL,
} from '@/lib/igMetrics';

// ── Forms / formats breakdown ──
/** Own ChartSection widget — the full presentation set (list/bars/pie/bar+ledger) + expand. */
export function FormatsBlock({ items }: { items: { label: string; value: number }[] }) {
  const list = [...items]
    .sort((a, b) => b.value - a.value)
    .map((it) => ({
      label: MEDIA_PRODUCT_LABEL[it.label] ?? it.label,
      value: it.value,
      display: fmt.short(it.value),
      color: MEDIA_PRODUCT_CHART[it.label],
    }));
  if (list.length === 0) {
    return (
      <ChartSection title="Вовлечённость по форматам">
        <EmptyState compact title="Нет данных о форматах" />
      </ChartSection>
    );
  }
  return (
    <WidgetGroup id="ig-formats" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartSection title="Вовлечённость по форматам" defaultSize="full" variants={breakdownVariants(list)} />
    </WidgetGroup>
  );
}

// ── Top posts ──
type SortKey = 'reach' | 'views' | 'saved' | 'shares';
const SORT_LABEL: Record<SortKey, string> = { reach: 'Охват', views: 'Просмотры', saved: 'Сохранения', shares: 'Репосты' };

/** Опциональный bulk-выбор для кампаний: карточки с id получают чекбокс (посты без id —
    не выбираются, как null-id строки TG-таблицы). Стейт живёт у вызывающего (IgContent). */
export interface IgPostSelection {
  selected: Set<string>;
  onToggle: (id: string) => void;
}

export function TopPostsBlock({
  posts,
  limit = 9,
  showSort = true,
  selection,
}: {
  posts: IgPost[];
  limit?: number;
  showSort?: boolean;
  selection?: IgPostSelection;
}) {
  const [sort, setSort] = useState<SortKey>('reach');
  if (posts.length === 0) {
    return (
      <EmptyState title="За выбранный период публикаций нет." />
    );
  }
  const top = [...posts].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0)).slice(0, limit);
  return (
    <div className="space-y-4">
      {showSort && (
        <div className="flex flex-wrap gap-1">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={`btn-pill px-3 py-1 text-xs font-medium transition-colors ${
                sort === key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
            >
              {SORT_LABEL[key]}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {top.map((post, idx) => (
          <IgPostCard
            key={post.id ?? idx}
            post={post}
            rank={idx + 1}
            selection={
              selection && post.id
                ? { checked: selection.selected.has(post.id), onToggle: () => selection.onToggle(post.id!) }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

/** Neutral stroke glyph for cards without a media preview — play for video, photo otherwise. */
function MediaPlaceholderGlyph({ video }: { video: boolean }) {
  return video ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.7l5.4 3.3-5.4 3.3z" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m6 16.5 4-4 3 3 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IgPostCard({
  post,
  rank,
  selection,
}: {
  post: IgPost;
  rank: number;
  selection?: { checked: boolean; onToggle: () => void };
}) {
  const typeLabel = MEDIA_TYPE_LABEL[post.media_type ?? ''] ?? 'Пост';
  const isVideo = post.media_type === 'VIDEO' || post.media_product_type === 'REELS';
  // For video posts media_url points at the video file — useless in <img> (renders a blank
  // hole). Only a real thumbnail counts as a cover there; images may fall back to media_url.
  const cover = post.thumbnail_url || (!isVideo ? post.media_url : null) || null;
  return (
    <div className="flex flex-col border-t border-border pt-3">
      {/* header row — rank + type as a hairline label (no positioned overlays on the image) */}
      <div className="mb-2 flex items-center justify-between text-2xs font-medium tracking-wide">
        <span className="flex items-center gap-2">
          {selection && (
            <input
              type="checkbox"
              aria-label="Выбрать публикацию"
              checked={selection.checked}
              onChange={selection.onToggle}
              className="size-4 accent-primary"
              data-testid="ig-post-select"
            />
          )}
          <span className="tabular-nums text-ink3">#{rank}</span>
        </span>
        <span className="text-muted-foreground">{typeLabel}</span>
      </div>
      {/* Uniform 4:5 cover (Instagram portrait) keeps the grid rows aligned; missing previews
          get a neutral placeholder tile instead of an empty box. */}
      <div className="flex aspect-[4/5] w-full items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
        {cover ? (
          <img src={cover} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          <MediaPlaceholderGlyph video={isVideo} />
        )}
      </div>
      <p className="mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-foreground">
        {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
      </p>
      <div className="mt-3 grid grid-cols-4 gap-1 border-t border-border pt-3 text-center">
        <Stat label="Охват" value={fmt.short(Number(post.reach ?? 0))} />
        <Stat label="Просм." value={fmt.short(Number(post.views ?? 0))} />
        <Stat label="Сохр." value={fmt.short(Number(post.saved ?? 0))} />
        <Stat label="Репосты" value={fmt.short(Number(post.shares ?? 0))} />
      </div>
    </div>
  );
}

// ── Reels ──
export function ReelsBlock({ posts }: { posts: IgPost[] }) {
  const reels = posts.filter((p) => p.media_product_type === 'REELS');
  if (reels.length === 0) {
    return (
      <EmptyState title="За выбранный период Reels нет." />
    );
  }
  const avgSec = (r: IgPost) => Math.round(Number(r.ig_reels_avg_watch_time ?? 0) / 1000);
  const totalWatchHours = reels.reduce((acc, r) => acc + Number(r.ig_reels_video_view_total_time ?? 0) / 1000 / 3600, 0);
  const avgWatchAll = reels.length ? Math.round(reels.reduce((acc, r) => acc + avgSec(r), 0) / reels.length) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3">
        <KpiCard label="Reels" value={fmt.num(reels.length)} />
        <KpiCard label="Ср. время просмотра" value={`${avgWatchAll} сек`} />
        <KpiCard label="Суммарно просмотрено" value={`${fmt.short(Math.round(totalWatchHours))} ч`} />
      </div>
      {/* A real WidgetGroup even for the lone card: inside a group the ⋯ dialog grows «Размер»
          and the menu grows «Скрыть» — the same customization contract as the TG feeds. */}
      <WidgetGroup id="ig-reels" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection title="Ср. время просмотра по Reels" defaultSize="full">
          <BarChart
            values={reels.map(avgSec)}
            labels={reels.map((_, i) => `R${i + 1}`)}
            titles={reels.map((r, i) => `R${i + 1}: ${avgSec(r)} сек · ${fmt.short(Number(r.views ?? 0))} просм`)}
          />
        </ChartSection>
      </WidgetGroup>
    </div>
  );
}

// ── Hashtags ──
export function HashtagsBlock({ posts }: { posts: IgPost[] }) {
  const stats = hashtagStats(posts).slice(0, 12);
  if (stats.length === 0) {
    return (
      <EmptyState title="В публикациях нет хэштегов." />
    );
  }
  return (
    <div className="data-table-surface data-table-scroll">
      <table className="data-table text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
            <th className="p-4">Хэштег</th>
            <th className="p-4 text-right">Постов</th>
            <th className="p-4 text-right">Ср. охват</th>
            <th className="p-4 text-right">ER</th>
            <th className="p-4 text-right">Влияние на ER</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {stats.map((s) => (
            <tr key={s.tag} className="transition-colors hover:bg-hover-row">
              <td className="p-4 font-medium text-foreground">{s.tag}</td>
              <td className="p-4 text-right tabular-nums text-muted-foreground">{s.count}</td>
              <td className="p-4 text-right tabular-nums">{fmt.short(s.avgReach)}</td>
              <td className="p-4 text-right tabular-nums">{s.avgEr.toFixed(2)}%</td>
              <td className="p-4 text-right font-medium tabular-nums">
                {Math.abs(s.lift) < 0.5 ? (
                  <span className="text-muted-foreground/60">≈0%</span>
                ) : (
                  <span className={s.lift > 0 ? 'text-verdant' : 'text-ember'}>
                    {s.lift > 0 ? '+' : ''}{s.lift.toFixed(0)}%
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Compare publications ──
const COMPARE_ROWS: { label: string; get: (p: IgPost) => number; pct?: boolean }[] = [
  { label: 'Охват', get: (p) => Number(p.reach ?? 0) },
  { label: 'Просмотры', get: (p) => Number(p.views ?? 0) },
  { label: 'Лайки', get: (p) => Number(p.like_count ?? 0) },
  { label: 'Комментарии', get: (p) => Number(p.comments_count ?? 0) },
  { label: 'Сохранения', get: (p) => Number(p.saved ?? 0) },
  { label: 'Репосты', get: (p) => Number(p.shares ?? 0) },
  { label: 'ER', get: (p) => postEr(p), pct: true },
];

export function CompareBlock({ posts }: { posts: IgPost[] }) {
  const pool = posts.slice(0, 12);
  const [sel, setSel] = useState<number[]>(() => [0, 1].filter((i) => i < pool.length));
  const toggle = (i: number) =>
    setSel((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : cur.length < 4 ? [...cur, i] : cur));
  const chosen = sel.map((i) => ({ i, post: pool[i] })).filter((x) => x.post);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {pool.map((p, i) => (
          <button
            key={p.id ?? i}
            type="button"
            onClick={() => toggle(i)}
            aria-pressed={sel.includes(i)}
            className={`max-w-[220px] truncate rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              sel.includes(i)
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            #{i + 1} {MEDIA_TYPE_LABEL[p.media_type ?? ''] ?? 'Пост'}: {(p.caption ?? 'Без подписи').slice(0, 22)}
          </button>
        ))}
      </div>
      {chosen.length < 2 ? (
        <EmptyState title="Выберите минимум 2 публикации для сравнения (до 4)." />
      ) : (
        <div className="data-table-surface data-table-scroll">
          <table className="data-table text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                <th className="p-4">Метрика</th>
                {chosen.map((c) => (
                  <th key={c.i} className="p-4 text-right">#{c.i + 1} {MEDIA_TYPE_LABEL[c.post.media_type ?? ''] ?? 'Пост'}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {COMPARE_ROWS.map((row) => {
                const values = chosen.map((c) => row.get(c.post));
                const max = Math.max(...values, 0);
                return (
                  <tr key={row.label} className="transition-colors hover:bg-hover-row">
                    <td className="p-4 text-muted-foreground">{row.label}</td>
                    {chosen.map((c, idx) => {
                      const v = values[idx];
                      const best = chosen.length > 1 && max > 0 && v === max;
                      return (
                        <td key={c.i} className={`p-4 text-right tabular-nums ${best ? 'font-medium text-verdant' : ''}`}>
                          {best && (
                            <>
                              <span className="sr-only">лучший: </span>
                              <span aria-hidden="true">▲ </span>
                            </>
                          )}
                          {row.pct ? `${v.toFixed(2)}%` : fmt.short(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tags (media where we're @-tagged — brand mentions) ──
export function TagsBlock({ tags, mock }: { tags: IgTag[]; mock?: boolean }) {
  if (tags.length === 0) {
    // Empty = ONE quiet line, not a tall illustrated placeholder: this niche block also sits LAST
    // in the section order, so an account with no tags never spends a screen on nothing (ИА rule:
    // пустые блоки самоуплотняются, а не ведут раздел).
    return (
      <p className="text-sm text-muted-foreground">
        Пока вас никто не отметил на фото — новые отметки появятся здесь автоматически{mock ? '.' : ' и сохранятся в истории.'}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {tags.map((t, i) => (
        <a
          key={t.id ?? i}
          href={t.permalink ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="group flex items-start gap-3 rounded border border-border p-3 transition-colors hover:bg-hover-row"
        >
          <span className="mt-0.5 shrink-0 rounded bg-muted px-2 py-0.5 text-2xs font-medium tracking-wide text-muted-foreground">
            {MEDIA_TYPE_LABEL[t.media_type ?? ''] ?? 'Пост'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 text-sm">
              <span className="font-medium text-primary decoration-primary/40 underline-offset-2 group-hover:underline">@{t.username ?? '—'}</span>
              {t.timestamp && <span className="font-mono text-xs text-muted-foreground">{fmtDay(t.timestamp)}</span>}
            </div>
            {t.caption && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{t.caption}</p>}
            <div className="mt-1 flex gap-3 text-xs tabular-nums text-muted-foreground">
              <span>{fmt.short(Number(t.like_count ?? 0))} лайков</span>
              <span>{fmt.num(Number(t.comments_count ?? 0))} комм.</span>
            </div>
          </div>
          <svg viewBox="0 0 24 24" className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M7 17L17 7M17 7H8M17 7v9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      ))}
    </div>
  );
}

// ── Stories (24h) ──
export function StoriesBlock({ stories }: { stories: IgStory[] | undefined }) {
  const list = stories ?? [];
  if (list.length === 0) {
    return (
      <EmptyState title="Активных историй нет." />
    );
  }
  const sum = (k: keyof IgStory) => list.reduce((acc, s) => acc + Number(s[k] ?? 0), 0);
  const completion = (s: IgStory) => {
    const v = Number(s.views ?? 0);
    if (v <= 0) return 0;
    const drop = Number(s.navigation?.tap_exit ?? 0) + Number(s.navigation?.swipe_forward ?? 0);
    return Math.max(0, Math.min(1, 1 - drop / v));
  };
  const avgCompletion = list.length ? list.reduce((acc, s) => acc + completion(s), 0) / list.length : 0;
  const nav = ['tap_forward', 'tap_back', 'tap_exit', 'swipe_forward'];
  const navItems = nav
    .map((k) => ({ label: NAV_LABEL[k] ?? k, value: list.reduce((acc, s) => acc + Number(s.navigation?.[k] ?? 0), 0) }))
    .filter((x) => x.value > 0);

  const soonest = list
    .map((s) => Date.parse(s.expires_at ?? ''))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  const hoursLeft = soonest ? Math.max(0, Math.round((soonest - Date.now()) / 3600000)) : null;

  return (
    <div className="space-y-4">
      {hoursLeft != null && (
        <p className="px-1 text-xs text-status-warn">Данные историй исчезнут через ~{hoursLeft} ч (24-часовое окно Instagram).</p>
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 lg:grid-cols-4">
        <KpiCard label="Историй" value={fmt.num(list.length)} />
        <KpiCard label="Охват" value={fmt.short(sum('reach'))} />
        <KpiCard label="Ответы" value={fmt.num(sum('replies'))} />
        <KpiCard label="Досматриваемость" value={`${Math.round(avgCompletion * 100)}%`} />
      </div>
      {/* WidgetGroup (TG parity): both story cards gain Размер / Выше / Ниже / Переставить /
          Скрыть; halves sit two-up on the 6-col grid exactly as the old 2-col grid did. */}
      <WidgetGroup id="ig-stories" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        {navItems.length > 0 ? (
          <ChartSection
            title="Навигация по историям"
            variants={breakdownVariants(navItems.map((n) => ({ label: n.label, value: n.value, display: fmt.short(n.value) })))}
          />
        ) : (
          <ChartSection title="Навигация по историям">
            <EmptyState compact title="Нет данных о навигации" />
          </ChartSection>
        )}
        <ChartSection title="По историям" defaultSize="half">
          <div className="space-y-2">
            {list.map((s, i) => (
              <div key={s.id ?? i} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{s.media_type === 'VIDEO' ? 'Видео' : 'Фото'} · <span className="font-mono">{fmtDay(s.timestamp ?? '')}</span></span>
                <span className="tabular-nums">
                  {fmt.short(Number(s.reach ?? 0))} охв · {Math.round(completion(s) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </ChartSection>
      </WidgetGroup>
    </div>
  );
}
