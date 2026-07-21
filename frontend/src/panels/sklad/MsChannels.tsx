import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMsChannelSeries, useMsGeography, useMsSalesByChannel } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import { fmt, pluralRu, smoothSvgPath } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { msPreviousPeriod, useMsPagePeriod, type MsPeriod } from '@/lib/msPeriod';
import { MS_CHANNEL_SELECTION_LIMIT } from '@/lib/msMetricUrlState';
import {
  buildMsChannelContributionItems,
  msChannelContributionCurrent,
  msChannelContributionDelta,
  sortMsChannelContributionItems,
  type MsChannelContributionMetric,
  type MsSalesByChannelData,
} from '@/lib/msChannelContribution';
import {
  aggregatePlotPoints,
  bucketPoints,
  densifyDayPoints,
  fmtMetric,
  metricTotal,
  metricValue,
  pickIndexes,
  CHART_MAX_POINTS,
  GRAIN_BUCKET_WORD,
  METRIC_LABEL,
  type Grain,
  type Metric,
} from '@/lib/msSeries';

/**
 * «Каналы» МойСклада — откуда приходят продажи (salesChannel на заказе) + география доставки.
 * «Выручка по каналу» перешла со Steep-паттерна одного PillSelect на честный МУЛЬТИвыбор внутри
 * графика: по умолчанию все каналы агрегированы (фильтр = агрегация выбранных), можно выбрать
 * несколько, а «Разбить по каналам» рисует их отдельными сериями (bounded читаемым лимитом).
 * Развёрнутый режим переиспользует общий ChartExpandOverlay (фокус-трап, период/грануляция/линия-
 * столбцы) и добавляет MS-контролы через shared `expand.extraControls` — без MS-only модалки.
 */
export function MsChannels() {
  const pp = usePagePeriod();
  const period = useMsPagePeriod();
  const days = pp ? pp.days : 30;
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const channels = useMsSalesByChannel(period);
  const previousPeriod = useMemo(() => msPreviousPeriod(period), [period]);
  const previousChannels = useMsSalesByChannel(previousPeriod ?? period);
  const geo = useMsGeography(period);
  const channelOptions = useMemo(
    () => (channels.data?.rows ?? []).map((r) => ({ id: r.sales_channel_id, name: r.name ?? 'Канал без имени' })),
    [channels.data],
  );

  if (channels.isError) {
    return (
      <ErrorState
        title="Не удалось получить каналы продаж"
        reason={channels.error instanceof Error ? channels.error.message : 'ошибка'}
        onRetry={() => channels.refetch()}
        retrying={channels.isFetching}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <MsChannelDynamicsCard period={period} windowLabel={windowLabel} options={channelOptions} />

      <ChartWidget id="ms-channel-contribution" title="Что изменило результат" fixedSize="full" drillTo="/metrics/ms-sales-channels">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : !channels.data || channels.data.total_orders === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <MsChannelContribution
            current={channels.data}
            previous={previousPeriod && !previousChannels.isError ? (previousChannels.data ?? null) : null}
            comparisonState={
              !previousPeriod ? 'unavailable' : previousChannels.isError ? 'error' : previousChannels.isPending ? 'pending' : 'ready'
            }
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-channels" title={`Продажи по каналам ${windowLabel}`} fixedSize="full" drillTo="/metrics/ms-sales-channels">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : !channels.data || channels.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <MsChannelRows
            rows={channels.data.rows}
            totalOrders={channels.data.total_orders}
            noChannel={channels.data.no_channel_orders}
            noChannelSum={channels.data.no_channel_sum}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-geography" title={`География заказов ${windowLabel}`} fixedSize="full" drillTo="/metrics/ms-geography">
        {geo.isPending ? (
          <ListSkeleton rows={5} />
        ) : geo.isError ? (
          <ErrorState
            compact
            size="table"
            title="Не удалось получить географию заказов"
            reason={geo.error instanceof Error ? geo.error.message : 'ошибка'}
            onRetry={() => geo.refetch()}
            retrying={geo.isFetching}
          />
        ) : !geo.data || geo.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет городов доставки за период." />
        ) : (
          <MsGeographyRows rows={geo.data.rows} noCity={geo.data.no_city_orders} totalOrders={geo.data.total_orders} />
        )}
      </ChartWidget>
    </div>
  );
}

// ── Метрики оси каналов ────────────────────────────────────────────────────────────────────
export type View = 'aggregate' | 'breakdown';
export type ChannelOption = { id: string; name: string };

// Отдельные серии breakdown ограничены читаемым лимитом (steep: пёстрый частокол не читается).
const MAX_BREAKDOWN_SERIES = 6;
// Единый источник лимита выбора каналов — тот же, что применяет URL-парсер (bounded deep link).
const MAX_SELECTED_CHANNELS = MS_CHANNEL_SELECTION_LIMIT;
// Категориальная палитра канона (--chart-1..6, Okabe-Ito) — серия = идентичность, не оценка.
const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `hsl(var(--chart-${n}))`);

function ListSkeleton({ rows }: { rows: number }) {
  return <TableSkeleton rows={rows} columns={4} className="py-2" />;
}

/**
 * «Выручка по каналу» — карточка с мультивыбором и разворотом в общий explorer. Держит metric/
 * view/selected СНАРУЖИ оверлея, чтобы свёрнутая карточка и развёрнутый режим делили одно
 * состояние; в explorer контролы прокидываются через shared `expand.extraControls`.
 */
function MsChannelDynamicsCard({
  period,
  windowLabel,
  options,
}: {
  period: MsPeriod;
  windowLabel: string;
  options: ChannelOption[];
}) {
  const [metric, setMetric] = useState<Metric>('revenue');
  const [view, setView] = useState<View>('aggregate');
  const [selected, setSelected] = useState<string[]>([]);
  const breakdown = view === 'breakdown';

  return (
    <ChartWidget id="ms-channel-series" title={`${METRIC_LABEL[metric]} по каналам ${windowLabel}`} fixedSize="full" drillTo="/metrics/ms-channels">
      <div className="mb-3">
        <MsChannelControls
          metric={metric}
          onMetric={setMetric}
          view={view}
          onView={setView}
          options={options}
          selected={selected}
          onSelected={setSelected}
        />
      </div>
      <MsChannelChart period={period} metric={metric} breakdown={breakdown} selected={selected} options={options} kind="line" />
    </ChartWidget>
  );
}

/** MS-контролы (метрика · вид · каналы) — одни и те же в свёрнутой карточке и в explorer'е. */
export function MsChannelControls({
  metric,
  onMetric,
  view,
  onView,
  options,
  selected,
  onSelected,
  inModal = false,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  view: View;
  onView: (v: View) => void;
  options: ChannelOption[];
  selected: string[];
  onSelected: (ids: string[]) => void;
  inModal?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        ariaLabel="Метрика"
        value={metric}
        onChange={(m) => onMetric(m as Metric)}
        options={[
          { value: 'revenue', content: 'Выручка' },
          { value: 'orders', content: 'Заказы' },
          { value: 'aov', content: 'Средний чек' },
        ]}
      />
      <SegmentedControl
        ariaLabel="Вид"
        value={view}
        onChange={(v) => onView(v as View)}
        options={[
          { value: 'aggregate', content: 'Итог' },
          { value: 'breakdown', content: 'По каналам' },
        ]}
      />
      <MsChannelPicker options={options} selected={selected} onChange={onSelected} inModal={inModal} />
    </div>
  );
}

/** Доступный мультивыбор каналов без сторонних зависимостей: триггер-пилюля + панель чекбоксов
    (нативные inputs = доступность из коробки), Escape и клик-вне закрывают. Пусто = все каналы. */
function MsChannelPicker({
  options,
  selected,
  onChange,
  inModal = false,
}: {
  options: ChannelOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  inModal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const label = selected.length === 0 ? 'Все каналы' : `Каналы: ${selected.length}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else if (selected.length < MAX_SELECTED_CHANNELS) onChange([...selected, id]);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        disabled={options.length === 0}
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:border-ink3/40 disabled:opacity-50"
      >
        <span className="truncate">{label}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-3.5 text-muted-foreground">
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Каналы продаж"
          className={`absolute left-0 top-full mt-1 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.6)] ${inModal ? 'z-modal-popover' : 'z-popover'}`}
        >
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <span className="text-2xs text-muted-foreground">{selected.length} из {MAX_SELECTED_CHANNELS}</span>
            {selected.length > 0 && (
              <button type="button" onClick={() => onChange([])} className="text-2xs text-primary hover:underline">
                Сбросить
              </button>
            )}
          </div>
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-foreground hover:bg-foreground/[0.06]">
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                disabled={!selected.includes(o.id) && selected.length >= MAX_SELECTED_CHANNELS}
                onChange={() => toggle(o.id)}
                className="size-3.5 accent-[hsl(var(--primary))] disabled:opacity-50"
              />
              <span className="min-w-0 truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** График оси каналов: агрегат (одна линия/столбцы) или разбивка (до 6 линий). Сам тянет данные
    для своего окна — переиспользуется и в карточке, и в explorer'е (там своё окно из пилюль). */
export function MsChannelChart({
  period,
  metric,
  breakdown,
  selected,
  options,
  grain = 'day',
  kind,
}: {
  period: MsPeriod;
  metric: Metric;
  breakdown: boolean;
  selected: string[];
  options: ChannelOption[];
  grain?: Grain;
  kind: 'line' | 'bar';
}) {
  const series = useMsChannelSeries(period, { channels: selected, breakdown });
  const expandedHeight = useContext(ExpandedChartHeightContext);
  const nameById = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);

  // Тяжёлые дериваты окна (densify до 730 дн, у разбивки ×6 серий, бакетинг + подписи) — мемо по
  // данным/окну/грануляции/метрике, а не на каждый рендер; хук ДО early-return (React #310).
  const data = series.data;
  const model = useMemo(() => {
    if (!data) return null;
    // Разбивка по каналам: отдельные серии (ограничены читаемым лимитом, честно подписан остаток).
    if (breakdown && data.groups && data.groups.length > 0) {
      const groups = data.groups.slice(0, MAX_BREAKDOWN_SERIES);
      // Общее окно всех групп: для «Всё» (window зависит от первого дня) берём МИНИМАЛЬНЫЙ день по
      // всем группам, чтобы линии densify'ились в одну сетку и X совпадал. Затем densify → бакетинг.
      const firstDay = groups
        .flatMap((g) => g.series.map((p) => p.day))
        .reduce<string | undefined>((a, b) => (a && a < b ? a : b), undefined);
      const bucketed = groups.map((g) => bucketPoints(densifyDayPoints(g.series, period, firstDay), grain));
      const gridDays = bucketed[0] ? bucketed[0].map((p) => p.day) : [];
      const strideIdx = pickIndexes(gridDays.length, CHART_MAX_POINTS);
      return {
        kind: 'breakdown' as const,
        groupCount: groups.length,
        groupTotal: data.group_total ?? null,
        labels: strideIdx.map((i) => fmt.day(gridDays[i])),
        chartSeries: groups.map((g, gi) => ({
          name: nameById.get(g.sales_channel_id) ?? 'Канал',
          color: SERIES_COLORS[gi % SERIES_COLORS.length],
          values: strideIdx.map((i) => (bucketed[gi][i] ? metricValue(metric, bucketed[gi][i]) : null)),
        })),
      };
    }
    // Агрегат (все или выбранные каналы одной серией). Дозаполняем дневную сетку окна нулями,
    // ЗАТЕМ группируем по грануляции (порядок важен: бакетинг сырых редких дней потерял бы нули).
    const bucketed = bucketPoints(densifyDayPoints(data.series, period), grain);
    // Средний чек: рисуем ТОЛЬКО бакеты с заказами непрерывным рядом наблюдений (бакет без заказов
    // даёт неопределённый чек → null → общий LineChart рвёт линию в россыпь точек). Выручку/заказы
    // оставляем полной сеткой с честными нулями. Настоящие даты бакетов сохраняются.
    const points = aggregatePlotPoints(bucketed, metric, CHART_MAX_POINTS);
    return {
      kind: 'aggregate' as const,
      count: points.length,
      values: points.map((p) => metricValue(metric, p)),
      labels: points.map((p) => fmt.day(p.day)),
      titles: points.map((p) => `${fmt.day(p.day)}: ${fmtMetric(metric, metricValue(metric, p))}`),
      total: metricTotal(data.series, metric),
    };
  }, [data, period, grain, metric, breakdown, nameById]);

  if (series.isPending) return <ChartSkeleton className="py-2" />;
  if (series.isError) {
    return (
      <ErrorState
        compact
        size="chart"
        title="Не удалось получить динамику каналов"
        reason={series.error instanceof Error ? series.error.message : 'ошибка'}
        onRetry={() => series.refetch()}
        retrying={series.isFetching}
      />
    );
  }
  if (!model) return null;

  if (model.kind === 'breakdown') {
    const hiddenTotal = model.groupTotal ?? selected.length;
    return (
      <div>
        <MsMultiLine series={model.chartSeries} labels={model.labels} height={expandedHeight ?? 200} metric={metric} />
        {hiddenTotal > model.groupCount && (
          <p className="mt-2 text-2xs text-muted-foreground">
            Показаны первые {model.groupCount} каналов из {hiddenTotal} — разбивка ограничена для читаемости.
          </p>
        )}
        {breakdown && selected.length === 0 && (
          <p className="mt-2 text-2xs text-muted-foreground">Выберите каналы, чтобы разбить график по каждому.</p>
        )}
      </div>
    );
  }

  if (breakdown && selected.length === 0) {
    return <EmptyState compact size="chart" title="Выберите каналы, чтобы разбить график по каждому." />;
  }

  if (model.count < 2) {
    return (
      <EmptyState
        compact
        size="chart"
        title={metric === 'aov'
          ? 'Недостаточно бакетов с заказами для среднего чека за период.'
          : 'Недостаточно данных по каналу за период.'}
        reason={metric === 'aov'
          ? undefined
          : 'Если каналы пусты — запустите повторную загрузку истории на «Подключении».'}
      />
    );
  }
  const { values, labels, titles, total } = model;
  const channelCaption =
    selected.length === 0 ? 'Все каналы' : `${selected.length} ${pluralRu(selected.length, ['канал', 'канала', 'каналов'])}`;
  // Средний чек агрегируется по бакетам с заказами — подписываем это честно (день/неделя/месяц).
  const caption = metric === 'aov' ? `${channelCaption} · по ${GRAIN_BUCKET_WORD[grain]} с заказами` : channelCaption;

  return (
    <ChartCardBody value={fmtMetric(metric, total)} caption={caption}>
      {kind === 'bar' ? (
        <BarChart values={values.map((v) => v ?? 0)} labels={labels} titles={titles} height={expandedHeight ?? undefined} />
      ) : (
        <LineChart values={values} labels={labels} titles={titles} yMin={0} height={expandedHeight ?? undefined} />
      )}
    </ChartCardBody>
  );
}

/** Компактный мультисерийный SVG (до 6 линий) в категориальной палитре. preserveAspectRatio=none
    растягивает viewBox неравномерно → обводки обязаны нести non-scaling-stroke (канон графиков). */
function MsMultiLine({
  series,
  labels,
  height,
  metric,
}: {
  series: { name: string; color: string; values: (number | null)[] }[];
  labels: string[];
  height: number;
  metric: Metric;
}) {
  const expanded = useContext(ChartExpandedContext);
  const plotRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const n = labels.length;
  // Геометрия серий (max, экранные координаты, сегменты полилиний) от ховера не зависит — мемо по
  // данным, иначе каждый pointermove-рендер пересобирал бы до 6×CHART_MAX_POINTS точек заново.
  const geometry = useMemo(() => {
    const nums = series.flatMap((s) => s.values).filter((v): v is number => v != null);
    const max = nums.length ? Math.max(...nums, 0) : 1;
    const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
    const y = (v: number) => (max <= 0 ? 100 : 100 - (v / max) * 100);
    // Для среднего чека null означает не пропуск сбора, а отсутствие определённого значения в период
    // без заказов. Соединяем реальные наблюдения, сохраняя их календарные X-позиции; tooltip на пустом
    // периоде по-прежнему показывает «—». Для остальных метрик настоящий null остаётся разрывом.
    type Pt = { x: number; y: number };
    const segmentsOf = (values: (number | null)[]): { lines: string[]; lone: Pt[] } => {
      if (metric === 'aov') {
        const observed = values.flatMap((v, i) => (v == null ? [] : [{ x: x(i), y: y(v) }]));
        if (observed.length >= 2) {
          return { lines: [smoothSvgPath(observed, 2)], lone: [] };
        }
        return { lines: [], lone: observed };
      }
      const lines: string[] = [];
      const lone: Pt[] = [];
      let cur: Pt[] = [];
      const flush = () => {
        if (cur.length >= 2) lines.push(smoothSvgPath(cur, 2));
        else if (cur.length === 1) lone.push(cur[0]);
        cur = [];
      };
      values.forEach((v, i) => {
        if (v == null) flush();
        else cur.push({ x: x(i), y: y(v) });
      });
      flush();
      return { lines, lone };
    };
    return { max, x, segments: series.map((s) => segmentsOf(s.values)) };
  }, [series, n, metric]);
  const { max, x } = geometry;
  const hoverAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    setHovered(Math.round(ratio * Math.max(n - 1, 0)));
  };
  const axisIndexes = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);
  const hoverX = hovered == null ? null : x(hovered);
  // Stable data signature for the reveal (see index.css «Chart motion») — the up-to-6 series fade in
  // when the metric/period/selection changes, never on hover (separate state) or a container resize.
  const motionKey = series.map((s) => s.values.join(',')).join('|');
  const ariaSummary = `${METRIC_LABEL[metric]} по каналам: ${series.map((item) => item.name).join(', ')}`;
  return (
    <div>
      <div className={expanded ? 'relative pl-12' : undefined}>
        {expanded && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-11 text-right text-2xs text-muted-foreground">
            <span className="absolute right-2 top-0 -translate-y-1/2">{fmtMetric(metric, max)}</span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2">{fmtMetric(metric, max / 2)}</span>
            <span className="absolute bottom-0 right-2 translate-y-1/2">{fmtMetric(metric, 0)}</span>
          </div>
        )}
        <div
          ref={plotRef}
          role="img"
          aria-label={ariaSummary}
          tabIndex={0}
          className="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          onPointerMove={(event) => hoverAt(event.clientX)}
          onPointerLeave={() => {
            if (!focused) setHovered(null);
          }}
          onFocus={() => {
            setFocused(true);
            setHovered((current) => current ?? Math.max(n - 1, 0));
          }}
          onBlur={() => {
            setFocused(false);
            setHovered(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const step = event.key === 'ArrowLeft' ? -1 : 1;
            setHovered((current) => Math.max(0, Math.min(n - 1, (current ?? n - 1) + step)));
          }}
        >
          {expanded && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {[0, 50, 100].map((top) => (
                <span key={top} className="absolute left-0 right-0 border-t border-dashed border-border/50" style={{ top: `${top}%` }} />
              ))}
            </div>
          )}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="relative w-full" style={{ height }} aria-hidden="true" data-chart-curve="smooth">
            {/* Series lines fade-reveal on a data change; the keyed group keeps the hover guide below
                it out of the motion so scrubbing never re-reveals the chart. */}
            <g key={motionKey} data-chart-motion="reveal">
              {series.map((s, si) => {
                const { lines, lone } = geometry.segments[si];
                return (
                  <g key={s.name}>
                    {lines.map((path, si) => (
                      <path
                        key={`l${si}`}
                        d={path}
                        fill="none"
                        stroke={s.color}
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ))}
                    {lone.map((p, pi) => (
                      <circle key={`p${pi}`} cx={p.x} cy={p.y} r="1.4" fill={s.color} />
                    ))}
                  </g>
                );
              })}
            </g>
            {hoverX != null && (
              <line x1={hoverX} x2={hoverX} y1="0" y2="100" stroke="hsl(var(--foreground) / 0.35)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hovered != null && (
            <div
              className={`pointer-events-none absolute top-2 z-tooltip min-w-44 rounded-lg border border-border bg-popover/95 px-2.5 py-2 text-2xs shadow-lg backdrop-blur-sm ${hovered > n * 0.62 ? '-translate-x-full' : ''}`}
              style={{ left: `${hoverX ?? 0}%` }}
            >
              <p className="mb-1 font-medium text-foreground">{labels[hovered]}</p>
              {series.map((item) => (
                <p key={item.name} className="flex items-center justify-between gap-3 text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="max-w-32 truncate">{item.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground">{fmtMetric(metric, item.values[hovered])}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
      {axisIndexes.length > 1 && (
        <div className={`mt-1 flex justify-between text-2xs text-muted-foreground ${expanded ? 'ml-12' : ''}`} aria-hidden="true">
          {axisIndexes.map((index) => <span key={index}>{labels[index]}</span>)}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span aria-hidden="true" className="h-1.5 w-3 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="max-w-[10rem] truncate">{s.name}</span>
          </span>
        ))}
        <span className="text-2xs text-muted-foreground">
          · {METRIC_LABEL[metric]}
          {metric === 'aov' ? ' · только периоды с заказами' : ''}
        </span>
      </div>
    </div>
  );
}

// Тип канала МС → короткий русский ярлык (тихий, muted): группирует источники, не кричит.
const CHANNEL_TYPE_LABEL: Record<string, string> = {
  ECOMMERCE: 'Сайт',
  DIRECT_SALES: 'Прямые',
  MARKETPLACE: 'Маркетплейс',
  SOCIAL_NETWORK: 'Соцсети',
  OTHER: 'Другое',
};

type SalesRow = { sales_channel_id: string; name: string | null; type: string | null; orders: number; sum: number };
type SortKey = 'revenue' | 'orders' | 'aov' | 'name';

/** Каналы продаж с явной сортировкой (выручка/заказы/средний чек/имя), долей выручки и средним
    чеком по строке. Свёрнуто — топ-8, разворот — все; строку без канала бэк выносит в noChannel. */
export function MsChannelRows({
  rows,
  totalOrders,
  noChannel,
  noChannelSum,
}: {
  rows: SalesRow[];
  totalOrders: number;
  noChannel: number;
  noChannelSum: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [sort, setSort] = useState<SortKey>('revenue');
  const aov = (r: SalesRow) => (r.orders > 0 ? r.sum / r.orders : 0);
  const totalSum = useMemo(() => rows.reduce((a, r) => a + r.sum, noChannelSum), [rows, noChannelSum]);
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      if (sort === 'name') return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'ru');
      if (sort === 'orders') return b.orders - a.orders || b.sum - a.sum;
      if (sort === 'aov') return aov(b) - aov(a);
      return b.sum - a.sum || b.orders - a.orders;
    });
    return arr;
  }, [rows, sort]);
  const shown = expanded ? sorted : sorted.slice(0, 8);
  const maxSum = Math.max(...rows.map((r) => r.sum), 1);
  const restOrders = (expanded ? [] : sorted.slice(8)).reduce((acc, r) => acc + r.orders, 0) + noChannel;

  return (
    <div className="space-y-2.5 pt-1">
      <div className="flex items-center gap-2">
        <span className="text-2xs text-muted-foreground">Сортировать:</span>
        <SegmentedControl
          ariaLabel="Сортировка каналов"
          value={sort}
          onChange={(s) => setSort(s as SortKey)}
          options={[
            { value: 'revenue', content: 'Выручка' },
            { value: 'orders', content: 'Заказы' },
            { value: 'aov', content: 'Ср. чек' },
            { value: 'name', content: 'Имя' },
          ]}
        />
      </div>
      {shown.map((r) => {
        const share = totalSum > 0 ? Math.round((r.sum / totalSum) * 100) : 0;
        return (
          <div key={r.sales_channel_id}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-baseline gap-2 text-foreground">
                <span className="truncate">{r.name ?? 'Канал без имени'}</span>
                {r.type && CHANNEL_TYPE_LABEL[r.type] && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{CHANNEL_TYPE_LABEL[r.type]}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{fmt.short(r.sum)} ₽</span> · {share}% · {fmt.num(r.orders)}{' '}
                {pluralRu(r.orders, ['заказ', 'заказа', 'заказов'])} · ср. {fmt.short(aov(r))} ₽
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(3, Math.round((r.sum / maxSum) * 100))}%`,
                  backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
                }}
              />
            </div>
          </div>
        );
      })}
      {restOrders > 0 && (
        <p className="text-2xs text-muted-foreground">
          {expanded ? 'Из них' : 'Ещё'} {fmt.num(restOrders)}{' '}
          {noChannel > 0 ? `заказов (без канала ${fmt.num(noChannel)} · ${fmt.short(noChannelSum)} ₽)` : 'заказов'} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}

// ── Вклад каналов: текущее окно против равного предыдущего ────────────────────────────────────

function signedValue(delta: number, metric: MsChannelContributionMetric): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return metric === 'revenue'
    ? `${sign}${fmt.short(Math.abs(delta))} ₽`
    : `${sign}${fmt.num(Math.abs(delta))}`;
}

/**
 * Decision view rather than another ranking: current share and signed absolute change against the
 * exactly equal previous window. Positive and negative deltas reconcile to the overall change;
 * previous-only channels and the explicit «Без канала» row remain visible.
 */
export function MsChannelContribution({
  current,
  previous,
  comparisonState,
  metric: metricProp,
  onMetric,
}: {
  current: MsSalesByChannelData;
  previous: MsSalesByChannelData | null;
  comparisonState: 'ready' | 'pending' | 'error' | 'unavailable' | 'disabled';
  /** Optional controlled binding for the canonical full metric page; compact cards stay local. */
  metric?: MsChannelContributionMetric;
  onMetric?: (metric: MsChannelContributionMetric) => void;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [metricState, setMetricState] = useState<MsChannelContributionMetric>('revenue');
  const metric = metricProp ?? metricState;
  const setMetric = onMetric ?? setMetricState;
  const comparable = comparisonState === 'ready' && previous != null;
  const items = useMemo(
    () => buildMsChannelContributionItems(current, comparable ? previous : null),
    [current, previous, comparable],
  );
  const sorted = useMemo(
    () => sortMsChannelContributionItems(items, metric, comparable),
    [items, metric, comparable],
  );
  const shown = useMemo(() => {
    if (expanded || sorted.length <= 8) return sorted;
    const synthetic = sorted.find((item) => item.synthetic);
    const regular = sorted.filter((item) => !item.synthetic).slice(0, synthetic ? 7 : 8);
    return synthetic ? [...regular, synthetic] : regular;
  }, [expanded, sorted]);
  const shownIds = useMemo(() => new Set(shown.map((item) => item.id)), [shown]);
  const hidden = sorted.filter((item) => !shownIds.has(item.id));
  const total = items.reduce((sum, item) => sum + msChannelContributionCurrent(item, metric), 0);
  const max = Math.max(...items.map((item) => msChannelContributionCurrent(item, metric)), 1);
  const hiddenValue = hidden.reduce((sum, item) => sum + msChannelContributionCurrent(item, metric), 0);

  return (
    <div className="space-y-2.5 pt-1">
      <SegmentedControl
        ariaLabel="Метрика вклада каналов"
        value={metric}
        onChange={(value) => setMetric(value as MsChannelContributionMetric)}
        options={[
          { value: 'revenue', content: 'Выручка' },
          { value: 'orders', content: 'Заказы' },
        ]}
      />
      {comparisonState === 'unavailable' && (
        <p className="text-2xs text-muted-foreground">
          Для окна «Всё» нет равного предыдущего периода — показана только текущая доля.
        </p>
      )}
      {comparisonState === 'pending' && <p className="text-2xs text-muted-foreground">Загружаем равный предыдущий период…</p>}
      {comparisonState === 'error' && (
        <p role="status" className="text-2xs text-muted-foreground">
          Сравнение с предыдущим периодом недоступно. Текущие значения показаны без подстановки нулей.
        </p>
      )}
      {shown.map((it) => {
        const currentValue = msChannelContributionCurrent(it, metric);
        const share = total > 0 ? (currentValue / total) * 100 : 0;
        const delta = msChannelContributionDelta(it, metric);
        const deltaColor = delta == null || delta === 0
          ? 'hsl(var(--muted-foreground))'
          : delta > 0 ? 'hsl(var(--chart-role-positive))' : 'hsl(var(--chart-role-negative))';
        return (
          <div key={it.id}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-baseline gap-2 text-foreground">
                <span className={`truncate ${it.synthetic ? 'text-muted-foreground' : ''}`}>{it.name}</span>
                {it.type && CHANNEL_TYPE_LABEL[it.type] && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{CHANNEL_TYPE_LABEL[it.type]}</span>
                )}
              </span>
              <span className="flex shrink-0 items-baseline gap-2 tabular-nums text-muted-foreground">
                <span>
                  <span className="font-medium text-foreground">
                    {metric === 'revenue' ? `${fmt.short(currentValue)} ₽` : fmt.num(currentValue)}
                  </span>{' '}
                  · {share.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%
                </span>
                {comparable && delta != null && (
                  <span
                    className="inline-flex items-center gap-0.5 text-2xs"
                    style={{ color: deltaColor }}
                    title="Изменение против равного предыдущего окна"
                  >
                    <span aria-hidden="true">{delta > 0 ? '▲' : delta < 0 ? '▼' : '•'}</span>
                    {signedValue(delta, metric)}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${currentValue === 0 ? 0 : Math.max(3, Math.round((currentValue / max) * 100))}%`,
                  backgroundColor: `hsl(var(--chart-role-primary) / ${it.synthetic ? '0.4' : '0.75'})`,
                }}
              />
            </div>
          </div>
        );
      })}
      {hiddenValue > 0 && (
        <p className="text-2xs text-muted-foreground">
          Ещё {metric === 'revenue' ? `${fmt.short(hiddenValue)} ₽` : `${fmt.num(hiddenValue)} ${pluralRu(hiddenValue, ['заказ', 'заказа', 'заказов'])}`} в свёрнутых каналах.
        </p>
      )}
      {comparable && (
        <p className="text-2xs text-muted-foreground">
          Положительные и отрицательные изменения каналов, включая «Без канала», в сумме дают общее изменение.
        </p>
      )}
    </div>
  );
}

/** Топ городов доставки: compact показывает пять строк и честный хвост; разворот — все города. */
export function MsGeographyRows({
  rows,
  noCity,
  totalOrders,
}: {
  rows: Array<{ city: string; orders: number; sum: number }>;
  noCity: number;
  totalOrders: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 5);
  const hiddenCities = expanded ? 0 : Math.max(0, rows.length - shown.length);
  const maxOrders = rows[0]?.orders ?? 1;
  const cityRows = shown.map((r) => (
    <div key={r.city}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-foreground">{r.city}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{fmt.num(r.orders)}</span> · {fmt.short(r.sum)} ₽
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(3, Math.round((r.orders / maxOrders) * 100))}%`,
            backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
          }}
        />
      </div>
    </div>
  ));
  return (
    <div className={expanded ? 'space-y-2.5 pt-1' : 'space-y-1.5'}>
      {expanded ? (
        cityRows
      ) : (
        // Full-width карточка: на md+ города встают в две колонки, сноска остаётся на всю ширину
        // под ними; мобайл — прежняя одна колонка с тем же вертикальным ритмом.
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">{cityRows}</div>
      )}
      {!expanded && (hiddenCities > 0 || noCity > 0) && (
        <p className="truncate text-2xs text-muted-foreground">
          {hiddenCities > 0 && (
            <>Ещё {fmt.num(hiddenCities)} {pluralRu(hiddenCities, ['город', 'города', 'городов'])} в отчёте</>
          )}
          {hiddenCities > 0 && noCity > 0 && ' · '}
          {noCity > 0 && <>Без города: {fmt.num(noCity)} из {fmt.num(totalOrders)}</>}
        </p>
      )}
      {expanded && noCity > 0 && (
        <p className="text-2xs text-muted-foreground">
          Без города доставки (самовывоз / не указан): {fmt.num(noCity)} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}
