import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartSection as RailSection } from '@/components/instagram/shared';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SegSelect } from '@/panels/MetricPage';
import { PeriodChips } from '@/components/PeriodChips';
import { PillSelect } from '@/components/PillSelect';
import { SourceIdentity } from '@/components/SourceIdentity';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { PinnedDayPanel } from '@/components/PinnedDayPanel';
import { TableSkeleton, ChartSkeleton } from '@/components/ui/dataSkeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { lttbDownsample } from '@/lib/downsample';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { usePeriod, type DateRange, type PeriodDays } from '@/lib/period';
import { useMsResolvedPeriod, type MsPeriod } from '@/lib/msPeriod';
import {
  useYmSummary,
  useYmSources,
  useYmReferrers,
  useYmSocial,
  useYmMessengers,
  useYmDevices,
  useYmCountries,
  useYmCities,
  useYmAge,
  useYmGender,
  useYmGoals,
  useYmUtm,
  useYmPages,
  useYmLandings,
  useYmHourly,
  useYmExits,
} from '@/api/queries';
import {
  YmBreakdownRows,
  YM_DEVICE_LABELS,
  YM_AGE_LABELS,
  YM_GENDER_LABELS,
  demographicsFootnote,
  breakdownNote,
  goalNote,
  joinNote,
} from '@/panels/metrika/YmOverview';
import { isYmMetricKey } from '@/panels/metrika/ymMetricKeys';

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
    case 'ym-sources':
      return <YmSourcesPage />;
    case 'ym-referrers':
      return <YmReferrersPage />;
    case 'ym-social':
      return <YmSocialPage />;
    case 'ym-messengers':
      return <YmMessengersPage />;
    case 'ym-devices':
      return <YmDevicesPage />;
    case 'ym-countries':
      return <YmCountriesPage />;
    case 'ym-cities':
      return <YmCitiesPage />;
    case 'ym-age':
      return <YmAgePage />;
    case 'ym-gender':
      return <YmGenderPage />;
    case 'ym-goals':
      return <YmGoalsPage />;
    case 'ym-utm':
      return <YmUtmPage />;
    case 'ym-pages':
      return <YmPagesPage />;
    case 'ym-landings':
      return <YmLandingsPage />;
    case 'ym-exits':
      return <YmExitsPage />;
    default:
      return null;
  }
}

/** Re-export guard so the route dispatcher can gate `ym-*` keys without importing the page eagerly. */
export { isYmMetricKey };

// ── Shared shell ─────────────────────────────────────────────────────────────────────────────

const BACK = { to: '/metrika', label: 'Метрика · Обзор' };

interface AboutDef {
  formula: string;
  included?: string;
  source: string;
}

/** Тихая шапка + две колонки (главный блок + rail «Сравнение»/«О метрике»), как у `/metrics/ig-reach`. */
function YmMetricShell({
  term,
  descriptor,
  about,
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
      <Link
        to={BACK.to}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> {BACK.label}
      </Link>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="ym" className="mt-1 max-w-full" />
        {descriptor && <div className="mt-1.5 text-xs text-muted-foreground">{descriptor}</div>}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="space-y-6">
          <RailSection title="Сравнение">
            {comparison ?? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Для этого отчёта нет одной канонической метрики периода — сравнение не рассчитывается.
              </p>
            )}
          </RailSection>
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={about.formula} />
              {about.included && <AboutRow label="Что учитывается" text={about.included} />}
              <AboutRow label="Источник" text={about.source} />
            </dl>
          </RailSection>
          <Link
            to={BACK.to}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть Метрику <span aria-hidden="true">→</span>
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
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
      <span className="text-xs font-medium text-muted-foreground">Окно</span>
      <PeriodChips
        ariaLabel="Окно"
        value={window.days}
        onChange={window.setDays}
        range={window.range}
        onRangeChange={window.setRange}
      />
      {extra}
    </div>
  );
}

/** Rail-текст сравнения для отчётов без канонической метрики периода (breakdown/hourly). */
function NoComparison({ text }: { text: string }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>;
}

// ── Goal attribution selector (источники/устройства/UTM/страницы входа) ───────────────────────

/** Одна выбранная цель атрибуции на страницу: селектор появляется ТОЛЬКО когда на счётчике есть
    цели (как в Обзоре). id хранится строкой (контракт PillSelect); '' = «Без цели» (топ-цель НЕ
    подставляется автоматически). Валидируем производно: id обязан существовать в текущем словаре. */
function useYmGoalSelector(period: MsPeriod) {
  const goals = useYmGoals(period);
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
              {compareDelta != null && (
                <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
                  <span className="text-xs text-muted-foreground">Изменение</span>
                  <span className={`text-xs font-medium tabular-nums ${compareDelta >= 0 ? 'text-verdant' : 'text-ember'}`}>
                    {compareDelta >= 0 ? '▲' : '▼'}
                    {Math.abs(compareDelta).toFixed(1)}%
                  </span>
                </div>
              )}
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

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
        <span className="text-xs font-medium text-muted-foreground">Окно</span>
        <span className="flex-1" />
        <SegmentedControl
          ariaLabel="Окно"
          value={String(days)}
          onChange={(d) => setDays(Number(d) as PeriodDays)}
          options={WINDOW_PILLS.map((chip) => ({ value: String(chip.days), content: chip.label }))}
        />
      </div>

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

// ── Breakdown / list report shell ─────────────────────────────────────────────────────────────

/** Каркас отчётной карточки: полноэкранная карточка с ПОЛНЫМ (развёрнутым) списком отчёта. */
function YmReportCard({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <ChartWidget id={id} title={title} defaultSize="full" noExpand action={action}>
      <ChartExpandedContext.Provider value={true}>{children}</ChartExpandedContext.Provider>
    </ChartWidget>
  );
}

interface BreakdownRow {
  key: string;
  label: string;
  value: number;
  note: string | null;
}

/** Тело breakdown-отчёта: pending/error/empty + полный список строк (ChartExpandedContext=true в
    YmReportCard раскрывает YmBreakdownRows на все строки). */
function YmReportBody<T>({
  state,
  errorTitle,
  empty,
  build,
}: {
  state: { isPending: boolean; isError: boolean; isFetching: boolean; error: unknown; data: T | undefined; refetch: () => void };
  errorTitle: string;
  empty: ReactNode;
  build: (data: T) => {
    rows: BreakdownRow[];
    tailWord: string;
    unitTotal?: number | null;
    footnote?: string | null;
  } | null;
}) {
  if (state.isPending) return <TableSkeleton rows={6} columns={2} className="py-2" />;
  if (state.isError) {
    return (
      <ErrorState
        compact
        size="table"
        className="py-4"
        title={errorTitle}
        reason={state.error instanceof Error ? state.error.message : 'ошибка'}
        onRetry={() => state.refetch()}
        retrying={state.isFetching}
      />
    );
  }
  const built = state.data ? build(state.data) : null;
  if (!built || built.rows.length === 0) return <>{empty}</>;
  return (
    <YmBreakdownRows
      rows={built.rows}
      tailWord={built.tailWord}
      unitTotal={built.unitTotal ?? null}
      footnote={built.footnote ?? null}
    />
  );
}

const LIST_COMPARISON = 'Это разрез структуры за окно, а не одна метрика периода — сравнение периодов не рассчитывается. Меняйте окно, чтобы пересобрать список.';

// ── Breakdown pages ────────────────────────────────────────────────────────────────────────────

function YmSourcesPage() {
  const window = useYmMetricWindow();
  const goal = useYmGoalSelector(window.period);
  const q = useYmSources(window.period, goal.selectedGoalId);
  return (
    <YmMetricShell
      term="Источники трафика"
      descriptor="Откуда пришли визиты за выбранное окно"
      about={{
        formula: 'Группировка визитов по источнику трафика (поиск/прямые/соцсети/реклама/…). Строка — визиты и посетители источника.',
        included: 'С выбранной целью строки дополняются достижениями и конверсией (CR) этой цели.',
        source: 'Отчёт визитов Метрики (ym:s:<trafficSource>).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-sources" title="Все источники" action={goal.control('Цель для источников трафика')}>
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить источники трафика"
          empty={<EmptyState compact size="table" title="Нет визитов за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? 'Другие источники',
              value: r.visits,
              note: joinNote(`${fmt.num(r.users)} чел.`, goalNote(data.goal_id, r.goal_reaches, r.goal_conversion)),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmReferrersPage() {
  const window = useYmMetricWindow();
  const q = useYmReferrers(window.period);
  return (
    <YmMetricShell
      term="Реферальные сайты"
      descriptor="Внешние домены, приводящие трафик по ссылкам"
      about={{
        formula: 'Группировка визитов по внешнему домену-источнику перехода. Строка — визиты и отказы домена.',
        source: 'Отчёт визитов Метрики (ym:s:externalRefererDomain).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-referrers" title="Все домены">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить реферальные сайты"
          empty={
            <EmptyState
              compact
              size="table"
              title="Реферальных переходов за период нет."
              reason="Здесь появятся внешние сайты, приводящие трафик по ссылкам."
            />
          }
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.name ?? r.id ?? 'unknown',
              label: r.name ?? r.id ?? 'домен',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmSocialPage() {
  const window = useYmMetricWindow();
  const q = useYmSocial(window.period);
  return (
    <YmMetricShell
      term="Соцсети"
      descriptor="Конкретные соцсети, приводящие трафик"
      about={{
        formula: 'Группировка визитов из соцсетей по конкретной сети. Строка — визиты и отказы сети.',
        source: 'Отчёт визитов Метрики (ym:s:lastsignSocialNetwork).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-social" title="Все соцсети">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить соцсети"
          empty={
            <EmptyState
              compact
              size="table"
              title="Переходов из соцсетей за период нет."
              reason="Здесь появятся конкретные соцсети, приводящие трафик."
            />
          }
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'соцсеть',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmMessengersPage() {
  const window = useYmMetricWindow();
  const q = useYmMessengers(window.period);
  return (
    <YmMetricShell
      term="Мессенджеры"
      descriptor="Telegram и другие мессенджеры — отдельная размерность, не внутри «Соцсетей»"
      about={{
        formula: 'Группировка визитов из мессенджеров по конкретному мессенджеру. Строка — визиты и отказы.',
        source: 'Отчёт визитов Метрики (ym:s:<messenger>).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-messengers" title="Все мессенджеры">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить мессенджеры"
          empty={
            <EmptyState
              compact
              size="table"
              title="Переходов из мессенджеров за период нет."
              reason="Здесь появятся Telegram и другие мессенджеры, приводящие трафик."
            />
          }
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'мессенджер',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmDevicesPage() {
  const window = useYmMetricWindow();
  const goal = useYmGoalSelector(window.period);
  const q = useYmDevices(window.period, goal.selectedGoalId);
  return (
    <YmMetricShell
      term="Устройства"
      descriptor="Типы устройств посетителей за выбранное окно"
      about={{
        formula: 'Группировка визитов по типу устройства (десктоп/смартфон/планшет/ТВ). Строка — визиты и отказы.',
        included: 'Тип локализуется по стабильному id категории; с выбранной целью строки дополняются достижениями и CR.',
        source: 'Отчёт визитов Метрики (ym:s:deviceCategory).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-devices" title="Все устройства" action={goal.control('Цель для устройств')}>
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить устройства"
          empty={<EmptyState compact size="table" title="Нет визитов за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: (r.id != null ? YM_DEVICE_LABELS[r.id] : undefined) ?? r.name ?? 'Другие устройства',
              value: r.visits,
              note: joinNote(breakdownNote(r.users, r.bounce_rate), goalNote(data.goal_id, r.goal_reaches, r.goal_conversion)),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmCountriesPage() {
  const window = useYmMetricWindow();
  const q = useYmCountries(window.period);
  return (
    <YmMetricShell
      term="Страны"
      descriptor="География посетителей по странам за выбранное окно"
      about={{
        formula: 'Группировка визитов по стране визита. Строка — визиты и отказы страны.',
        included: 'География определяется Метрикой по данным визита, а не по GPS.',
        source: 'Отчёт визитов Метрики (ym:s:regionCountry, lang=ru).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-countries" title="Все страны">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить страны"
          empty={<EmptyState compact size="table" title="Нет визитов за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'страна',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
            footnote: 'География определяется Метрикой по данным визита, а не по GPS.',
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmCitiesPage() {
  const window = useYmMetricWindow();
  const q = useYmCities(window.period);
  return (
    <YmMetricShell
      term="Города"
      descriptor="География посетителей по городам за выбранное окно"
      about={{
        formula: 'Группировка визитов по городу визита — отдельная от страны размерность. Строка — визиты и отказы.',
        included: 'География определяется Метрикой по данным визита, а не по GPS.',
        source: 'Отчёт визитов Метрики (ym:s:regionCity, lang=ru).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-cities" title="Все города">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить города"
          empty={<EmptyState compact size="table" title="Нет визитов за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'город',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmAgePage() {
  const window = useYmMetricWindow();
  const q = useYmAge(window.period);
  return (
    <YmMetricShell
      term="Возраст"
      descriptor="Возрастные группы посетителей — оценка Метрики (Crypta)"
      about={{
        formula: 'Группировка визитов по возрастной группе посетителя. Строка — визиты и отказы группы.',
        included: 'Значения — оценка Метрики по поведению аудитории, не анкета; при малой выборке часть данных скрыта.',
        source: 'Отчёт визитов Метрики (ym:s:ageInterval).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-age" title="Все возрастные группы">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить возраст"
          empty={
            <div>
              <EmptyState compact size="table" title="Демографические данные недоступны за период." />
              {q.data && <p className="text-2xs text-muted-foreground">{demographicsFootnote(q.data)}</p>}
            </div>
          }
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: (r.id != null ? YM_AGE_LABELS[r.id] : undefined) ?? r.name ?? 'возраст неизвестен',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
            footnote: demographicsFootnote(data),
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmGenderPage() {
  const window = useYmMetricWindow();
  const q = useYmGender(window.period);
  return (
    <YmMetricShell
      term="Пол"
      descriptor="Пол посетителей — оценка Метрики (Crypta)"
      about={{
        formula: 'Группировка визитов по полу посетителя. Строка — визиты и отказы группы.',
        included: 'Значения — оценка Метрики по поведению аудитории, не анкета; при малой выборке часть данных скрыта.',
        source: 'Отчёт визитов Метрики (ym:s:gender).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-gender" title="По полу">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить пол"
          empty={
            <div>
              <EmptyState compact size="table" title="Демографические данные недоступны за период." />
              {q.data && <p className="text-2xs text-muted-foreground">{demographicsFootnote(q.data)}</p>}
            </div>
          }
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: (r.id != null ? YM_GENDER_LABELS[r.id] : undefined) ?? r.name ?? 'не определён',
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
            footnote: demographicsFootnote(data),
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmGoalsPage() {
  const window = useYmMetricWindow();
  const q = useYmGoals(window.period);
  return (
    <YmMetricShell
      term="Цели"
      descriptor="Достижения целей и конверсия за выбранное окно"
      about={{
        formula: 'Достижения (reaches) каждой цели за окно; конверсия (CR) — отдельная метрика Метрики, из reaches не выводится.',
        source: 'Отчёт целей Метрики (goal reaches + conversionRate).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-goals" title="Все цели">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить цели"
          empty={
            <EmptyState
              compact
              size="table"
              title="На счётчике нет целей."
              reason="Настройте цели в Яндекс.Метрике — конверсии появятся здесь."
            />
          }
          build={(data) => ({
            rows: data.rows.map((g) => ({
              key: g.id,
              label: g.name ?? `Цель ${g.id}`,
              value: g.reaches,
              note: `CR ${g.conversion_rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`,
            })),
            tailWord: 'достижений',
            footnote: data.truncated ? 'Показаны первые 20 целей счётчика.' : null,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmUtmPage() {
  const window = useYmMetricWindow();
  const goal = useYmGoalSelector(window.period);
  const q = useYmUtm(window.period, goal.selectedGoalId);
  return (
    <YmMetricShell
      term="UTM-метки"
      descriptor="Размеченные визиты по utm_source за выбранное окно"
      about={{
        formula: 'Группировка размеченных визитов по utm_source. Неразмеченные визиты — честной сноской, не строкой.',
        included: 'С выбранной целью строки дополняются достижениями и конверсией (CR) этой цели.',
        source: 'Отчёт визитов Метрики (ym:s:<UTMSource>).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-utm" title="Все UTM-источники" action={goal.control('Цель для UTM-меток')}>
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить UTM-разметку"
          empty={
            <EmptyState
              compact
              size="table"
              title="UTM-меток за период нет."
              reason="Размечайте ссылки в постах utm_source — источники появятся здесь."
            />
          }
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.id ?? r.name ?? 'unknown',
              label: r.name ?? r.id ?? 'utm',
              value: r.visits,
              note: joinNote(`${fmt.num(r.users)} чел.`, goalNote(data.goal_id, r.goal_reaches, r.goal_conversion)),
            })),
            tailWord: 'визитов',
            unitTotal: data.tagged_visits,
            footnote:
              data.untagged_visits > 0
                ? `Без метки — ${fmt.num(data.untagged_visits)} визитов из ${fmt.num(data.visits_total)}.`
                : null,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmPagesPage() {
  const window = useYmMetricWindow();
  const q = useYmPages(window.period);
  return (
    <YmMetricShell
      term="Топ-страницы"
      descriptor="Самые просматриваемые страницы за выбранное окно"
      about={{
        formula: 'Группировка ПРОСМОТРОВ страниц по пути. Просмотры — hits-метрика, не визиты (другая единица).',
        source: 'Отчёт просмотров Метрики (ym:pv:URLPath).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-pages" title="Все страницы">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить страницы"
          empty={<EmptyState compact size="table" title="Нет просмотров за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.path,
              label: r.path,
              value: r.pageviews,
              note: `${fmt.num(r.users)} чел.`,
            })),
            tailWord: 'просмотров',
            unitTotal: data.pageviews_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmLandingsPage() {
  const window = useYmMetricWindow();
  const goal = useYmGoalSelector(window.period);
  const q = useYmLandings(window.period, goal.selectedGoalId, 100);
  return (
    <YmMetricShell
      term="Страницы входа"
      descriptor="Где визиты начинаются за выбранное окно"
      about={{
        formula: 'Группировка визитов по странице ВХОДА (startURLPath). Строка — визиты и отказы страницы.',
        included: 'С выбранной целью строки дополняются достижениями и конверсией (CR) этой цели.',
        source: 'Отчёт визитов Метрики (ym:s:startURLPath).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-landings" title="Все страницы входа" action={goal.control('Цель для страниц входа')}>
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить страницы входа"
          empty={<EmptyState compact size="table" title="Нет визитов по страницам входа за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.path,
              label: r.path,
              value: r.visits,
              note: joinNote(
                r.bounce_rate != null ? `${r.bounce_rate.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}% отказов` : null,
                goalNote(data.goal_id, r.goal_reaches, r.goal_conversion),
              ),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}

function YmExitsPage() {
  const window = useYmMetricWindow();
  const q = useYmExits(window.period, 100);
  return (
    <YmMetricShell
      term="Страницы выхода"
      descriptor="Где визиты заканчиваются за выбранное окно"
      about={{
        formula: 'Группировка визитов по странице ВЫХОДА (endURLPath) — зеркало входов. Строка — визиты и отказы.',
        source: 'Отчёт визитов Метрики (ym:s:endURLPath).',
      }}
      comparison={<NoComparison text={LIST_COMPARISON} />}
    >
      <YmReportCard id="ym-page-exits" title="Все страницы выхода">
        <YmReportBody
          state={q}
          errorTitle="Не удалось получить страницы выхода"
          empty={<EmptyState compact size="table" title="Нет визитов по страницам выхода за период." />}
          build={(data) => ({
            rows: data.rows.map((r) => ({
              key: r.path,
              label: r.path,
              value: r.visits,
              note: breakdownNote(r.users, r.bounce_rate),
            })),
            tailWord: 'визитов',
            unitTotal: data.visits_total,
          })}
        />
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
              <span className="text-3xl font-medium leading-none tabular-nums tracking-tight">{fmt.short(q.data.visits_total)}</span>
              <span className="text-xs tracking-wide text-muted-foreground">визитов{peakLabel ? ` · ${peakLabel}` : ''}</span>
            </div>
            <div className="grid grid-cols-8 gap-x-2 gap-y-3 sm:grid-cols-12">
              {q.data.rows.map((row) => {
                const opacity = maxVisits > 0 ? Math.max(0.1, row.visits / maxVisits) : 0.08;
                const title = `${padHour(row.hour)}:00 — ${fmt.num(row.visits)} визитов, ${fmt.num(row.users)} посетителей`;
                return (
                  <div key={row.hour} role="img" aria-label={title} title={title} className="min-w-0 text-center">
                    <div className="h-10 rounded-sm" style={{ backgroundColor: 'hsl(var(--brand-iris))', opacity }} />
                    <span className="mt-1 block text-2xs tabular-nums text-muted-foreground">{padHour(row.hour)}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-2xs text-muted-foreground">Часы — в часовом поясе счётчика.</p>
          </div>
        )}
      </YmReportCard>
      <YmControlBar window={window} />
    </YmMetricShell>
  );
}
