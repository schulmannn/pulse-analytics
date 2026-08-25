import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';

import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SegSelect } from '@/components/metric/SegSelect';
import { PeriodChips } from '@/components/PeriodChips';
import { PillSelect } from '@/components/PillSelect';
import { SourceIdentity } from '@/components/SourceIdentity';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { PinnedDayPanel } from '@/components/PinnedDayPanel';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { ChartTooltip, useHeatmapTip } from '@/components/ChartTooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { lttbDownsample } from '@/lib/downsample';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { usePeriod, type DateRange, type PeriodDays } from '@/lib/period';
import { useMsResolvedPeriod, type MsPeriod } from '@/lib/msPeriod';
import { useYmGoals, useYmHourly, useYmSummary } from '@/api/queries';
import {
  YM_BREAKDOWN_BY_KEY,
  type AboutDef,
  type YmBreakdownDef,
} from '@/panels/metrika/ymBreakdowns';
import { isYmMetricKey } from '@/panels/metrika/ymMetricKeys';
import { ComparisonDeltaRow, MetricBackLink, MetricColumns, MetricDescriptor, WindowBarShell, RailSection } from '@/components/metric/shared';

/**
 * Полностраничные метрики «Яндекс.Метрики» — `/metrics/ym-*`. Каждая карточка Обзора /metrika ведёт
 * СЮДА (`drillTo`), а не в модальный `?detail=` оверлей: та же информационная архитектура и грамматика,
 * что у эталона Instagram `/metrics/ig-reach` и МойСклад `/metrics/ms-*` — назад-ссылка, тихая шапка
 * (имя метрики + источник + дескриптор), две колонки (главный блок + rail «Сравнение»/«О метрике»),
 * контролы графика и тайм-бар окна под ним.
 *
 * ЧЕСТНОСТЬ важнее паритета: только три метрики (визиты/посетители/просмотры) — настоящие дневные
 * ряды и получают Line/Bar + сравнение off/prev/year из полного архива ym_daily с гейтом полного
 * покрытия (никакого выдуманного baseline). Ритм по часам — своя heatmap без Line/Bar/сравнения.
 * Остальные 14 — breakdown/список: полный список без выдуманного графика; атрибуция цели сохранена
 * для источников/устройств/UTM/страниц входа.
 */
export function YmMetricPage({ metricKey }: { metricKey: string }) {
  if (!isYmMetricKey(metricKey)) return null;
  switch (metricKey) {
    case 'ym-visits':
      return <YmSeriesPage def={SERIES_DEFS['ym-visits']} />;
    case 'ym-users':
      return <YmSeriesPage def={SERIES_DEFS['ym-users']} />;
    case 'ym-pageviews':
      return <YmSeriesPage def={SERIES_DEFS['ym-pageviews']} />;
    case 'ym-hourly':
      return <YmHourlyPage />;
    default: {
      // Остальные 14 — breakdown/список из ОБЩЕЙ таблицы разрезов: та же дефиниция, что кормит
      // карточку Обзора, поэтому тексты пустых состояний и сноски здесь и там совпадают по строению.
      const def = YM_BREAKDOWN_BY_KEY[metricKey];
      return def ? <YmBreakdownPage def={def} /> : null;
    }
  }
}

/** Re-export guard so the route dispatcher can gate `ym-*` keys without importing the page eagerly. */
export { isYmMetricKey };

// ── Shared shell ─────────────────────────────────────────────────────────────────────────────

const BACK = { to: '/metrika', label: 'Метрика · Обзор' };

/** Тихая шапка + две колонки (главный блок + rail «Сравнение»/«О метрике»), как у `/metrics/ig-reach`. */
function YmMetricShell({
  term,
  descriptor,
  comparison,
  children,
}: {
  term: string;
  descriptor?: string;
  about: AboutDef;
  comparison?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <MetricBackLink to={BACK.to}>{BACK.label}</MetricBackLink>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="ym" className="mt-1 max-w-full" />
        {descriptor && <MetricDescriptor>{descriptor}</MetricDescriptor>}
      </div>

      <MetricColumns
        rail={
          <>
            <RailSection title="Сравнение">
              {comparison ?? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Для этого отчёта нет одной канонической метрики периода — сравнение не рассчитывается.
                </p>
              )}
            </RailSection>
            {/* «О метрике» убран — техническая информация не для конечного пользователя (владелец). */}
            <Link
              to={BACK.to}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            >
              Открыть Метрику <span aria-hidden="true">→</span>
            </Link>
          </>
        }
      >
        {children}
      </MetricColumns>
    </div>
  );
}

// ── Window controls ──────────────────────────────────────────────────────────────────────────

interface YmMetricWindow {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
  range: DateRange | null;
  setRange: (range: DateRange | null) => void;
  period: MsPeriod;
}

/** Живое окно Метрики из глобального explorer-периода (тот, что drillTo засеял из фид-топбара).
    Тот же оконный контракт 7/30/90/диапазон/«Всё», что у сервера (msPeriod). */
function useYmMetricWindow(): YmMetricWindow {
  const { days, setDays, range, setRange } = usePeriod();
  const period = useMsResolvedPeriod({ days, range });
  return { days, setDays, range, setRange, period };
}

/** Пресеты окна одной строкой под графиком/отчётом (тайм-бар принадлежит контенту, а не краю экрана). */
function YmControlBar({ window, extra }: { window: YmMetricWindow; extra?: ReactNode }) {
  return (
    <WindowBarShell>
      <PeriodChips
        ariaLabel="Окно"
        value={window.days}
        onChange={window.setDays}
        range={window.range}
        onRangeChange={window.setRange}
      />
      {extra}
    </WindowBarShell>
  );
}

/** Rail-текст сравнения для отчётов без канонической метрики периода (breakdown/hourly). */
function NoComparison({ text }: { text: string }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>;
}

// ── Goal attribution selector (источники/устройства/UTM/страницы входа) ───────────────────────

/** Одна выбранная цель атрибуции на страницу: селектор появляется ТОЛЬКО когда на счётчике есть
    цели (как в Обзоре). id хранится строкой (контракт PillSelect); '' = «Без цели» (топ-цель НЕ
    подставляется автоматически). Валидируем производно: id обязан существовать в текущем словаре.
    `enabled=false` (у разреза нет атрибуции) держит словарь целей незагруженным — лишнего запроса
    на страницах без селектора не появляется. */
function useYmGoalSelector(period: MsPeriod, enabled = true) {
  const goals = useYmGoals(period, { enabled });
  const [value, setValue] = useState('');
  const rows = goals.data?.rows ?? [];
  const hasGoals = rows.length > 0;
  const validValue = hasGoals && rows.some((g) => g.id === value) ? value : '';
  const selectedGoalId = validValue !== '' ? Number(validValue) : null;
  const options = [
    { value: '', label: 'Без цели' },
    ...rows.map((g) => ({ value: g.id, label: g.name ?? `Цель ${g.id}` })),
  ];
  const control = (ariaLabel: string): ReactNode =>
    hasGoals ? (
      <PillSelect
        value={validValue}
        onValueChange={setValue}
        ariaLabel={ariaLabel}
        className="h-7 w-32 shrink-0 text-2xs sm:w-40"
        options={options}
      />
    ) : undefined;
  return { selectedGoalId, control };
}

// ── Time-series pages (visits / users / pageviews) ─────────────────────────────────────────────

// Полный архив: сравнение off/prev/year обязано браться из ПОЛНОЙ дневной истории ym_daily, а не из
// живого окна, иначе baseline занижен и «рост» фальшивый. «Всё» (days:0) без from/to — сервер
// отдаёт весь архив, который мы режем локально пресетами окна.
const ALL_TIME: MsPeriod = { days: 0 };

const WINDOW_PILLS: { days: PeriodDays; label: string }[] = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

interface YmSeriesDef {
  block: 'visits' | 'users' | 'pageviews';
  term: string;
  /** Родительный для тултипов («… визитов»). */
  genitive: string;
  /** true — аддитивная метрика (сумма по дням = период). false — посетители: дневные уникальные
      не суммируются в истинный уникум, подпись честно говорит «сумма дневных уникальных». */
  additive: boolean;
  about: AboutDef;
}

const SERIES_DEFS: Record<'ym-visits' | 'ym-users' | 'ym-pageviews', YmSeriesDef> = {
  'ym-visits': {
    block: 'visits',
    term: 'Визиты',
    genitive: 'визитов',
    additive: true,
    about: {
      formula: 'Число визитов по дням; заголовок окна — сумма за выбранное окно.',
      included: 'Визиты аддитивны — сумма по дням равна периоду. Роботы «по поведению» учтены, а не исключены молча.',
      source: 'Дневные отчёты Reporting API Метрики (accuracy=full) + архив ym_daily.',
    },
  },
  'ym-users': {
    block: 'users',
    term: 'Посетители',
    genitive: 'посетителей',
    additive: false,
    about: {
      formula: 'Число посетителей по дням; заголовок окна — СУММА дневных уникальных за окно.',
      included:
        'Дневные уникальные не складываются в истинный уникум за период (одного человека в разные дни считаем повторно) — сумма выше периодного уникума. Обе цифры честные, но отвечают на разные вопросы.',
      source: 'Дневные отчёты Reporting API Метрики (accuracy=full) + архив ym_daily.',
    },
  },
  'ym-pageviews': {
    block: 'pageviews',
    term: 'Просмотры страниц',
    genitive: 'просмотров',
    additive: true,
    about: {
      formula: 'Число просмотров страниц по дням; заголовок окна — сумма за выбранное окно.',
      included: 'Просмотры аддитивны — сумма по дням равна периоду. Это hits-метрика, не визиты.',
      source: 'Дневные отчёты Reporting API Метрики (accuracy=full) + архив ym_daily.',
    },
  },
};

/** Same calendar date a year earlier; Feb 29 maps to Feb 28 (no leap counterpart). */
function shiftYearBack(day: string): string {
  const [y, m, d] = day.split('-');
  if (m === '02' && d === '29') return `${Number(y) - 1}-02-28`;
  return `${Number(y) - 1}-${m}-${d}`;
}

function YmSeriesPage({ def }: { def: YmSeriesDef }) {
  const chartH = useExplorerChartHeight();
  const summary = useYmSummary(ALL_TIME);
  const [days, setDays] = useState<PeriodDays>(30);
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [cmp, setCmp] = useState<'off' | 'prev' | 'year'>('prev');
  const [pinned, setPinned] = useState<number | null>(null);
  useEffect(() => {
    setPinned(null);
  }, [days, kind, cmp]);

  if (summary.isPending) {
    return (
      <YmMetricShell term={def.term} about={def.about}>
        <Skeleton className="h-[420px] w-full" />
      </YmMetricShell>
    );
  }
  if (summary.isError) {
    return (
      <YmMetricShell term={def.term} about={def.about}>
        <ErrorState
          title="Не удалось получить данные Яндекс.Метрики"
          reason={summary.error instanceof Error ? summary.error.message : 'ошибка'}
          onRetry={() => summary.refetch()}
          retrying={summary.isFetching}
        />
      </YmMetricShell>
    );
  }

  const seriesFull = summary.data[def.block].series.filter((p) => p.day !== 'total');
  const n = days === 0 ? seriesFull.length : Math.min(days, seriesFull.length);
  const winPoints = seriesFull.slice(-n);
  const winValues = winPoints.map((p) => p.value);

  // Baseline — только из полного архива и только когда он ПОЛНОСТЬЮ покрывает окно (иначе честно
  // деградируем без выдуманного baseline). «Пред. период» — равный срез прямо перед окном;
  // «Год назад» — те же календарные даты годом раньше (по дате, не индексу — в архиве возможны дыры).
  let ghostVals: number[] = [];
  if (cmp === 'prev' && days > 0 && seriesFull.length >= 2 * n) {
    ghostVals = seriesFull.slice(-(2 * n), -n).map((p) => p.value);
  } else if (cmp === 'year' && days > 0) {
    const byDay = new Map(seriesFull.map((p) => [p.day, p.value]));
    const shifted = winPoints.map((p) => byDay.get(shiftYearBack(p.day)));
    if (shifted.every((v): v is number => v != null)) ghostVals = shifted;
  }
  const ghostOk = cmp !== 'off' && days > 0 && n > 1 && ghostVals.length === n;
  const cmpLabel = cmp === 'year' ? 'Год назад' : 'Пред. период';

  // Длинный архив («Всё») даунсэмплим до ~140 точек перед рендером (канон графиков); окна 7/30/90
  // короче порога и рисуются как есть, поэтому ghost выравнивается с ними по индексу.
  const rendered = days === 0 ? lttbDownsample(winPoints, 140, (p) => p.value) : winPoints;
  const values = rendered.map((p) => p.value);
  const labels = rendered.map((p) => fmt.day(p.day));
  const axisLabels = timeAxisFromDayKeys(rendered.map((p) => p.day));
  const titles = rendered.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.value)} ${def.genitive}`);
  const m = values.length;

  const sumCur = winValues.reduce((s, v) => s + v, 0);
  const sumPrev = ghostOk ? ghostVals.reduce((s, v) => s + v, 0) : null;
  const compareDelta = sumPrev != null && sumPrev > 0 ? ((sumCur - sumPrev) / sumPrev) * 100 : null;
  const sumCaption = def.additive ? 'сумма по дням за окно' : 'сумма дневных уникальных за окно';

  const pinnedValid = pinned != null && pinned >= 0 && pinned < m ? pinned : null;
  const pinnedDiff = pinnedValid != null && pinnedValid > 0 ? values[pinnedValid] - values[pinnedValid - 1] : null;

  const stats =
    winValues.length > 0
      ? [
          { label: 'Мин', value: fmt.kpi(Math.min(...winValues)) },
          { label: 'Макс', value: fmt.kpi(Math.max(...winValues)) },
          { label: 'Среднее', value: fmt.kpi(sumCur / winValues.length) },
          { label: 'Сумма', value: fmt.kpi(sumCur) },
        ]
      : [];

  return (
    <YmMetricShell
      term={def.term}
      descriptor={`Веб-аналитика сайта за выбранное окно · ${sumCaption}`}
      about={def.about}
      comparison={
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Текущее окно</span>
            <span className="text-base font-medium tabular-nums text-foreground">{fmt.kpi(sumCur)}</span>
          </div>
          <SegSelect
            ariaLabel="База сравнения"
            value={cmp}
            onChange={setCmp}
            options={[
              { value: 'off' as const, label: 'Выкл' },
              { value: 'prev' as const, label: 'Пред. период' },
              { value: 'year' as const, label: 'Год назад' },
            ]}
          />
          {cmp === 'off' ? (
            <p className="text-xs text-muted-foreground">Выберите базу — пунктир прошлого окна ляжет на график.</p>
          ) : days === 0 ? (
            <p className="text-xs text-muted-foreground">Для окна «Всё» прошлого периода не существует.</p>
          ) : ghostOk ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">{cmpLabel}</span>
                <span className="tabular-nums">{sumPrev != null ? fmt.kpi(sumPrev) : '—'}</span>
              </div>
              {compareDelta != null && <ComparisonDeltaRow delta={compareDelta} />}
            </div>
          ) : cmp === 'year' ? (
            <p className="text-xs text-muted-foreground">
              Архив ym_daily пока не достаёт до прошлого года — история копится, сравнение включится само.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              В архиве недостаточно истории за прошлый период — сравнивать не с чем.
            </p>
          )}
        </div>
      }
    >
      <ChartWidget
        id={`ym-page-${def.block}`}
        title="По дням"
        defaultSize="full"
        noExpand
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
        {m > 1 ? (
          <ChartExpandedContext.Provider value={true}>
            {kind === 'line' ? (
              <LineChart
                values={values}
                labels={labels}
                axisLabels={axisLabels}
                titles={titles}
                height={chartH}
                markExtremes
                markAnomalies
                showPoints={m <= 45}
                ghost={ghostOk ? ghostVals : undefined}
                ghostLabel={cmpLabel}
                legendToggle={false}
                yMin={0}
                onPointClick={(i) => setPinned((p) => (p === i ? null : i))}
                pinnedIndex={pinnedValid}
              />
            ) : (
              <BarChart
                values={values}
                labels={labels}
                axisLabels={axisLabels}
                titles={titles}
                height={chartH}
                ghost={ghostOk ? ghostVals : undefined}
                ghostLabel={cmpLabel}
                legendToggle={false}
                onPointClick={(i) => setPinned((p) => (p === i ? null : i))}
                pinnedIndex={pinnedValid}
              />
            )}
          </ChartExpandedContext.Provider>
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Недостаточно данных за окно.</div>
        )}
        {stats.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-4">
            {stats.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">{row.label}</span>
                <span className="text-sm font-medium tabular-nums">{row.value}</span>
              </div>
            ))}
          </div>
        )}
      </ChartWidget>

      <WindowBarShell>
        <span className="flex-1" />
        <SegmentedControl
          ariaLabel="Окно"
          value={String(days)}
          onChange={(d) => setDays(Number(d) as PeriodDays)}
          options={WINDOW_PILLS.map((chip) => ({ value: String(chip.days), content: chip.label }))}
        />
      </WindowBarShell>

      {pinnedValid != null && (
        <PinnedDayPanel
          dateLabel={labels[pinnedValid] ?? ''}
          rows={[
            { label: 'Значение', value: fmt.num(values[pinnedValid]) },
            ...(pinnedDiff != null
              ? [
                  {
                    label: 'К пред. точке',
                    value: (
                      <span className={pinnedDiff > 0 ? 'text-verdant' : pinnedDiff < 0 ? 'text-ember' : undefined}>
                        {pinnedDiff > 0 ? '+' : pinnedDiff < 0 ? '−' : ''}
                        {fmt.num(Math.abs(pinnedDiff))}
                      </span>
                    ),
                  },
                ]
              : []),
            ...(ghostOk && ghostVals[pinnedValid] != null ? [{ label: cmpLabel, value: fmt.num(ghostVals[pinnedValid]) }] : []),
          ]}
          showPosts={false}
          onClose={() => setPinned(null)}
        />
      )}
    </YmMetricShell>
  );
}

// ── Breakdown / list report page ──────────────────────────────────────────────────────────────

/** Каркас отчётной карточки: полноэкранная карточка с ПОЛНЫМ (развёрнутым) списком отчёта.
    Оба контекста обязательны и идут ПАРОЙ, как у всех пяти соседних вертикалей (MsReportCard /
    TgReportCard / IgReportCard / MentionsReportCard / CampaignReportCard): ChartExpandedContext
    раскрывает список на все строки, ExpandedChartHeightContext отдаёт графикам полную высоту
    explorer'а. Без второго карточка отдавала бы графикам fillHeight=null (у defaultSize="full"
    ChartSection не задаёт высоту), и любой график отчёта Метрики рисовался бы своей дефолтной
    высотой вместо explorer-высоты соседей. */
function YmReportCard({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  const chartH = useExplorerChartHeight();
  return (
    <ChartWidget id={id} title={title} defaultSize="full" noExpand action={action}>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartH}>{children}</ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </ChartWidget>
  );
}

const LIST_COMPARISON = 'Это разрез структуры за окно, а не одна метрика периода — сравнение периодов не рассчитывается. Меняйте окно, чтобы пересобрать список.';

/**
 * Полностраничный отчёт любого из 14 разрезов. Раньше здесь лежали 14 почти одинаковых функций
 * (~35 строк каждая), различавшихся только текстами; теперь всё, что их различало — заголовок,
 * дескриптор, «О метрике», тексты пустого/ошибочного состояния и сборка строк — живёт в ОДНОЙ
 * таблице `ymBreakdowns.tsx` вместе с карточкой Обзора.
 */
function YmBreakdownPage({ def }: { def: YmBreakdownDef }) {
  const window = useYmMetricWindow();
  // Словарь целей грузим ТОЛЬКО там, где у разреза действительно есть селектор атрибуции.
  const goal = useYmGoalSelector(window.period, def.goalAria != null);
  return (
    <YmMetricShell
      term={def.title}
      descriptor={def.descriptor}
      about={def.about}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard
        id={`ym-page-${def.key.replace(/^ym-/, '')}`}
        title={def.pageTitle}
        action={def.goalAria ? goal.control(def.goalAria) : undefined}
      >
        <def.Body period={window.period} goalId={goal.selectedGoalId} surface="page" />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

// ── Hourly rhythm page ─────────────────────────────────────────────────────────────────────────

/** Полноэкранный ритм по часам суток: сетка из 24 клеток (визиты по часу 0..23), насыщенность
    нормирована на максимум окна. Своя heatmap-форма — без выдуманного Line/Bar/сравнения. */
function YmHourlyPage() {
  const window = useYmMetricWindow();
  const q = useYmHourly(window.period);
  const padHour = (h: number): string => String(h).padStart(2, '0');
  const maxVisits = Math.max(0, ...(q.data?.rows ?? []).map((row) => row.visits));
  const { wrapRef, tip } = useHeatmapTip();
  const peakLabel = useMemo(
    () => (q.data?.peak_hour != null ? `Пик в ${padHour(q.data.peak_hour)}:00` : null),
    [q.data?.peak_hour],
  );
  return (
    <YmMetricShell
      term="Трафик по часам"
      descriptor="Суточный профиль визитов за выбранное окно"
      about={{
        formula: 'Распределение визитов по часу суток (0..23) — всегда 24 плотные клетки, насыщенность нормирована на максимум окна.',
        included: 'Часы — в часовом поясе счётчика. Визиты — своя единица, не TG-просмотры и не IG-охват.',
        source: 'Отчёт визитов Метрики (ym:s:hour).',
      }}
      comparison={
        <NoComparison text="Ритм по часам — форма распределения за окно, а не одна метрика периода; сравнение периодов не рассчитывается." />
      }
    >
      <YmReportCard id="ym-page-hourly" title="По часам суток">
        {q.isPending ? (
          <ChartSkeleton />
        ) : q.isError ? (
          <ErrorState
            compact
            size="chart"
            className="py-4"
            title="Не удалось получить ритм по часам"
            reason={q.error instanceof Error ? q.error.message : 'ошибка'}
            onRetry={() => q.refetch()}
            retrying={q.isFetching}
          />
        ) : q.data.visits_total === 0 ? (
          <EmptyState compact size="table" title="Нет визитов за период." />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <KpiValue size="compact" text={fmt.short(q.data.visits_total)} />
              <span className="text-xs tracking-wide text-muted-foreground">визитов{peakLabel ? ` · ${peakLabel}` : ''}</span>
            </div>
            {/* hover — канонный ChartTooltip через useHeatmapTip (нативный HTML title убран:
                нестилизуемый острый прямоугольник); aria-label ячеек несёт те же точные числа. */}
            <div ref={wrapRef} className="relative">
              <div className="grid grid-cols-8 gap-x-2 gap-y-3 sm:grid-cols-12">
                {q.data.rows.map((row) => {
                  // Ноль — реальное отсутствие (канон п.8, зеркало карточки Обзора): нейтральный
                  // трек вместо самой бледной ступени брендовой шкалы.
                  const zero = row.visits === 0;
                  const opacity = zero ? 1 : maxVisits > 0 ? Math.max(0.1, row.visits / maxVisits) : 0.08;
                  const title = `${padHour(row.hour)}:00 — ${fmt.num(row.visits)} визитов, ${fmt.num(row.users)} посетителей`;
                  return (
                    <div key={row.hour} role="img" aria-label={title} data-heatmap-tip={title} className="min-w-0 cursor-crosshair text-center">
                      <div
                        className="h-10 rounded-sm transition-opacity dur-base ease-house"
                        style={{
                          backgroundColor: zero ? 'hsl(var(--border) / 0.3)' : 'hsl(var(--brand-iris))',
                          opacity,
                        }}
                      />
                      <span className="mt-1 block text-2xs tabular-nums text-muted-foreground">{padHour(row.hour)}</span>
                    </div>
                  );
                })}
              </div>
              <ChartTooltip tip={tip} />
            </div>
            <p className="text-2xs text-muted-foreground">Часы — в часовом поясе счётчика.</p>
          </div>
        )}
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}
