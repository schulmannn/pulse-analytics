import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHistory, useIgHistory, useIgInsights, useIgPosts, useIgProfile, useTgFull, useTgGraphs, useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { postEr } from '@/lib/igMetrics';
import { igWindowMetrics } from '@/lib/igWindowMetrics';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { buildWeekNarrative, type NarrativeIgInput, type NarrativeInput, type NarrativeParagraph, type NarrativeSeg } from '@/lib/narrative';
import { ChartSection } from '@/components/ChartWidget';
import { DeltaPill } from '@/components/DeltaPill';
import { InlineSpark } from '@/components/InlineSpark';
import { PostDetailModal } from '@/components/PostDetailModal';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «НЕДЕЛЯ КАНАЛА» — первая поверхность нарративного слоя (roadmap card, фазы 1–2; тон утверждён
 * владельцем на реальных данных @bynotem). Собирает вход движка из тех же источников, что и
 * карточки Обзора (graphs-серия просмотров, посты окна, дневной архив подписчиков), и рендерит
 * «текст-с-данными»: числа-ссылки в drill-контракте, Δ-пилюли, спарклайн-в-строке, чип поста,
 * открывающий его карточку. Каждое число сходится со страницей метрики 1-в-1 — движок и
 * страницы едят одни и те же ряды. Фаза 2: кодой рассказа — Instagram-неделя и кросс-сетевой
 * контраст (та же честность: только считаемые утверждения).
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

/** Instagram-вход — лёгкая тройка запросов (профиль + insights 14д + архив ig_daily) вместо
 * полного useIgData: рассказу нужны только две дневные серии, а полный бандл тянет ещё посты,
 * брейкдауны, online и stories — лишние вызовы на каждый визит Обзора. Правило слияния
 * live↔архив то же, что у страниц /metrics/ig-* (histSeries/longerSeries) — числа сходятся
 * 1-в-1. Гейт честности как в igHome: mock вне демо (Instagram не подключён) → null, и
 * IG-абзац не рождается. */
export function useIgWeekInput(): { input: NarrativeIgInput | null; loading: boolean; notConnected: boolean } {
  const { demo } = useDemo();
  const profileQ = useIgProfile();
  const insightsQ = useIgInsights(14);
  const historyQ = useIgHistory();
  const postsQ = useIgPosts(24);
  const profile = profileQ.data;
  const ins = insightsQ.data;
  const rows = historyQ.data?.rows;
  const media = postsQ.data?.data;
  const unavailable = profileQ.isError && insightsQ.isError;
  // isPending (не isLoading): пока канал не известен, IG-запросы выключены — это тоже «загрузка».
  const loading = profileQ.isPending || insightsQ.isPending;
  // Не подключён (ошибка / mock вне демо) → панель зовёт подключить; отличается от «подключён, но
  // мало данных» (тогда input=null из-за пустого охвата, но notConnected=false → тихий рассказ).
  const notConnected = (profileQ.isError && insightsQ.isError) || (!!(profile?.mock || ins?.mock) && !demo);
  const input = useMemo(() => {
    if (unavailable) return null;
    if (!!(profile?.mock || ins?.mock) && !demo) return null;
    const now = Date.now();
    const metrics = igWindowMetrics({
      profile,
      insights: ins,
      historyRows: rows,
      since: now - 2 * WEEK_MS,
      until: now,
    });
    const reach = metrics.daily.reach;
    if (!reach.length) return null;
    // Движение базы = НЕТТО из архива (ig_daily.follows − unfollows подневно), тот же смысл, что
    // KPI-карточка «Подписчики». follower_count / ig_daily.followers — GROSS дневной приход БЕЗ
    // вычета отписок: суммирование врало «база выросла на N», когда база на деле падала.
    const follows = metrics.daily.followerNet;
    // Медиа недели + норма ERV за 4 недели — канонная postEr (те же числа, что контент-таблицы);
    // герой меряется только по медиа с охватом.
    const withReach = (media ?? []).filter(
      (p) => p.timestamp && Number(p.reach ?? 0) > 0 && now - Date.parse(p.timestamp) <= 4 * WEEK_MS,
    );
    const weekMedia = withReach.filter((p) => now - Date.parse(p.timestamp!) <= WEEK_MS);
    const avgMediaErv =
      withReach.length >= 3 ? withReach.reduce((a, p) => a + postEr(p), 0) / withReach.length : null;
    return {
      reachDaily: reach.map((p) => ({ day: p.day, v: p.value })),
      followsDaily: follows.map((p) => ({ day: p.day, v: p.value })),
      followersNow: metrics.values.followersLevel.hasValue ? metrics.followersLevel : null,
      mediaWeek: weekMedia.map((p) => ({
        title: (p.caption || 'Публикация').slice(0, 80),
        erv: postEr(p),
        permalink: p.permalink ?? null,
      })),
      avgMediaErv,
    };
  }, [unavailable, profile, ins, rows, media, demo]);
  return { input, loading, notConnected };
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
    case 'post': {
      const chip =
        'rounded text-left font-semibold text-foreground underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
      // IG-медиа живёт по permalink (карточек IG-постов в приложении нет), TG-пост — в модалке.
      if (seg.href) {
        return (
          <a href={seg.href} target="_blank" rel="noreferrer" className={chip}>
            {seg.text}
          </a>
        );
      }
      if (seg.postIndex == null) return <span className="font-semibold text-foreground">{seg.text}</span>;
      const idx = seg.postIndex;
      return (
        <button type="button" onClick={() => onPost(idx)} className={chip}>
          {seg.text}
        </button>
      );
    }
  }
}

/** Голое тело нарратива (для Home-реестра и самой карточки). */
export function NarrativeWeekBody() {
  const { input, posts, loading } = useWeekNarrativeInput();
  const { input: igInput } = useIgWeekInput();
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
  // TG-часть не ждёт Instagram: IG-абзац — кода текста, его догрузка ничего не сдвигает.
  const nar = buildWeekNarrative({ ...input, ig: igInput });
  return (
    <>
      <NarrativeProse paragraphs={nar.paragraphs} onPost={setOpenPost} />
      {openPost != null && posts[openPost] && (
        <PostDetailModal post={posts[openPost]!} reason={null} onClose={() => setOpenPost(null)} />
      )}
    </>
  );
}

/** Общий рендерер «текста-с-данными»: абзацы сегментов + приклейка пунктуации к инлайн-элементам
 * (спарк/пилюля). Чип-пост: href (IG-медиа → permalink) или postIndex (TG → PostDetailModal через
 * onPost). Используют и TG-«Неделя канала», и IG-«Неделя». */
export function NarrativeProse({ paragraphs, onPost }: { paragraphs: NarrativeParagraph[]; onPost?: (i: number) => void }) {
  const post = onPost ?? (() => {});
  return (
    <div className="max-w-prose space-y-3.5 text-sm leading-relaxed text-ink2">
      {paragraphs.map((p, i) => (
        <p key={i}>
          {p.map((seg, j) => {
            const next = p[j + 1];
            if ((seg.kind === 'spark' || seg.kind === 'delta') && next?.kind === 'text' && /^[.,]/.test(next.text)) {
              return (
                <span key={j} className="whitespace-nowrap">
                  <SegSpan seg={seg} onPost={post} />
                  {next.text.slice(0, 1)}
                </span>
              );
            }
            if (seg.kind === 'text' && /^[.,]/.test(seg.text)) {
              const prev = p[j - 1];
              if (prev && (prev.kind === 'spark' || prev.kind === 'delta')) {
                return <SegSpan key={j} seg={{ kind: 'text', text: seg.text.slice(1) }} onPost={post} />;
              }
            }
            return <SegSpan key={j} seg={seg} onPost={post} />;
          })}
        </p>
      ))}
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
