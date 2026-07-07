import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHistory, useTgFull, useTgGraphs, useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { buildWeekNarrative, type NarrativeInput, type NarrativeSeg } from '@/lib/narrative';
import { ChartSection } from '@/components/ChartWidget';
import { DeltaPill } from '@/components/DeltaPill';
import { InlineSpark } from '@/components/InlineSpark';
import { PostDetailModal } from '@/components/PostDetailModal';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «НЕДЕЛЯ КАНАЛА» — первая поверхность нарративного слоя (roadmap card, фаза 1; тон утверждён
 * владельцем на реальных данных @bynotem). Собирает вход движка из тех же источников, что и
 * карточки Обзора (graphs-серия просмотров, посты окна, дневной архив подписчиков), и рендерит
 * «текст-с-данными»: числа-ссылки в drill-контракте, Δ-пилюли, спарклайн-в-строке, чип поста,
 * открывающий его карточку. Каждое число сходится со страницей метрики 1-в-1 — движок и
 * страницы едят одни и те же ряды.
 */

/** ERV поста, % — как в контент-аналитике: вовлечения на просмотр. */
const postErv = (p: NormalizedPost) => (p.reach > 0 ? (p.eng / p.reach) * 100 : 0);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function useWeekNarrativeInput(): { input: NarrativeInput | null; posts: NormalizedPost[]; loading: boolean } {
  const { data: full, isPending: fullPending } = useTgFull(0);
  const { data: graphs, isPending: graphsPending } = useTgGraphs();
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();

  return useMemo(() => {
    if (fullPending || graphsPending) return { input: null, posts: [], loading: true };

    const now = Date.now();
    const allPosts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {});
    const weekPosts = allPosts.filter((p) => p.date && now - Date.parse(p.date) <= WEEK_MS);
    // Норма ERV — по более широкому окну (4 недели), чтобы «герой» мерился не сам с собой.
    const monthPosts = allPosts.filter((p) => p.date && now - Date.parse(p.date) <= 4 * WEEK_MS);
    const ervBase = monthPosts.filter((p) => p.reach > 0);
    const avgErv = ervBase.length >= 3 ? ervBase.reduce((a, p) => a + postErv(p), 0) / ervBase.length : null;

    // Дневная серия просмотров: graphs (как rich-карта «Просмотры»); без graphs честно пусто —
    // сдвиг недели не рождается, нарратив живёт на постах и базе.
    const inter = graphs?.interactions;
    const viewSeries = inter?.series?.find((s) => /view|просмотр/i.test(s.name ?? '')) || inter?.series?.[0];
    const viewsDaily =
      inter && viewSeries
        ? inter.x.map((ts: number, i: number) => ({
            day: new Date(ts).toISOString().slice(0, 10),
            v: Number(viewSeries.values[i] ?? 0),
          }))
        : [];

    // База: memberCount сейчас + Δ7д из дневного архива (уровень − уровень неделю назад).
    const rows = (history?.rows ?? []).filter((r) => r.subscribers != null);
    const current = channelsData?.channels.find((c) => c.id === channelId);
    const lastLevel = rows.length ? Number(rows[rows.length - 1]!.subscribers) : null;
    const weekAgo = rows.length > 7 ? Number(rows[rows.length - 8]!.subscribers) : null;
    const subsNow = current?.memberCount ?? lastLevel;
    const subsD7 = lastLevel != null && weekAgo != null ? lastLevel - weekAgo : null;

    const input: NarrativeInput = {
      viewsDaily,
      posts: weekPosts.map((p) => ({
        title: (p.caption || 'Пост без текста').slice(0, 80),
        views: p.reach,
        reactions: p.likes,
        forwards: p.shares,
        replies: p.comments,
        erv: postErv(p),
      })),
      avgErv,
      subsNow,
      subsD7,
    };
    return { input, posts: weekPosts, loading: false };
  }, [full, fullPending, graphs, graphsPending, history, channelId, channelsData]);
}

function SegSpan({ seg, onPost }: { seg: NarrativeSeg; onPost: (i: number) => void }) {
  switch (seg.kind) {
    case 'text':
      return <>{seg.text}</>;
    case 'number':
      return seg.to ? (
        <Link
          to={seg.to}
          className="kpi-accent rounded font-semibold tabular-nums text-foreground underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {seg.text}
        </Link>
      ) : (
        <span className="font-semibold tabular-nums">{seg.text}</span>
      );
    case 'delta':
      return <DeltaPill delta={{ dir: seg.pct < 0 ? 'down' : 'up', pct: Math.abs(seg.pct) }} />;
    case 'spark':
      return <InlineSpark values={seg.values} />;
    case 'post':
      return (
        <button
          type="button"
          onClick={() => onPost(seg.postIndex)}
          className="rounded text-left font-semibold text-foreground underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {seg.text}
        </button>
      );
  }
}

/** Голое тело нарратива (для Home-реестра и самой карточки). */
export function NarrativeWeekBody() {
  const { input, posts, loading } = useWeekNarrativeInput();
  const [openPost, setOpenPost] = useState<number | null>(null);
  if (loading || !input) {
    return (
      <div className="max-w-prose space-y-3" aria-hidden="true">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
    );
  }
  const nar = buildWeekNarrative(input);
  return (
    <div className="max-w-prose space-y-3.5 text-sm leading-relaxed text-ink2">
      {nar.paragraphs.map((p, i) => (
        <p key={i}>
          {p.map((seg, j) => {
            // Пунктуация сразу после инлайн-элемента (спарк/пилюля) не должна отрываться
            // переносом: пара «элемент + „. “» рендерится единым nowrap-спаном.
            const next = p[j + 1];
            if ((seg.kind === 'spark' || seg.kind === 'delta') && next?.kind === 'text' && /^[.,]/.test(next.text)) {
              return (
                <span key={j} className="whitespace-nowrap">
                  <SegSpan seg={seg} onPost={setOpenPost} />
                  {next.text.slice(0, 1)}
                </span>
              );
            }
            if (seg.kind === 'text' && /^[.,]/.test(seg.text)) {
              const prev = p[j - 1];
              if (prev && (prev.kind === 'spark' || prev.kind === 'delta')) {
                return <SegSpan key={j} seg={{ kind: 'text', text: seg.text.slice(1) }} onPost={setOpenPost} />;
              }
            }
            return <SegSpan key={j} seg={seg} onPost={setOpenPost} />;
          })}
        </p>
      ))}
      {openPost != null && posts[openPost] && (
        <PostDetailModal post={posts[openPost]!} reason={null} onClose={() => setOpenPost(null)} />
      )}
    </div>
  );
}

/** Виджет-обёртка (Обзор + Home-пин через id/homeKey — паттерн GrowthChartBlock). */
export function NarrativeWeekBlock({ id, homeKey }: { id?: string; homeKey?: string } = {}) {
  return (
    <ChartSection id={id} homeKey={homeKey} title="Неделя канала" defaultSize="half" noExpand>
      <NarrativeWeekBody />
    </ChartSection>
  );
}
