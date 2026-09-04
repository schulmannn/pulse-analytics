import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmt } from '@/lib/format';
import { useHistory, useIgHistory, useIgInsights, useIgPosts, useIgProfile, useTgFull, useTgGraphs, useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { postEr } from '@/lib/igMetrics';
import { periodMedian } from '@/lib/postMedian';
import { igWeekGate } from '@/lib/igWeekGate';
import { igWindowMetrics } from '@/lib/igWindowMetrics';
import type { NormalizedPost } from '@/lib/posts';
import { tgWeekMetrics } from '@/lib/tgWeekMetrics';
import {
  buildWeekSummary,
  narrativeToPlain,
  type NarrativeIgInput,
  type NarrativeInput,
  type NarrativeParagraph,
  type NarrativeSeg,
  type WeekSummary,
} from '@/lib/narrative';
import { ChartSection } from '@/components/ChartWidget';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { useWidgetSize } from '@/lib/widgetSize';
import { useWidgetInView } from '@/lib/widgetViewport';
import { BarChart } from '@/components/BarChart';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import { DeltaPill, deltaLabel } from '@/components/DeltaPill';
import { InlineSpark } from '@/components/InlineSpark';
import { PostDetailModal } from '@/components/PostDetailModal';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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
    if ((profile?.mock || ins?.mock) && !demo) return null;
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

function SegSpan({
  seg,
  onPost,
  plainNumbers = false,
}: { seg: NarrativeSeg; onPost: (i: number) => void; plainNumbers?: boolean }) {
  switch (seg.kind) {
    case 'text':
      return <>{seg.text}</>;
    case 'number':
      return seg.to ? (
        <Link
          to={seg.to}
          onMouseEnter={() => narrLinkHover(seg.to!, true)}
          onMouseLeave={() => narrLinkHover(seg.to!, false)}
          // ПУНКТИРНОЕ ПОДЧЁРКИВАНИЕ читается как ошибка правописания, когда чисел много
          // (аудит #554, ТЗ-11). `plainNumbers` снимает его точечно — в «Неделе канала», где
          // числа стоят и в мысли, и в леджере. IG-виджет его не передаёт и не меняется.
          className={`kpi-accent rounded font-medium tabular-nums text-foreground transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 ${
            plainNumbers
              ? 'hover:text-foreground/80'
              : 'underline decoration-dotted decoration-1 underline-offset-4 hover:text-primary'
          }`}
        >
          {seg.text}
        </Link>
      ) : (
        <span className="font-medium tabular-nums">{seg.text}</span>
      );
    case 'delta':
      return <DeltaPill delta={{ dir: seg.pct < 0 ? 'down' : 'up', pct: Math.abs(seg.pct) }} />;
    case 'spark':
      // Искра стоит ВПЛОТНУЮ за своим числом (аудит #554, D7) и связана с ним неразрывной
      // обёрткой в рендерере абзаца ниже: пара переносится как одно слово и никогда не уезжает
      // на строку одна. Размер слова, а не графика: 64×16 при кегле текста 14px.
      return <InlineSpark values={seg.values} width={64} height={16} />;
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
/**
 * ТЕЛО «НЕДЕЛИ КАНАЛА» — ДВА МАКЕТА, А НЕ ОДИН СЖАТЫЙ (аудит #554, ТЗ-11).
 *
 * Было: вся карточка — проза в две колонки, числа спрятаны внутри предложений, под ними леджер,
 * повторяющий базу и пик из текста, плюс отдельная строка «главного изменения». Чтобы сравнить
 * неделю с прошлой, приходилось прочитать два абзаца.
 *
 * Стало:
 *   • L (full) — вариант A: число недели со сдвигом слева, ритм двух недель полоской справа,
 *     под ними ОДНА мысль, объясняющая это число, и леджер только с тем, чего нет наверху;
 *   • M и S — вариант B: заголовок-вывод и те же факты списком, число первым, без графика.
 *     Ужимать полоску до 264px бессмысленно — ритм в ней перестаёт читаться.
 *
 * Размер приходит из WidgetSizeContext (ChartSection), а не из container query: тело должно
 * подчиняться ВЫБОРУ владельца, а не только тому, сколько места случайно осталось.
 */
function WeekLedger({
  summary,
  onPost,
  median,
}: { summary: WeekSummary; onPost: (i: number) => void; median: number | null }) {
  const rows: { label: string; value: ReactNode }[] = [];
  rows.push({ label: 'Постов за неделю', value: fmt.num(summary.posts) });
  if (summary.subsNow != null) {
    rows.push({
      label: 'База',
      value: (
        <>
          {fmt.kpi(summary.subsNow)}
          {summary.subsD7 != null && summary.subsD7 !== 0 && (
            <span className="font-normal text-muted-foreground">
              {' · '}
              {summary.subsD7 > 0 ? '+' : '−'}
              {fmt.num(Math.abs(summary.subsD7))} за неделю
            </span>
          )}
        </>
      ),
    });
  }
  if (summary.best) {
    rows.push({
      label: 'Лучшая публикация',
      value: (
        <>
          {fmt.short(summary.best.views)}{' '}
          <button
            type="button"
            onClick={() => onPost(summary.best!.postIndex)}
            // Медиана недели — в тултипе, а не отдельной строкой леджера (аудит #554, ТЗ-11):
            // она нужна ровно затем, чтобы понять, насколько лучшая публикация выделяется.
            title={median != null ? `Медианный охват недели — ${fmt.short(median)}` : undefined}
            className="rounded font-normal text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {`просмотра · «${summary.best.title}»`}
          </button>
        </>
      ),
    });
  }
  if (summary.ig) {
    rows.push({
      label: 'Instagram, та же неделя',
      value: (
        <>
          {fmt.kpi(summary.ig.reach)}
          <span className="font-normal text-muted-foreground">{' охват · '}</span>
          {deltaLabel({ dir: summary.ig.pct < 0 ? 'down' : 'up', pct: Math.abs(summary.ig.pct) }) ?? '0%'}
        </>
      ),
    });
  }
  return (
    // Факты идут в ряд по естественной ширине: фикс-сетка растянула бы короткие пары
    // «подпись/число» на 1600px ряда, и между ними встали бы дыры шире самих чисел.
    <aside className="flex shrink-0 flex-wrap gap-x-10 gap-y-3 border-t border-border pt-3">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="text-2xs tracking-wide text-muted-foreground">{r.label}</div>
          <div className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{r.value}</div>
        </div>
      ))}
    </aside>
  );
}

/** Полоска ритма: 14 дней одной серией, прошлая неделя приглушена, пик текущей — чернилами. */
function WeekRhythm({ summary }: { summary: WeekSummary }) {
  const days = summary.days14;
  const ghostCount = Math.max(days.length - 7, 0);
  const peakIdx = summary.peak ? days.findIndex((d) => d.day === summary.peak!.day) : -1;
  // Подписаны только три даты: первая, пик и последняя — иначе четырнадцать подписей на 360px
  // встают в кашу. Полную дату каждого дня по-прежнему называет тултип.
  const axisLabels = days.map((d, i) =>
    i === 0 || i === days.length - 1 || i === peakIdx ? fmt.day(d.day) : '',
  );
  return (
    <div className="min-w-0">
      <BarChart
        values={days.map((d) => d.v)}
        labels={days.map((d) => fmt.day(d.day))}
        axisLabels={axisLabels}
        titles={days.map((d) => `${fmt.day(d.day)}: ${fmt.kpi(d.v)}`)}
        formatValue={(v) => fmt.kpi(v)}
        height={72}
        barTone={(i) => (i === peakIdx ? 'peak' : i < ghostCount ? 'ghost' : 'default')}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-muted-foreground/55" />
          прошлая неделя
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-[hsl(var(--chart-role-primary))]" />
          эта неделя
        </span>
        {peakIdx >= 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-foreground" />
            пик
          </span>
        )}
      </div>
    </div>
  );
}

/** Макет L (вариант A): число и ритм наверху, мысль под ними, леджер полосой внизу.
    Экспорт ради теста раскладки: тело целиком тянет за собой запросы и роутер. */
export function WeekLarge({
  summary,
  onPost,
  median,
}: { summary: WeekSummary; onPost: (i: number) => void; median: number | null }) {
  const days = summary.days14;
  const cur = days.slice(-7);
  const windowLabel =
    cur.length > 0 ? `${fmt.day(cur[0].day)} – ${fmt.day(cur[cur.length - 1].day)}` : '';
  const delta = summary.pct == null ? null : deltaLabel({ dir: summary.pct < 0 ? 'down' : 'up', pct: Math.abs(summary.pct) });
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="grid items-end gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="text-2xs tracking-wide text-muted-foreground">
            Просмотры за 7 дней{windowLabel && ` · ${windowLabel}`}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {/* Рецепт крупного числа живёт в KpiValue — набирать его классами значит завести
              очередную копию (гейт design-motion-lint ловит это). `compact` — вторая величина, 30px. */}
            <KpiValue size="compact" text={fmt.kpi(summary.curSum)} className="text-foreground" />
            {/* Дельта только через deltaLabel: слова «выше/ниже» дублировали стрелку. */}
            <span className="text-sm text-muted-foreground">
              {delta ? (
                <>
                  <span className="font-medium tabular-nums text-foreground">{delta}</span> к прошлой неделе
                </>
              ) : (
                'без сравнения'
              )}
            </span>
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            {summary.prevSum > 0 && `Прошлая неделя ${fmt.kpi(summary.prevSum)}`}
            {summary.prevSum > 0 && summary.recordOfMonth && ' · '}
            {summary.recordOfMonth &&
              `рекорд месяца ${fmt.kpi(summary.recordOfMonth.v)} за день, ${fmt.day(summary.recordOfMonth.day)}`}
          </div>
        </div>
        <WeekRhythm summary={summary} />
      </div>
      {summary.insight && (
        <div className="min-w-0 flex-1">
          <NarrativeProse paragraphs={[summary.insight]} onPost={onPost} plainNumbers />
        </div>
      )}
      <WeekLedger summary={summary} onPost={onPost} median={median} />
    </div>
  );
}

/** Макет M и S (вариант B): заголовок-вывод и факты списком, число первым. Экспорт ради теста. */
export function WeekCompact({
  summary,
  onPost,
}: { summary: WeekSummary; onPost: (i: number) => void }) {
  const headline = summary.insight
    ? narrativeToPlain({ paragraphs: [summary.insight], quiet: false })
    : '';
  const delta = summary.pct == null ? null : deltaLabel({ dir: summary.pct < 0 ? 'down' : 'up', pct: Math.abs(summary.pct) });
  const facts: { value: string; rest: ReactNode }[] = [];
  facts.push({
    value: fmt.kpi(summary.curSum),
    rest: (
      <>
        просмотров за неделю
        {delta && <span className="text-muted-foreground">{` · ${delta} к прошлой`}</span>}
      </>
    ),
  });
  if (summary.peak) {
    facts.push({
      value: fmt.short(summary.peak.v),
      rest: (
        <>
          пик недели
          <span className="text-muted-foreground">{` · ${fmt.day(summary.peak.day)}, ${fmt.pctAbs(summary.peak.share)} суммы`}</span>
        </>
      ),
    });
  }
  if (summary.subsNow != null) {
    facts.push({
      value: fmt.kpi(summary.subsNow),
      rest: (
        <>
          подписчиков
          {summary.subsD7 != null && summary.subsD7 !== 0 && (
            <span className="text-muted-foreground">
              {` · ${summary.subsD7 > 0 ? '+' : '−'}${fmt.num(Math.abs(summary.subsD7))} за неделю`}
            </span>
          )}
        </>
      ),
    });
  }
  if (summary.best) {
    facts.push({
      value: fmt.short(summary.best.views),
      rest: (
        <>
          <button
            type="button"
            onClick={() => onPost(summary.best!.postIndex)}
            className="rounded text-left transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            просмотра у лучшей публикации
            {/* Заголовок поста — контекст, а не факт: в узкой S он раздувал строку до трёх
                и выталкивал список за 264px (замер: тайл 313px). Сокращаем КОНТЕКСТ, а не факты (ТЗ-11);
                полное название остаётся в карточке поста по клику. */}
            <span className="hidden text-muted-foreground tile-wide:inline">{` · «${summary.best.title}»`}</span>
          </button>
        </>
      ),
    });
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {headline && <p className="text-base font-medium leading-snug text-foreground">{headline}</p>}
      {/* ОДНА КОЛОНКА, а не две. ТЗ допускало две колонки в M, но замер живой карточки
          показал обратное: тайл M — 501px, две колонки дают по 238px, подпись ломается на три
          строки, и число отрывается от своей подписи — ровно та каша, ради борьбы с которой всё
          и затевалось. В одну колонку четыре факта влезают целиком и сканируются как таблица. */}
      <ul className="min-h-0 flex-1 space-y-2">
        {facts.map((f) => (
          // items-start, а не items-baseline: в grid-строке базовой считается линия ПОСЛЕДНЕЙ строки
          // двухстрочной подписи, и число уезжало вниз, теряя связь со своей первой строкой.
          <li key={f.value + String(f.rest)} className="grid grid-cols-[96px_1fr] items-start gap-x-2">
            <span className="text-base font-medium tabular-nums text-foreground">{f.value}</span>
            <span className="min-w-0 text-sm leading-snug text-foreground">{f.rest}</span>
          </li>
        ))}
      </ul>
      {(summary.recordOfMonth || summary.ig) && (
        // Сноска живёт только в широком тайле (M). По ВЫСОТЕ её отличить нельзя: у M и S
        // один и тот же фикс-тайл 264px, и height-запрос прятал сноску в обоих (замер: тело 181px).
        // Факты важнее контекста, поэтому в узкой S уходит именно она (ТЗ-11).
        <p className="hidden shrink-0 text-xs text-muted-foreground tile-wide:block">
          {summary.recordOfMonth &&
            `Рекорд месяца старше недели: ${fmt.kpi(summary.recordOfMonth.v)} за день, ${fmt.day(summary.recordOfMonth.day)}.`}
          {summary.recordOfMonth && summary.ig && ' '}
          {summary.ig &&
            `Instagram за ту же неделю: охват ${fmt.kpi(summary.ig.reach)}, ${deltaLabel({ dir: summary.ig.pct < 0 ? 'down' : 'up', pct: Math.abs(summary.ig.pct) }) ?? '0%'}.`}
        </p>
      )}
    </div>
  );
}

export function NarrativeWeekBody() {
  const { input, posts, loading, error, retry } = useWeekNarrativeInput();
  const { input: igInput } = useIgWeekInput();
  const [openPost, setOpenPost] = useState<number | null>(null);
  const size = useWidgetSize();
  const large = size === 'full';
  if (error) return <ErrorState title="Не удалось загрузить неделю" onRetry={retry} />;
  if (loading || !input) {
    // Скелетон повторяет ГЕОМЕТРИЮ своего макета, а не три абстрактные строки: иначе карточка
    // прыгает при доезде данных — тот же дефект, что у скелетонов борда (аудит #554, D16).
    return large ? (
      <div className="flex h-full flex-col gap-4" aria-hidden="true">
        <div className="grid items-end gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-[72px] w-full" />
        </div>
        <Skeleton className="h-3.5 w-4/5" />
        <div className="flex gap-10 border-t border-border pt-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>
    ) : (
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="h-4 w-11/12" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-4 w-4/5" />
        ))}
      </div>
    );
  }
  // TG-часть не ждёт Instagram: его строка в леджере догружается позже и ничего не сдвигает.
  const summary = buildWeekSummary({ ...input, ig: igInput });
  // Медиана охвата недели — контекст для лучшей публикации, а не своя строка леджера.
  const median = periodMedian(posts.map((post) => post.reach));
  return (
    <>
      {large ? (
        <WeekLarge summary={summary} onPost={setOpenPost} median={median} />
      ) : (
        <WeekCompact summary={summary} onPost={setOpenPost} />
      )}
      {openPost != null && posts[openPost] && (
        <PostDetailModal post={posts[openPost]!} reason={null} onClose={() => setOpenPost(null)} />
      )}
    </>
  );
}

/** Общий рендерер «текста-с-данными»: абзацы сегментов. Чип-пост: href (IG-медиа → permalink) или
 * postIndex (TG → PostDetailModal через onPost). Используют и TG-«Неделя канала», и IG-«Неделя».
 * Приклейка «сиротской» пунктуации к инлайн-элементу (спарк/пилюля) — РЕЗЕРВ, а не текущее
 * поведение: ни один сегмент нынешних шаблонов (narrative.ts) не ставит `.`/`,` сразу после
 * спарка или дельты — точку теперь несёт текст ДО искры. Ветки оставлены страховкой для будущих
 * формулировок; поведение по умолчанию — ровно то, что описано выше. */
export function NarrativeProse({
  paragraphs,
  onPost,
  wide = false,
  plainNumbers = false,
}: {
  paragraphs: NarrativeParagraph[];
  onPost?: (i: number) => void;
  wide?: boolean;
  /** Снять пунктирное подчёркивание чисел — см. SegSpan (аудит #554, ТЗ-11). */
  plainNumbers?: boolean;
}) {
  const post = onPost ?? (() => {});
  return (
    // `wide` — только для карточки во весь ряд: одна колонка под max-w-prose (≈65ch, канон
    // читаемости) оставляла бы правую половину 1110px-ряда пустой. Две колонки заполняют ширину,
    // НЕ трогая меру строки, а break-inside-avoid не даёт абзацу с инлайн-искрой разорваться по
    // колонкам. Узкие карточки (IG-неделя) остаются одноколоночными.
    <div
      className={cn(
        'space-y-3.5 text-sm leading-relaxed text-ink2',
        wide ? 'lg:columns-2 lg:gap-10 lg:space-y-0 [&>p]:break-inside-avoid lg:[&>p]:mb-3.5' : 'max-w-prose',
      )}
    >
      {paragraphs.map((p, i) => (
        <p key={i}>
          {p.map((seg, j) => {
            const next = p[j + 1];
            // ЧИСЛО + ИСКРА — ОДНО СЛОВО (аудит #554, D7). Искра объясняет именно это число,
            // и разорвать их переносом значит потерять связь. Сама искра рендерится в этой же ветке,
            // поэтому следующая итерация её пропускает.
            if (seg.kind === 'number' && next?.kind === 'spark') {
              return (
                <span key={j} className="whitespace-nowrap">
                  <SegSpan seg={seg} onPost={post} plainNumbers={plainNumbers} />
                  <SegSpan seg={next} onPost={post} plainNumbers={plainNumbers} />
                </span>
              );
            }
            if (seg.kind === 'spark' && p[j - 1]?.kind === 'number') return null;
            // Резервная ветка (см. JSDoc): текущие шаблоны пунктуацию после спарка/дельты не ставят.
            if ((seg.kind === 'spark' || seg.kind === 'delta') && next?.kind === 'text' && /^[.,]/.test(next.text)) {
              return (
                <span key={j} className="whitespace-nowrap">
                  <SegSpan seg={seg} onPost={post} plainNumbers={plainNumbers} />
                  {next.text.slice(0, 1)}
                </span>
              );
            }
            if (seg.kind === 'text' && /^[.,]/.test(seg.text)) {
              const prev = p[j - 1];
              if (prev && (prev.kind === 'spark' || prev.kind === 'delta')) {
                return <SegSpan key={j} seg={{ kind: 'text', text: seg.text.slice(1) }} onPost={post} plainNumbers={plainNumbers} />;
              }
            }
            return <SegSpan key={j} seg={seg} onPost={post} plainNumbers={plainNumbers} />;
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
  // full, а не half: у third/half высота заперта в 264px (SIZE_HEIGHT), и рассказ туда не влезает —
  // раньше это прятал собственный скроллер с маской, теперь высота контентная. Дефолт живёт ЗДЕСЬ,
  // а не только на Обзоре: пин Главной (homeWidgets) размер не задаёт и наследовал прежний half,
  // из-за чего гейт «no inner scrollbars — home» честно падал.
  defaultSize = 'full',
  fixedSize,
  title = 'Неделя канала',
}: { id?: string; homeKey?: string; defaultSize?: WidgetSize; fixedSize?: WidgetSize; title?: string } = {}) {
  return (
    <ChartSection id={id} homeKey={homeKey} title={title} defaultSize={defaultSize} fixedSize={fixedSize} noExpand>
      <NarrativeWeekBody />
    </ChartSection>
  );
}
