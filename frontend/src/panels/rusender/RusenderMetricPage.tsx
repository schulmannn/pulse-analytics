import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { PeriodChips } from '@/components/PeriodChips';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SourceIdentity } from '@/components/SourceIdentity';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import {
  ComparisonDeltaRow,
  MetricColumns,
  MetricDescriptor,
  MetricPageHeader,
  RailSection,
  WindowBarShell,
} from '@/components/metric/shared';
import { useRusenderSummary, type RusenderPoint } from '@/api/rusender';
import { useGatedSurfaces } from '@/components/layout/nav';
import { useSelectedChannel } from '@/lib/channel-context';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { usePeriod } from '@/lib/period';
import { msPreviousPeriod, useMsResolvedPeriod } from '@/lib/msPeriod';
import { isRusenderMetricKey, type RusenderMetricKey } from '@/panels/rusender/rusenderMetricKeys';

/**
 * Полностраничные метрики Rusender — `/metrics/rusender-*`.
 *
 * Разворот карточки обязан открывать ТО ЖЕ, что у остальных источников: назад-ссылку, тихую шапку
 * (имя метрики + источник + дескриптор), две колонки (график + rail «Сравнение») и тайм-бар окна
 * под графиком — как `/metrics/ms-*`, `/metrics/ym-*` и `/metrics/cdek-*`. Пока у карточек
 * Rusender не было `drillTo`, «Развернуть» падал в инлайновый оверлей, и источник вёл себя не как
 * соседние — ровно та же жалоба, что раньше была на СДЭК.
 *
 * СЮДА ПОПАДАЮТ ТОЛЬКО НАСТОЯЩИЕ ДНЕВНЫЕ РЯДЫ. «Рассылок периода» в семье нет: их итоги
 * кумулятивные и по дням не раскладываются, полноэкранный график там пришлось бы выдумать.
 */

/** Что за величина: как достать её из дневной точки и как подписать. */
const DEFS: Record<RusenderMetricKey, {
  term: string;
  descriptor: string;
  pick: (p: RusenderPoint) => number | null;
  /** Складывается ли по дням. События — да; снимок базы — нет, это уровень. */
  additive: boolean;
  viz: 'line' | 'bar';
}> = {
  'rusender-opens': {
    term: 'Открытия',
    descriptor:
      'События окна: день, когда письмо открыли. Rusender ведёт дневной ряд 11 дней от отправки, '
      + 'поэтому более поздние открытия видны только в итогах рассылки.',
    pick: (p) => p.opens,
    additive: true,
    viz: 'bar',
  },
  'rusender-clicks': {
    term: 'Клики',
    descriptor: 'События окна, как и открытия: день, когда по ссылке кликнули.',
    pick: (p) => p.clicks,
    additive: true,
    viz: 'bar',
  },
  'rusender-contacts': {
    term: 'Размер базы',
    descriptor:
      'Дневной снимок базы. Истории у Rusender API нет — она копится с момента подключения, '
      + 'и день без снимка показан разрывом, а не нулём.',
    pick: (p) => p.contacts_total,
    additive: false,
    viz: 'line',
  },
  'rusender-unsubscribed': {
    term: 'Отписавшиеся',
    descriptor: 'Накопленное число отписавшихся в базе на день снимка — это уровень, а не события дня.',
    pick: (p) => p.contacts_unsubscribed,
    additive: false,
    viz: 'line',
  },
};

const BACK = { to: '/rusender', label: 'Rusender · Обзор' };

/** Тихая шапка + две колонки, как у `/metrics/ym-*`. */
function RusenderMetricShell({
  term,
  descriptor,
  comparison,
  children,
}: {
  term: string;
  descriptor?: string;
  comparison?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <MetricPageHeader back={BACK} />
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="rusender" className="mt-1 max-w-full" />
        {descriptor && <MetricDescriptor>{descriptor}</MetricDescriptor>}
      </div>
      <MetricColumns
        rail={
          <>
            <RailSection title="Сравнение">{comparison}</RailSection>
            <Link
              to={BACK.to}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover-fine:text-primary/80"
            >
              Открыть Rusender <span aria-hidden="true">→</span>
            </Link>
          </>
        }
      >
        {children}
      </MetricColumns>
    </div>
  );
}

export { isRusenderMetricKey };

export function RusenderMetricPage({ metricKey }: { metricKey: RusenderMetricKey }) {
  const def = DEFS[metricKey];
  const { channelId } = useSelectedChannel();
  const { rusenderSurfaces } = useGatedSurfaces();
  const { days, setDays, range, setRange } = usePeriod();
  const [kind, setKind] = useState<'line' | 'bar'>(def.viz);
  const chartH = useExplorerChartHeight();

  // Окно страницы — тот же резолвер, что у `/metrics/ms-*` и `/metrics/ym-*`.
  const period = useMsResolvedPeriod({ days, range });
  const summary = useRusenderSummary(channelId, period, rusenderSurfaces);

  // Предыдущее РАВНОЕ окно — общий хелпер, а не своя арифметика дат. У «Всё» он честно отдаёт
  // null: у полного диапазона предшественника не существует.
  const prevWindow = useMemo(() => msPreviousPeriod(period), [period]);
  const previous = useRusenderSummary(
    channelId,
    prevWindow ?? period,
    rusenderSurfaces && prevWindow != null,
  );
  // ГРАБЛИ prev-периода: при выключенном запросе ключ бы совпал с текущим окном и `.data` отдал
  // бы ТЕКУЩИЙ кэш — дельта вышла бы нулевой. Читаем только когда предыдущее окно существует.
  const prevData = prevWindow != null ? previous.data : undefined;

  if (!rusenderSurfaces) {
    return (
      <EmptyState
        title="Раздел ещё не включён"
        reason="Метрика появится, когда числа Rusender сверены с живыми данными."
        action={{ to: '/rusender', label: 'К обзору' }}
      />
    );
  }
  if (summary.isError) return <ErrorState onRetry={() => void summary.refetch()} />;

  const series: RusenderPoint[] = summary.data?.series ?? [];
  const points = series.map((p) => def.pick(p));
  const dayKeys = series.map((p) => p.day);
  const labels = dayKeys.map((d) => fmt.day(d));
  const axisLabels = timeAxisFromDayKeys(dayKeys);
  const titles = points.map((v, i) => `${labels[i] ?? ''}: ${v == null ? 'данных нет' : fmt.num(v)}`);

  // Считаем по НАБЛЮДЕНИЯМ, а не по длине окна: у снимка базы большая часть дней пуста, и
  // «среднее по 90 дням» с 89 пропусками было бы выдумкой.
  const observed = points.filter((v): v is number => v != null);
  const prevObserved = (prevData?.series ?? []).map((p) => def.pick(p)).filter((v): v is number => v != null);

  // Аддитивная величина сворачивается суммой, уровень — последним снимком: складывать размер
  // базы по дням значило бы получить число, которого никогда не существовало.
  const roll = (vals: number[]) => (def.additive ? vals.reduce((s, v) => s + v, 0) : vals[vals.length - 1] ?? null);
  const cur = observed.length ? roll(observed) : null;
  const prev = prevObserved.length ? roll(prevObserved) : null;
  const delta = cur != null && prev != null && prev > 0 ? ((cur - prev) / prev) * 100 : null;

  const stats = observed.length
    ? [
        { label: 'Мин', value: fmt.kpi(Math.min(...observed)) },
        { label: 'Макс', value: fmt.kpi(Math.max(...observed)) },
        { label: 'Среднее', value: fmt.kpi(observed.reduce((s, v) => s + v, 0) / observed.length) },
        { label: def.additive ? 'Сумма' : 'Последний', value: fmt.kpi(roll(observed) ?? 0) },
      ]
    : [];

  return (
    <RusenderMetricShell
      term={def.term}
      descriptor={`${def.descriptor} · ${def.additive ? 'сумма по дням за окно' : 'последний снимок окна'}`}
      comparison={
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted-foreground">Текущее окно</span>
            <span className="text-base font-medium tabular-nums text-foreground">
              {cur != null ? fmt.kpi(cur) : '—'}
            </span>
          </div>
          {days === 0 ? (
            <p className="text-xs text-muted-foreground">Для окна «Всё» прошлого периода не существует.</p>
          ) : prev != null ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">Пред. период</span>
                <span className="tabular-nums">{fmt.kpi(prev)}</span>
              </div>
              {delta != null && <ComparisonDeltaRow delta={delta} />}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              За прошлое окно данных нет — сравнивать не с чем. Архив копится с момента подключения.
            </p>
          )}
        </div>
      }
    >
      <ChartWidget
        id={`rusender-page-${metricKey}`}
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
        {summary.isPending ? (
          <ChartSkeleton />
        ) : observed.length > 1 ? (
          <ChartExpandedContext.Provider value={true}>
            {kind === 'line' ? (
              <LineChart
                values={points}
                labels={labels}
                axisLabels={axisLabels}
                titles={titles}
                height={chartH}
                markExtremes
                showPoints={points.length <= 45}
                legendToggle={false}
                yMin={0}
              />
            ) : (
              <BarChart
                values={points}
                labels={labels}
                axisLabels={axisLabels}
                titles={titles}
                height={chartH}
                legendToggle={false}
              />
            )}
          </ChartExpandedContext.Provider>
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {observed.length ? 'Пока одна точка — графика ещё нет.' : 'За окно данных нет.'}
          </div>
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
        <PeriodChips
          ariaLabel="Окно"
          value={days}
          onChange={setDays}
          range={range}
          onRangeChange={setRange}
        />
      </WindowBarShell>
    </RusenderMetricShell>
  );
}
