import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartSection as RailSection } from '@/components/instagram/shared';
import { SegmentedControl } from '@/components/SegmentedControl';
import { PeriodChips } from '@/components/PeriodChips';
import { SourceIdentity } from '@/components/SourceIdentity';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { Breakdown } from '@/components/Breakdown';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { HeatmapWidgetBody, VelocityWidgetBody } from '@/panels/Charts';
import { usePeriod, calendarWindowForPeriod } from '@/lib/period';
import { WidgetPeriodProvider, widgetPeriodValue } from '@/lib/period';
import type { PeriodDays, DateRange, WidgetPeriodValue } from '@/lib/period';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { isTgExtraMetricKey } from '@/panels/tgMetricKeys';
import { useTgFull, useTgGraphs } from '@/api/queries';
import type { TgFull, TgGraphs } from '@/api/schemas';
import { useTgCampaignScope } from '@/lib/campaignFilter';
import { normalizeTgPosts } from '@/lib/posts';
import { fmt, pluralRu } from '@/lib/format';
import type { BreakdownLikeItem } from '@/components/widgets/variants';
import {
  deriveEmojis,
  deriveCompositionFromPosts,
  deriveViewsByTypeFromPosts,
  deriveFormatPerf,
  deriveWeekday,
  deriveFollowerFlows,
  tgViewsBySourceItems,
  tgNewFollowersBySourceItems,
  tgLanguageItems,
  tgSentimentItems,
  tgTopHours,
  WD_LABELS,
} from '@/panels/TgAnalytics';
import { deriveWeekdayReach, deriveFormatViews } from '@/panels/Compare';
import { deriveHashtags } from '@/panels/Hashtags';

/**
 * Полностраничные «дополнительные» графики Telegram — `/metrics/tg-*`. Это те карточки вкладок
 * Аналитики, что НЕ входят в числовой drill-набор kpiDerive (views/avgReach/…/subscribers → steep
 * MetricPage): тепловая карта активности и профиль скорости набора просмотров. Раньше они открывали
 * generic `?detail=` оверлей — теперь ведут на выделенный route той же грамматики, что `/metrics/ig-views`
 * и `/metrics/ym-visits`: назад-ссылка, тихая шапка (имя метрики + источник + дескриптор), две колонки
 * (главный блок + rail «О метрике»), контролы под графиком.
 *
 * ЧЕСТНОСТЬ важнее паритета: тепловая карта — своя 7×24 форма без Line/Bar/сравнения; скорость —
 * настоящий кумулятивный профиль с выбором Line/Bar, но без выдуманного baseline-сравнения (это
 * агрегат по всем постам, у него нет «прошлого периода»).
 */
export function TgMetricPage({ metricKey }: { metricKey: string }) {
  if (!isTgExtraMetricKey(metricKey)) return null;
  switch (metricKey) {
    case 'tg-heatmap':
      return <TgHeatmapPage />;
    case 'tg-velocity':
      return <TgVelocityPage />;
    case 'tg-churn':
      return <TgChurnPage />;
    case 'tg-weekday-reach':
    case 'tg-weekday-views':
    case 'tg-post-count':
    case 'tg-hours':
      return <TgCategorySeriesPage def={CATEGORY_DEFS[metricKey]} />;
    default:
      return <TgBreakdownPage def={BREAKDOWN_DEFS[metricKey]} />;
  }
}

/** Re-export guard so the route dispatcher can gate `tg-*` extra keys without importing the page eagerly. */
export { isTgExtraMetricKey };

// ── Shared shell ─────────────────────────────────────────────────────────────────────────────

interface AboutDef {
  formula: string;
  included?: string;
  source: string;
}

/** Тихая шапка + две колонки (главный блок + rail «О метрике»/сравнение), как у `/metrics/ig-reach`.
    Назад ведёт на конкретную вкладку Аналитики, откуда карточка засеяла drillTo. */
function TgMetricShell({
  back,
  term,
  descriptor,
  about,
  aside,
  children,
}: {
  back: { to: string; label: string };
  term: string;
  descriptor?: string;
  about: AboutDef;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Link
        to={back.to}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> {back.label}
      </Link>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="tg" className="mt-1 max-w-full" />
        {descriptor && <div className="mt-1.5 text-xs text-muted-foreground">{descriptor}</div>}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="space-y-6">
          {aside}
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={about.formula} />
              {about.included && <AboutRow label="Что учитывается" text={about.included} />}
              <AboutRow label="Источник" text={about.source} />
            </dl>
          </RailSection>
          <Link
            to={back.to}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть Аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
    </div>
  );
}

function AboutRow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-foreground">{text}</dd>
    </div>
  );
}

/** Полноэкранная карточка с раскрытым (не-expandable) телом — та же роль, что у YmReportCard.
    Раскрытые контексты дают LineChart/BarChart полную высоту explorer'а (heatmap их игнорирует). */
function TgReportCard({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  const chartH = useExplorerChartHeight();
  return (
    <ChartWidget id={id} title={title} defaultSize="full" noExpand action={action}>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartH}>{children}</ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </ChartWidget>
  );
}

// ── Activity heatmap page ──────────────────────────────────────────────────────────────────────

/** Тепловая карта активности 7×24 — своя форма распределения, БЕЗ Line/Bar/сравнения. Тело
    (HeatmapWidgetBody) само фетчит useTgFull(0) и окном режет по useWidgetPeriod, поэтому оборачиваем
    в WidgetPeriodProvider, засеянный глобальным explorer-периодом (тем, что drillTo протащил из
    фид-топбара). Прямой заход/reload держат контекст: usePeriod URL-persist + канал из useSelectedChannel. */
function TgHeatmapPage() {
  const { days, setDays, range, setRange } = usePeriod();
  return (
    <TgMetricShell
      back={{ to: '/analytics?tab=audience', label: 'Аналитика · Аудитория' }}
      term="Тепловая карта активности"
      descriptor="Когда посты собирают вовлечённость — сетка 7×24 по среднему ERV слота за выбранное окно"
      about={{
        formula:
          'Для каждого слота (день недели × час публикации) — средний ERV постов слота (реакции + репосты + ответы ÷ просмотры). Насыщенность нормирована на максимум окна; рамкой отмечен лучший слот.',
        included:
          'ERV — вовлечённость на просмотр, не абсолют. Часы — в часовом поясе браузера (как в дате поста). Пустые края суток скрываются, чтобы узкое окно не тонуло в мёртвых клетках.',
        source: 'Посты канала (архив Telegram) за выбранное окно.',
      }}
    >
      <TgReportCard id="tg-page-heatmap" title="По дням недели и часам">
        <WidgetPeriodProvider value={widgetPeriodValue(days, range)}>
          <HeatmapWidgetBody />
        </WidgetPeriodProvider>
      </TgReportCard>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
        <span className="text-xs font-medium text-muted-foreground">Окно</span>
        <span className="flex-1" />
        <PeriodChips ariaLabel="Окно" value={days} onChange={setDays} range={range} onRangeChange={setRange} />
      </div>
    </TgMetricShell>
  );
}

// ── Views-velocity page ────────────────────────────────────────────────────────────────────────

/** Скорость набора просмотров — кумулятивный профиль (какая доля итоговых просмотров набрана к N-м
    суткам после публикации, усреднённо по постам). Line/Bar оба честны для накопительной кривой;
    сравнения нет — это агрегат-профиль по всем постам, «прошлого периода» у него не существует.
    useVelocity() без периода (ключ — канал), так что окна тут нет, как и у ym-hourly нет Line/Bar. */
function TgVelocityPage() {
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  return (
    <TgMetricShell
      back={{ to: '/analytics?tab=dynamics', label: 'Аналитика · Динамика' }}
      term="Скорость набора просмотров"
      descriptor="Как быстро пост добирает свои просмотры — накопленная доля по суткам после публикации"
      about={{
        formula:
          'Для каждого поста доля итоговых просмотров, набранная к N-м суткам жизни; кривая — среднее по постам. «80% за K дн» — когда накоплено 80% просмотров.',
        included:
          'Это профиль ЖИЗНИ поста (сутки после публикации), а не календарная динамика. Считается по постам с достаточной историей просмотров.',
        source: 'Дневная история просмотров постов канала (Telegram).',
      }}
    >
      <TgReportCard
        id="tg-page-velocity"
        title="Накопленная доля просмотров"
        action={
          <SegmentedControl
            ariaLabel="Тип графика"
            className="shrink-0"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'line', content: 'Линия', ariaLabel: 'Тип графика: Линия' },
              { value: 'bar', content: 'Столбцы', ariaLabel: 'Тип графика: Столбцы' },
            ]}
          />
        }
      >
        <VelocityWidgetBody viz={kind === 'bar' ? 'bar' : 'line'} />
      </TgReportCard>
    </TgMetricShell>
  );
}

// ── Shared window + rail helpers for the migrated chart cards ─────────────────────────────────────

/** Назад-цели: каждая карточка возвращает на СВОЮ вкладку Аналитики. */
const BACK = {
  compare: { to: '/analytics?tab=compare', label: 'Аналитика · Сравнение' },
  content: { to: '/analytics?tab=content', label: 'Аналитика · Форматы' },
  audience: { to: '/analytics?tab=audience', label: 'Аналитика · Аудитория' },
  dynamics: { to: '/analytics?tab=dynamics', label: 'Аналитика · Динамика' },
} as const;

/** Дефолтный rail-текст «Сравнение» для разрезов/распределений без канонической метрики периода. */
const LIST_COMPARISON =
  'Это разрез за окно, а не одна метрика периода — сравнение с прошлым периодом здесь не рассчитывается. Меняйте окно, чтобы пересобрать карточку.';
/** Для graphs-разрезов (источники/языки/тональность/часы): фиксированное окно статистики Telegram. */
const GRAPHS_COMPARISON =
  'Разрез статистики канала за доступное окно Telegram — не метрика периода, сравнение с прошлым периодом не рассчитывается.';

const keepAll = (): boolean => true;

/** Нормализованные посты выбранного источника, суженные окном (та же связка, что у карточек). */
function windowedPosts(full: TgFull | undefined, inRange: (dateISO: string | null | undefined) => boolean) {
  return normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((p) => inRange(p.date));
}

interface TgMetricWindow {
  days: PeriodDays;
  range: DateRange | null;
  setDays: (days: PeriodDays) => void;
  setRange: (range: DateRange | null) => void;
  period: WidgetPeriodValue;
}

/** Живое окно из глобального explorer-периода (тот, что drillTo засеял из фид-топбара); прямой
    заход/reload держат его (usePeriod URL-seed + канал из useSelectedChannel через SourceIdentity). */
function useTgMetricWindow(): TgMetricWindow {
  const { days, setDays, range, setRange } = usePeriod();
  return { days, range, setDays, setRange, period: widgetPeriodValue(days, range) };
}

/** Пресеты окна одной строкой под карточкой (тайм-бар принадлежит контенту, а не краю экрана). */
function TgWindowBar({ window }: { window: TgMetricWindow }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">Окно</span>
      <span className="flex-1" />
      <PeriodChips ariaLabel="Окно" value={window.days} onChange={window.setDays} range={window.range} onRangeChange={window.setRange} />
    </div>
  );
}

/** Rail «Сравнение» с честным пояснением, почему сравнения периодов нет (требование дизайна). */
function TgNoComparison({ text }: { text: string }) {
  return (
    <RailSection title="Сравнение">
      <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>
    </RailSection>
  );
}

function ReportSkeleton() {
  return <Skeleton className="h-[360px] w-full" />;
}

// ── Categorical breakdown pages (truthful rank list, no fabricated Line/Bar or comparison) ────────

interface DeriveCtx {
  full: TgFull | undefined;
  graphs: TgGraphs | undefined;
  period: WidgetPeriodValue;
  keep: (postId: number | null | undefined) => boolean;
}

interface TgBreakdownDef {
  cardId: string;
  back: { to: string; label: string };
  term: string;
  descriptor: string;
  cardTitle: string;
  about: AboutDef;
  /** Which payload gates loading/error — posts (period-scoped) vs graphs (fixed Telegram window). */
  source: 'posts' | 'graphs';
  /** Post-derived cards follow the seeded window; graphs cards are period-agnostic (no window bar). */
  periodControl: boolean;
  /** Content/hashtag cards honour the selected campaign carried in on `?campaign=`. */
  campaignScoped: boolean;
  comparison: string;
  derive: (ctx: DeriveCtx) => BreakdownLikeItem[];
  footer?: (ctx: DeriveCtx) => ReactNode;
  empty: { title: string; reason?: string };
}

/**
 * Полноэкранный разрез: TRUTHFUL rank-список (Breakdown раскрыт на всю высоту через
 * ChartExpandedContext) — ни выдуманного графика-времянки, ни выбора Line/Bar, ни baseline-сравнения.
 * Пост-производные карточки следуют засеянному окну (и кампании из `?campaign=`); graphs-разрезы
 * период-агностичны (фиксированное окно статистики Telegram) — у них нет тайм-бара.
 */
function TgBreakdownPage({ def }: { def: TgBreakdownDef }) {
  const window = useTgMetricWindow();
  const full = useTgFull(0);
  const graphs = useTgGraphs();
  const campaign = useTgCampaignScope();
  const q = def.source === 'graphs' ? graphs : full;
  const keep = def.campaignScoped && campaign.active ? campaign.inCampaign : keepAll;
  const ctx: DeriveCtx = { full: full.data, graphs: graphs.data, period: window.period, keep };
  const campaignPending = def.campaignScoped && campaign.active && campaign.isPending;
  const campaignError = def.campaignScoped && campaign.active && campaign.isError;
  const pending = q.isPending || campaignPending;
  const items = !pending && !q.isError && !campaignError ? def.derive(ctx) : [];
  const back =
    def.campaignScoped && campaign.campaignId != null
      ? { ...def.back, to: `${def.back.to}&campaign=${campaign.campaignId}` }
      : def.back;

  return (
    <TgMetricShell
      back={back}
      term={def.term}
      descriptor={def.descriptor}
      about={def.about}
      aside={<TgNoComparison text={def.comparison} />}
    >
      <TgReportCard id={def.cardId} title={def.cardTitle}>
        {pending ? (
          <ReportSkeleton />
        ) : q.isError || campaignError ? (
          <ErrorState
            title={campaignError ? 'Не удалось загрузить состав кампании' : 'Не удалось загрузить данные'}
            onRetry={campaignError ? campaign.retry : () => void q.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState compact size="chart" title={def.empty.title} reason={def.empty.reason} />
        ) : (
          <>
            <Breakdown items={items} />
            {def.footer?.(ctx)}
          </>
        )}
      </TgReportCard>
      {def.periodControl && <TgWindowBar window={window} />}
    </TgMetricShell>
  );
}

// ── Category Bar/Line pages (weekday / hour axis — Line is truthful for a category series) ─────────

interface CategoryResult {
  values: number[];
  labels: string[];
  titles: string[];
}

interface TgCategoryDef {
  cardId: string;
  back: { to: string; label: string };
  term: string;
  descriptor: string;
  cardTitle: string;
  about: AboutDef;
  source: 'posts' | 'graphs';
  periodControl: boolean;
  comparison: string;
  derive: (ctx: DeriveCtx) => CategoryResult;
  footer?: (ctx: DeriveCtx) => ReactNode;
  empty: { title: string; reason?: string };
}

/**
 * Полноэкранная категориальная серия по фиксированной оси (дни недели / часы суток). Line ЧЕСТЕН для
 * категориальной оси ровно там, где исходная карточка уже давала Bar/Line — поэтому оставляем выбор
 * Тип графика (Линия/Столбцы). Никакого сравнения периодов: это распределение за окно, а не метрика.
 */
function TgCategorySeriesPage({ def }: { def: TgCategoryDef }) {
  const window = useTgMetricWindow();
  const full = useTgFull(0);
  const graphs = useTgGraphs();
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const q = def.source === 'graphs' ? graphs : full;
  const ctx: DeriveCtx = { full: full.data, graphs: graphs.data, period: window.period, keep: keepAll };
  const result = !q.isPending && !q.isError ? def.derive(ctx) : null;
  const hasData = result != null && result.values.length > 0 && result.values.some((v) => v > 0);

  return (
    <TgMetricShell
      back={def.back}
      term={def.term}
      descriptor={def.descriptor}
      about={def.about}
      aside={<TgNoComparison text={def.comparison} />}
    >
      <TgReportCard
        id={def.cardId}
        title={def.cardTitle}
        action={
          <SegmentedControl
            ariaLabel="Тип графика"
            className="shrink-0"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'line', content: 'Линия', ariaLabel: 'Тип графика: Линия' },
              { value: 'bar', content: 'Столбцы', ariaLabel: 'Тип графика: Столбцы' },
            ]}
          />
        }
      >
        {q.isPending ? (
          <ReportSkeleton />
        ) : q.isError ? (
          <ErrorState title="Не удалось загрузить данные" onRetry={() => void q.refetch()} />
        ) : !hasData || !result ? (
          <EmptyState compact size="chart" title={def.empty.title} reason={def.empty.reason} />
        ) : kind === 'line' ? (
          <LineChart values={result.values} labels={result.labels} titles={result.titles} yMin={0} />
        ) : (
          <BarChart values={result.values} labels={result.labels} titles={result.titles} />
        )}
        {hasData && def.footer?.(ctx)}
      </TgReportCard>
      {def.periodControl && <TgWindowBar window={window} />}
    </TgMetricShell>
  );
}

// ── Churn page (join/left over the resolved window) ───────────────────────────────────────────────

/** «Динамика оттока» — подписалось/отписалось за окно (два ряда + «N всего»), как исходная карточка:
    единственная truthful форма — список, без выдуманного графика/сравнения. */
function TgChurnPage() {
  const window = useTgMetricWindow();
  const graphs = useTgGraphs();
  const flow = deriveFollowerFlows(graphs.data, calendarWindowForPeriod({ days: window.days, range: window.range }));
  const flowTotal = flow.joinedTotal + flow.leftTotal;
  const rowDisplay = (value: number) =>
    flowTotal > 0 ? `${fmt.num(value)} · ${Math.round((value / flowTotal) * 100)}%` : fmt.num(value);

  return (
    <TgMetricShell
      back={BACK.dynamics}
      term="Динамика оттока"
      descriptor="Сколько подписалось и отписалось за выбранное окно"
      about={{
        formula: 'Из дневных потоков подписок/отписок канала — суммы «подписалось» и «отписалось» за окно; доли считаются от их суммы.',
        included: 'Отписки Telegram отдаёт дневным потоком (как и подписки). Это не уровень базы — уровень живёт в «Истории подписчиков».',
        source: 'Дневные потоки подписчиков канала (Telegram graphs) за выбранное окно.',
      }}
      aside={<TgNoComparison text={LIST_COMPARISON} />}
    >
      <TgReportCard id="tg-page-churn" title="Подписки и отписки за окно">
        {graphs.isPending ? (
          <ReportSkeleton />
        ) : graphs.isError ? (
          <ErrorState title="Не удалось загрузить данные" onRetry={() => void graphs.refetch()} />
        ) : flow.values.length === 0 ? (
          <EmptyState compact size="chart" title="Нет данных за выбранный период." />
        ) : (
          <>
            <Breakdown
              items={[
                { label: 'Отписалось', value: flow.leftTotal, display: rowDisplay(flow.leftTotal) },
                { label: 'Подписалось', value: flow.joinedTotal, display: rowDisplay(flow.joinedTotal) },
              ]}
            />
            <div className="mt-3 text-xs font-medium text-muted-foreground">{fmt.num(flowTotal)} всего</div>
          </>
        )}
      </TgReportCard>
      <TgWindowBar window={window} />
    </TgMetricShell>
  );
}

// ── Definition tables ─────────────────────────────────────────────────────────────────────────────

type BreakdownKey =
  | 'tg-format-views'
  | 'tg-hashtag-erv'
  | 'tg-emoji'
  | 'tg-engagement-mix'
  | 'tg-reach-by-type'
  | 'tg-erv-by-format'
  | 'tg-views-by-source'
  | 'tg-followers-by-source'
  | 'tg-languages'
  | 'tg-sentiment';

const BREAKDOWN_DEFS: Record<BreakdownKey, TgBreakdownDef> = {
  'tg-format-views': {
    cardId: 'tg-page-format-views',
    back: BACK.compare,
    term: 'По форматам (просмотры)',
    descriptor: 'Суммарные просмотры публикаций по формату за выбранное окно',
    cardTitle: 'Просмотры по форматам',
    about: {
      formula: 'Публикации окна группируются по формату (текст/фото/видео/файл/альбом); строка — суммарные просмотры формата и число публикаций.',
      source: 'Публикации канала (архив Telegram) за выбранное окно.',
    },
    source: 'posts',
    periodControl: true,
    campaignScoped: false,
    comparison: LIST_COMPARISON,
    derive: (ctx) => deriveFormatViews(windowedPosts(ctx.full, ctx.period.inRange)),
    empty: { title: 'Нет публикаций за период' },
  },
  'tg-hashtag-erv': {
    cardId: 'tg-page-hashtag-erv',
    back: BACK.content,
    term: 'Влияние хэштегов на ERV',
    descriptor: 'Насколько тег поднимает вовлечённость против постов без тегов',
    cardTitle: 'Хэштеги по приросту ERV',
    about: {
      formula: 'Для каждого тега (≥2 постов окна) — средний ERV его постов и множитель к базе «без тегов». Топ-10 по множителю (иначе по среднему ERV).',
      included: 'ERV — вовлечённость на просмотр. Зелёный множитель ≥1 — тег поднимает ERV, янтарный <1 — опускает.',
      source: 'Публикации канала (архив Telegram) за выбранное окно; при выбранной кампании — только её публикации из этого источника.',
    },
    source: 'posts',
    periodControl: true,
    campaignScoped: true,
    comparison: LIST_COMPARISON,
    derive: (ctx) => deriveHashtags(ctx.full, ctx.period.inRange, ctx.keep).breakdownItems,
    footer: (ctx) => {
      const { baseAvg } = deriveHashtags(ctx.full, ctx.period.inRange, ctx.keep);
      if (baseAvg === null) return null;
      return (
        <div className="mt-3 text-xs font-medium text-muted-foreground">
          база без тегов: <strong className="text-foreground">{baseAvg.toFixed(1)}%</strong> ERV
        </div>
      );
    },
    empty: { title: 'Мало данных для хэштегов', reason: 'Нужно ≥2 поста с одним хэштегом' },
  },
  'tg-emoji': {
    cardId: 'tg-page-emoji',
    back: BACK.content,
    term: 'Реакции по эмодзи',
    descriptor: 'Какие эмодзи-реакции собирают публикации за выбранное окно',
    cardTitle: 'Реакции по эмодзи',
    about: {
      formula: 'Суммарное число реакций каждого эмодзи по публикациям окна; топ-8 по количеству.',
      source: 'Реакции публикаций канала (архив Telegram) за выбранное окно; при выбранной кампании — только её публикации.',
    },
    source: 'posts',
    periodControl: true,
    campaignScoped: true,
    comparison: LIST_COMPARISON,
    derive: (ctx) =>
      deriveEmojis(ctx.full, ctx.period.inRange, ctx.keep).map((e) => ({ label: e.label, value: e.value, display: fmt.num(e.value) })),
    empty: { title: 'Нет реакций за период' },
  },
  'tg-engagement-mix': {
    cardId: 'tg-page-engagement-mix',
    back: BACK.content,
    term: 'Состав вовлечённости',
    descriptor: 'Как распределяется вовлечённость публикаций окна',
    cardTitle: 'Состав вовлечённости',
    about: {
      formula: 'Суммы реакций, репостов и комментариев по публикациям окна.',
      source: 'Публикации канала (архив Telegram) за окно; при выбранной кампании — только её публикации (не общий свод канала).',
    },
    source: 'posts',
    periodControl: true,
    campaignScoped: true,
    comparison: LIST_COMPARISON,
    derive: (ctx) =>
      deriveCompositionFromPosts(ctx.full, ctx.period.inRange, ctx.keep).map((c) => ({
        label: c.label,
        value: c.value,
        display: fmt.num(c.value),
        color: c.color,
      })),
    empty: { title: 'Нет вовлечённости за период' },
  },
  'tg-reach-by-type': {
    cardId: 'tg-page-reach-by-type',
    back: BACK.content,
    term: 'Ср. охват по типу',
    descriptor: 'Средние просмотры публикации по типу за выбранное окно',
    cardTitle: 'Средний охват по типу',
    about: {
      formula: 'Средние просмотры публикации по типу медиа (фото/видео/текст/…) по публикациям окна.',
      source: 'Публикации канала (архив Telegram) за окно; при выбранной кампании — только её публикации (не общий свод канала).',
    },
    source: 'posts',
    periodControl: true,
    campaignScoped: true,
    comparison: LIST_COMPARISON,
    derive: (ctx) =>
      deriveViewsByTypeFromPosts(ctx.full, ctx.period.inRange, ctx.keep).map((t) => ({ label: t.label, value: t.value, display: fmt.num(t.value) })),
    empty: { title: 'Нет публикаций за период' },
  },
  'tg-erv-by-format': {
    cardId: 'tg-page-erv-by-format',
    back: BACK.content,
    term: 'Вовлечённость по формату',
    descriptor: 'Средний ERV публикации по формату за выбранное окно',
    cardTitle: 'ERV по формату',
    about: {
      formula: 'Средний ERV (вовлечённость на просмотр) по типу медиа среди публикаций окна.',
      source: 'Публикации канала (архив Telegram) за окно; при выбранной кампании — только её публикации.',
    },
    source: 'posts',
    periodControl: true,
    campaignScoped: true,
    comparison: LIST_COMPARISON,
    derive: (ctx) =>
      deriveFormatPerf(ctx.full, ctx.period.inRange, ctx.keep).map((f) => ({
        label: f.label,
        value: f.avgErv,
        display: `${f.avgErv.toFixed(1)}% ERV · ${f.n} ${pluralRu(f.n, ['пост', 'поста', 'постов'])}`,
      })),
    empty: { title: 'Нет публикаций за период' },
  },
  'tg-views-by-source': {
    cardId: 'tg-page-views-by-source',
    back: BACK.audience,
    term: 'Просмотры по источникам',
    descriptor: 'Откуда пришли просмотры публикаций канала',
    cardTitle: 'Просмотры по источникам',
    about: {
      formula: 'Группировка просмотров по источнику показа (подписчики/ссылки/поиск/каналы/…).',
      included: 'Это разрез статистики канала за доступное окно Telegram — он не сужается локальным окном страницы.',
      source: 'Статистика канала (Telegram graphs, views_by_source).',
    },
    source: 'graphs',
    periodControl: false,
    campaignScoped: false,
    comparison: GRAPHS_COMPARISON,
    derive: (ctx) => tgViewsBySourceItems(ctx.graphs),
    empty: { title: 'Нет данных по источникам' },
  },
  'tg-followers-by-source': {
    cardId: 'tg-page-followers-by-source',
    back: BACK.audience,
    term: 'Новые подписчики по источникам',
    descriptor: 'Откуда пришли новые подписчики канала',
    cardTitle: 'Новые подписчики по источникам',
    about: {
      formula: 'Группировка новых подписчиков по источнику (подписчики/ссылки/поиск/каналы/…).',
      included: 'Разрез статистики канала за доступное окно Telegram — не сужается локальным окном страницы.',
      source: 'Статистика канала (Telegram graphs, new_followers_by_source).',
    },
    source: 'graphs',
    periodControl: false,
    campaignScoped: false,
    comparison: GRAPHS_COMPARISON,
    derive: (ctx) => tgNewFollowersBySourceItems(ctx.graphs),
    empty: { title: 'Нет данных по источникам' },
  },
  'tg-languages': {
    cardId: 'tg-page-languages',
    back: BACK.audience,
    term: 'Языки аудитории',
    descriptor: 'Языки интерфейса подписчиков канала',
    cardTitle: 'Языки аудитории',
    about: {
      formula: 'Группировка аудитории по языку интерфейса Telegram; топ-8 по величине.',
      included: 'Разрез статистики канала за доступное окно Telegram — не сужается локальным окном страницы.',
      source: 'Статистика канала (Telegram graphs, languages).',
    },
    source: 'graphs',
    periodControl: false,
    campaignScoped: false,
    comparison: GRAPHS_COMPARISON,
    derive: (ctx) => tgLanguageItems(ctx.graphs),
    empty: { title: 'Нет данных по языкам' },
  },
  'tg-sentiment': {
    cardId: 'tg-page-sentiment',
    back: BACK.audience,
    term: 'Тональность реакций',
    descriptor: 'Соотношение положительных и отрицательных реакций',
    cardTitle: 'Тональность реакций',
    about: {
      formula: 'Группировка реакций по тональности (положительные/прочие/отрицательные).',
      included: 'Разрез статистики канала за доступное окно Telegram — не сужается локальным окном страницы.',
      source: 'Статистика канала (Telegram graphs, reactions_sentiment).',
    },
    source: 'graphs',
    periodControl: false,
    campaignScoped: false,
    comparison: GRAPHS_COMPARISON,
    derive: (ctx) => tgSentimentItems(ctx.graphs),
    empty: { title: 'Нет данных по тональности' },
  },
};

type CategoryKey = 'tg-weekday-reach' | 'tg-weekday-views' | 'tg-post-count' | 'tg-hours';

const CATEGORY_DEFS: Record<CategoryKey, TgCategoryDef> = {
  'tg-weekday-reach': {
    cardId: 'tg-page-weekday-reach',
    back: BACK.compare,
    term: 'Охват по дням недели',
    descriptor: 'Средний охват публикации по дню недели за выбранное окно',
    cardTitle: 'Средний охват по дням недели',
    about: {
      formula: 'Для каждого дня недели — СРЕДНИЙ охват публикации этого дня за окно (не сумма). День берётся в UTC, как в дневных графиках.',
      source: 'Публикации канала (архив Telegram) за выбранное окно.',
    },
    source: 'posts',
    periodControl: true,
    comparison: 'Среднее по дням недели за окно — распределение, а не метрика периода; сравнение с прошлым периодом не рассчитывается.',
    derive: (ctx) => {
      const w = deriveWeekdayReach(windowedPosts(ctx.full, ctx.period.inRange));
      return {
        values: w.values,
        labels: w.labels,
        titles: w.values.map((v, i) => `${w.labels[i]}: ${fmt.short(v)} ср. охват`),
      };
    },
    empty: { title: 'Нет публикаций за период' },
  },
  'tg-weekday-views': {
    cardId: 'tg-page-weekday-views',
    back: BACK.audience,
    term: 'По дням недели',
    descriptor: 'Средние просмотры публикации по дню недели за выбранное окно',
    cardTitle: 'Средние просмотры по дням недели',
    about: {
      formula: 'Для каждого дня недели — СРЕДНИЕ просмотры публикации этого дня за окно (не сумма).',
      source: 'Публикации канала (архив Telegram) за выбранное окно.',
    },
    source: 'posts',
    periodControl: true,
    comparison: 'Среднее по дням недели за окно — распределение, а не метрика периода; сравнение с прошлым периодом не рассчитывается.',
    derive: (ctx) => {
      const w = deriveWeekday(ctx.full, ctx.period.inRange);
      return {
        values: w.wdAvgValues,
        labels: WD_LABELS,
        titles: w.wdAvgValues.map((v, i) => `${WD_LABELS[i]}: ${fmt.num(v)} ср. просмотров`),
      };
    },
    footer: (ctx) => {
      const { bestWdLabel } = deriveWeekday(ctx.full, ctx.period.inRange);
      if (!bestWdLabel) return null;
      return (
        <div className="mt-3 text-xs font-medium text-muted-foreground">
          лучший день: <strong className="text-foreground">{bestWdLabel}</strong>
        </div>
      );
    },
    empty: { title: 'Нет публикаций за период' },
  },
  'tg-post-count': {
    cardId: 'tg-page-post-count',
    back: BACK.audience,
    term: 'Количество постов',
    descriptor: 'Сколько публикаций выходит по дням недели за выбранное окно',
    cardTitle: 'Публикации по дням недели',
    about: {
      formula: 'Число публикаций окна по дню недели.',
      source: 'Публикации канала (архив Telegram) за выбранное окно.',
    },
    source: 'posts',
    periodControl: true,
    comparison: 'Распределение публикаций по дням недели за окно — не метрика периода; сравнение с прошлым периодом не рассчитывается.',
    derive: (ctx) => {
      const w = deriveWeekday(ctx.full, ctx.period.inRange);
      return {
        values: w.wdCountValues,
        labels: WD_LABELS,
        titles: w.wdCountValues.map((v, i) => `${WD_LABELS[i]}: ${fmt.num(v)} постов`),
      };
    },
    empty: { title: 'Нет публикаций за период' },
  },
  'tg-hours': {
    cardId: 'tg-page-hours',
    back: BACK.audience,
    term: 'Активность по часам',
    descriptor: 'Суточный профиль активности аудитории канала',
    cardTitle: 'Активность по часам суток',
    about: {
      formula: 'Распределение активности по часу суток из статистики канала.',
      included: 'Разрез статистики канала за доступное окно Telegram — не сужается локальным окном страницы.',
      source: 'Статистика канала (Telegram graphs, top_hours).',
    },
    source: 'graphs',
    periodControl: false,
    comparison: GRAPHS_COMPARISON,
    derive: (ctx) => {
      const th = tgTopHours(ctx.graphs);
      if (!th) return { values: [], labels: [], titles: [] };
      return {
        values: th.values,
        labels: th.hours.map(String),
        titles: th.values.map((v, i) => `${th.hours[i] ?? i}:00 — ${fmt.num(v)}`),
      };
    },
    footer: (ctx) => {
      const th = tgTopHours(ctx.graphs);
      if (!th) return null;
      return <div className="mt-3 text-xs font-medium text-muted-foreground">пик активности ~ {th.peakHour}:00</div>;
    },
    empty: { title: 'Нет данных по часам' },
  },
};
