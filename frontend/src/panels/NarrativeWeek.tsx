import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmt } from '@/lib/format';
import { useHistory, useIgHistory, useIgInsights, useIgPosts, useIgProfile, useTgFull, useTgGraphs, useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { postEr } from '@/lib/igMetrics';
import { igWeekGate } from '@/lib/igWeekGate';
import { igWindowMetrics } from '@/lib/igWindowMetrics';
import type { NormalizedPost } from '@/lib/posts';
import { tgWeekMetrics } from '@/lib/tgWeekMetrics';
import { buildWeekNarrative, type NarrativeIgInput, type NarrativeInput, type NarrativeParagraph, type NarrativeSeg } from '@/lib/narrative';
import { ChartSection } from '@/components/ChartWidget';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { useWidgetInView } from '@/lib/widgetViewport';
import { DeltaPill } from '@/components/DeltaPill';
import { InlineSpark } from '@/components/InlineSpark';
import { PostDetailModal } from '@/components/PostDetailModal';
import { ErrorState } from '@/components/ErrorState';
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


const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function useWeekNarrativeInput(): { input: NarrativeInput | null; posts: NormalizedPost[]; loading: boolean; error: boolean; retry: () => void } {
  // Прогрессивная загрузка Главной: тело рендерится внутри ChartSection (Provider для homeKey-
  // карточек), офскрин-пин не фетчит до приближения. Вне Главной контекст = true — как раньше.
  const inView = useWidgetInView();
  const { data: full, isPending: fullPending, isError: fullError, refetch: refetchFull } = useTgFull(0, { enabled: inView });
  const { data: graphs, isPending: graphsPending } = useTgGraphs({ enabled: inView });
  const { data: history } = useHistory(730, { enabled: inView });
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();

  return useMemo(() => {
    if (fullPending || graphsPending) return { input: null, posts: [], loading: true, error: false, retry: refetchFull };
    // Сбой fetch НЕ маскируем под «тихую неделю» (аудит: пустые ряды читались как «просмотры на
    // нуле»). Ошибка graphs при живом full — прежний осознанный фолбэк (рассказ без сдвига недели).
    if (fullError) return { input: null, posts: [], loading: false, error: true, retry: refetchFull };

    const now = Date.now();
    const tgMetrics = tgWeekMetrics({ full, history, channelsData, channelId, now });

    // Дневная серия просмотров: graphs (как rich-карта «Просмотры»); без graphs честно пусто —
    // сдвиг недели не рождается, нарратив живёт на постах и базе.
    // Intentionally live graph-based: archive viewsSpark has a today-lag and is a separate product choice.
    const inter = graphs?.interactions;
    const viewSeries = inter?.series?.find((s) => /view|просмотр/i.test(s.name ?? '')) || inter?.series?.[0];
    const viewsDaily =
      inter && viewSeries
        ? inter.x.map((ts: number, i: number) => ({
            day: new Date(ts).toISOString().slice(0, 10),
            v: Number(viewSeries.values[i] ?? 0),
          }))
        : [];

    const input: NarrativeInput = {
      viewsDaily,
      posts: tgMetrics.narrativePosts,
      avgErv: tgMetrics.avgErv,
      subsNow: tgMetrics.subscriber.subsNow,
      subsD7: tgMetrics.subscriber.subsD7,
    };
    return { input, posts: tgMetrics.weekPosts, loading: false, error: false, retry: refetchFull };
  }, [full, fullPending, fullError, refetchFull, graphs, graphsPending, history, channelId, channelsData]);
}

/** Instagram-вход — лёгкая тройка запросов (профиль + insights 14д + архив ig_daily) вместо
 * полного useIgData: рассказу нужны только две дневные серии, а полный бандл тянет ещё посты,
 * брейкдауны, online и stories — лишние вызовы на каждый визит Обзора. Правило слияния
 * live↔архив то же, что у страниц /metrics/ig-* (histSeries/longerSeries) — числа сходятся
 * 1-в-1. Гейт честности как в igHome: mock вне демо (Instagram не подключён) → null, и
 * IG-абзац не рождается. */
export function useIgWeekInput(): { input: NarrativeIgInput | null; loading: boolean; notConnected: boolean } {
  const { demo } = useDemo();
  const { channelId } = useSelectedChannel();
  // Прогрессивная загрузка Главной: офскрин-пин не пробует IG-эндпоинты до приближения к
  // вьюпорту (вне Главной контекст = true). Гейт только на fetch — loading/notConnected ниже
  // по-прежнему считаются от capability-гейта, офскрин честно читается как «загрузка».
  const inView = useWidgetInView();
  // Capability gate from the already-cached useChannels response: an unconnected selected channel
  // must NOT fan out the five IG endpoints below (they'd only return a discarded mock). While
  // channels are unresolved we probe nothing and report honest loading.
  const { data: channelsData, isError: channelsError } = useChannels();
  const selected = channelsData?.channels.find((c) => c.id === channelId);
  const gate = igWeekGate({
    demo,
    channelsResolved: channelsData != null,
    channelsError,
    channelKnown: channelId != null,
    igConnected: !!selected?.ig_connected,
  });
  const igFetch = gate.igEnabled && inView;
  const profileQ = useIgProfile(igFetch);
  const insightsQ = useIgInsights(14, igFetch);
  const insights7Q = useIgInsights(7, igFetch);
  const historyQ = useIgHistory(400, igFetch);
  const postsQ = useIgPosts(24, igFetch);
  const profile = profileQ.data;
  const ins = insightsQ.data;
  const ins7 = insights7Q.data;
  const rows = historyQ.data?.rows;
  const media = postsQ.data?.data;
  const unavailable = profileQ.isError && insightsQ.isError;
  // Загрузка: пока капабилити ещё не известна (gate) ИЛИ включённые IG-пробы в полёте.
  const loading = gate.gateLoading || (gate.igEnabled && (profileQ.isPending || insightsQ.isPending || insights7Q.isPending));
  // Не подключён: капабилити разрешилась в неподключённый канал, ЛИБО runtime-сигналы (ошибка /
  // mock вне демо) когда мы уже пробовали. Отличается от «подключён, но мало данных» (input=null,
  // notConnected=false → тихий рассказ).
  const notConnected = gate.notConnected || (profileQ.isError && insightsQ.isError) || (!!(profile?.mock || ins?.mock) && !demo);
  const input = useMemo(() => {
    if (!gate.igEnabled) return null;
    if (unavailable) return null;
    if (!!(profile?.mock || ins?.mock) && !demo) return null;
    // Пока 7-дн фетч грузится — не строим вход, чтобы не мигнуть daily-fallback охвата перед дедупом.
    if (!ins7 && insights7Q.isPending) return null;
    const now = Date.now();
    const metrics = igWindowMetrics({
      profile,
      insights: ins,
      historyRows: rows,
      since: now - 2 * WEEK_MS,
      until: now,
    });
    // 7-дневный ДЕДУП охват (reach_window из insights(7)) — число охвата + WoW в рассказе сходятся
    // с KPI-карточкой «Охват · 7 дн.». Дневной spark/WoW-форма берётся из 14-дн входа (metrics.daily).
    // Ошибка insights(7) → ins7 null → reachWeek undefined → igReachWindow падает на daily-сумму.
    const reachMetrics = ins7
      ? igWindowMetrics({ profile, insights: ins7, historyRows: rows, since: now - WEEK_MS, until: now })
      : null;
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
      reachWeek: reachMetrics?.pairs.reach,
      followsDaily: follows.map((p) => ({ day: p.day, v: p.value })),
      followersNow: metrics.values.followersLevel.hasValue ? metrics.followersLevel : null,
      mediaWeek: weekMedia.map((p) => ({
        title: (p.caption || 'Публикация').slice(0, 80),
        erv: postEr(p),
        permalink: p.permalink ?? null,
      })),
      avgMediaErv,
    };
  }, [gate.igEnabled, unavailable, profile, ins, ins7, insights7Q.isPending, rows, media, demo]);
  return { input, loading, notConnected };
}

/** Ховер числа-ссылки подсвечивает виджет ТОЙ ЖЕ метрики на странице: секции несут data-drill-to
 *  (ChartSection), CSS-правило в index.css зеркалит card-hover. Прямой DOM-атрибут, без state. */
const narrLinkHover = (to: string, on: boolean) => {
  document.querySelectorAll(`section[data-drill-to="${to}"]`).forEach((el) => {
    if (on) el.setAttribute('data-narr-link', '');
    else el.removeAttribute('data-narr-link');
  });
};

function SegSpan({ seg, onPost }: { seg: NarrativeSeg; onPost: (i: number) => void }) {
  switch (seg.kind) {
    case 'text':
      return <>{seg.text}</>;
    case 'number':
      return seg.to ? (
        <Link
          to={seg.to}
          onMouseEnter={() => narrLinkHover(seg.to!, true)}
          onMouseLeave={() => narrLinkHover(seg.to!, false)}
          className="kpi-accent rounded font-medium tabular-nums text-foreground underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {seg.text}
        </Link>
      ) : (
        <span className="font-medium tabular-nums">{seg.text}</span>
      );
    case 'delta':
      return <DeltaPill delta={{ dir: seg.pct < 0 ? 'down' : 'up', pct: Math.abs(seg.pct) }} />;
    case 'spark':
      return <InlineSpark values={seg.values} />;
    case 'post': {
      const chip =
        'rounded text-left font-medium text-foreground underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40';
      // IG-медиа живёт по permalink (карточек IG-постов в приложении нет), TG-пост — в модалке.
      if (seg.href) {
        return (
          <a href={seg.href} target="_blank" rel="noreferrer" className={chip}>
            {seg.text}
          </a>
        );
      }
      if (seg.postIndex == null) return <span className="font-medium text-foreground">{seg.text}</span>;
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
  const { input, posts, loading, error, retry } = useWeekNarrativeInput();
  const { input: igInput } = useIgWeekInput();
  const [openPost, setOpenPost] = useState<number | null>(null);
  if (error) return <ErrorState title="Не удалось загрузить неделю" onRetry={retry} />;
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
  // Факт-колонка на очень широком desktop: короткий рассказ оставлял крупную карточку пустой — справа мини-леджер
  // из ТОГО ЖЕ входа (никаких новых запросов): пик недели, постов за неделю, база. Числа сходятся
  // с рассказом по построению — это те же ряды.
  const last7 = input.viewsDaily.slice(-7);
  const peak = last7.length ? last7.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const facts: { label: string; value: string }[] = [];
  if (peak && peak.v > 0) facts.push({ label: 'Пик недели', value: `${fmt.short(peak.v)} · ${fmt.day(peak.day)}` });
  if (input.posts.length > 0) facts.push({ label: 'Постов за неделю', value: fmt.num(input.posts.length) });
  if (input.subsNow != null)
    facts.push({
      label: 'База',
      value: `${fmt.kpi(input.subsNow)}${input.subsD7 ? ` · ${input.subsD7 > 0 ? '+' : '−'}${fmt.num(Math.abs(input.subsD7))}` : ''}`,
    });
  return (
    <>
      <div className="flex h-full gap-6">
        {/* Фикс. высота карточки клипала хвост рассказа посреди строки: колонка текста скроллится
            (глобальный тонкий скроллбар), маска гасит нижние 28px как знак «ниже ещё есть», а pb-7
            выводит последнюю строку из зоны затухания при доскролле. */}
        <div className="min-w-0 flex-1 overflow-y-auto pb-7 mask-[linear-gradient(180deg,#000_calc(100%-28px),transparent)]">
          <NarrativeProse paragraphs={nar.paragraphs} onPost={setOpenPost} />
        </div>
        {facts.length > 0 && (
          <aside className="hidden w-44 shrink-0 space-y-3 border-l border-border pl-5 2xl:block">
            {facts.map((f) => (
              <div key={f.label}>
                <div className="text-2xs tracking-wide text-muted-foreground">{f.label}</div>
                <div className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{f.value}</div>
              </div>
            ))}
          </aside>
        )}
      </div>
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

/** Виджет-обёртка (Обзор + Home-пин через id/homeKey — паттерн GrowthChartBlock). Обзор может
 *  зафиксировать геометрию, а Home сохраняет пользовательский размер. */
export function NarrativeWeekBlock({
  id,
  homeKey,
  defaultSize = 'half',
  fixedSize,
  title = 'Неделя канала',
}: { id?: string; homeKey?: string; defaultSize?: WidgetSize; fixedSize?: WidgetSize; title?: string } = {}) {
  return (
    <ChartSection id={id} homeKey={homeKey} title={title} defaultSize={defaultSize} fixedSize={fixedSize} noExpand>
      <NarrativeWeekBody />
    </ChartSection>
  );
}
