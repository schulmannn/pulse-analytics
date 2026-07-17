import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMsChannelSeries, useMsGeography, useMsSalesByChannel } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import type { ChartExpandConfig } from '@/components/ExpandableChart';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt, pluralRu } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { msDensifyWindow, useMsPagePeriod, type MsPeriod } from '@/lib/msPeriod';

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

      <ChartWidget id="ms-channels" title={`Продажи по каналам ${windowLabel}`} fixedSize="full">
        {channels.isPending ? (
          <ListSkeleton rows={6} />
        ) : !channels.data || channels.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsChannelRows
            rows={channels.data.rows}
            totalOrders={channels.data.total_orders}
            noChannel={channels.data.no_channel_orders}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-geography" title={`География заказов ${windowLabel}`} fixedSize="half">
        {geo.isPending ? (
          <ListSkeleton rows={5} />
        ) : geo.isError ? (
          <ErrorState
            title="Не удалось получить географию заказов"
            reason={geo.error instanceof Error ? geo.error.message : 'ошибка'}
            onRetry={() => geo.refetch()}
            retrying={geo.isFetching}
          />
        ) : !geo.data || geo.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет городов доставки за период.</p>
        ) : (
          <MsGeographyRows rows={geo.data.rows} noCity={geo.data.no_city_orders} totalOrders={geo.data.total_orders} />
        )}
      </ChartWidget>
    </div>
  );
}

const localDayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const dayToDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// ── Метрики оси каналов ────────────────────────────────────────────────────────────────────
type Metric = 'revenue' | 'orders' | 'aov';
type View = 'aggregate' | 'breakdown';
type ChannelOption = { id: string; name: string };
type DayPoint = { day: string; orders: number; sum: number };

const METRIC_LABEL: Record<Metric, string> = { revenue: 'Выручка', orders: 'Заказы', aov: 'Средний чек' };
// Отдельные серии breakdown ограничены читаемым лимитом (steep: пёстрый частокол не читается).
const MAX_BREAKDOWN_SERIES = 6;
const MAX_SELECTED_CHANNELS = 20;
const CHART_MAX_POINTS = 140;
// Категориальная палитра канона (--chart-1..6, Okabe-Ito) — серия = идентичность, не оценка.
const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `hsl(var(--chart-${n}))`);

/** Значение метрики точки: средний чек честно null в день без заказов (деление на ноль = ложь). */
function metricValue(metric: Metric, p: { orders: number; sum: number }): number | null {
  if (metric === 'revenue') return p.sum;
  if (metric === 'orders') return p.orders;
  return p.orders > 0 ? p.sum / p.orders : null;
}

/** Формат значения метрики для тултипа/числа. */
function fmtMetric(metric: Metric, v: number | null): string {
  if (v == null) return '—';
  return metric === 'orders' ? fmt.num(v) : `${fmt.short(v)} ₽`;
}

/** Календарная сетка окна нулями (бэк отдаёт только дни с заказами) — арифметика по архиву, не
    пропуск сбора: день без заказов = честный ноль (для среднего чека — null-разрыв). */
function densifyChannel(series: DayPoint[], period: MsPeriod, firstDayOverride?: string): DayPoint[] {
  const win = msDensifyWindow(period, firstDayOverride ?? series[0]?.day);
  if (!win) return series;
  const byDay = new Map(series.map((r) => [r.day, r]));
  const out: DayPoint[] = [];
  for (const d = new Date(win.start); d <= win.end; d.setDate(d.getDate() + 1)) {
    const key = localDayKey(d);
    const r = byDay.get(key);
    out.push({ day: key, orders: r?.orders ?? 0, sum: r?.sum ?? 0 });
  }
  return out;
}

/** Грануляция дневной серии в неделю/месяц (сумма заказов/выручки; средний чек — производное на
    границе бакета). Зеркало «День/Неделя/Месяц» общего explorer'а. */
function bucketPoints(points: DayPoint[], grain: 'day' | 'week' | 'month'): DayPoint[] {
  if (grain === 'day') return points;
  const key = (day: string) => {
    if (grain === 'month') return `${day.slice(0, 7)}-01`;
    const d = dayToDate(day);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // к понедельнику недели
    return localDayKey(d);
  };
  const map = new Map<string, DayPoint>();
  for (const p of points) {
    const k = key(p.day);
    const cur = map.get(k) ?? { day: k, orders: 0, sum: 0 };
    cur.orders += p.orders;
    cur.sum += p.sum;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Прореживание с сохранением выравнивания по X (равномерный шаг + последняя точка). LTTB не
    годится для мультисерий: он выбирал бы разные индексы для каждой линии → рассинхрон оси. */
function strideEvery<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
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

  const controls = (inModal = false) => (
    <MsChannelControls
      metric={metric}
      onMetric={setMetric}
      view={view}
      onView={setView}
      options={options}
      selected={selected}
      onSelected={setSelected}
      inModal={inModal}
    />
  );

  // Развёрнутый режим: тот же общий overlay (период 7/30/90/Всё · грануляция · линия/столбцы) +
  // MS-контролы. renderExpanded сам тянет данные для выбранного окна overlay'а (свой MsPeriod).
  const expand: ChartExpandConfig = {
    renderExpanded: (d, grain) => (
      <MsChannelChart period={{ days: d }} metric={metric} breakdown={breakdown} selected={selected} options={options} grain={grain} kind="line" />
    ),
    // Мультисерийные столбцы на 6×140 значений превращаются в нечитаемый частокол. В режиме
    // breakdown оставляем сравнение линиями и честно убираем переключатель типа; для агрегата
    // общий line/bar control работает полностью.
    renderExpandedBar: breakdown
      ? undefined
      : (d, grain) => (
          <MsChannelChart period={{ days: d }} metric={metric} breakdown={false} selected={selected} options={options} grain={grain} kind="bar" />
        ),
    grainable: true,
    extraControls: controls(true),
  };

  return (
    <ChartWidget id="ms-channel-series" title={`${METRIC_LABEL[metric]} по каналам ${windowLabel}`} fixedSize="full" expand={expand}>
      <div className="mb-3">{controls()}</div>
      <MsChannelChart period={period} metric={metric} breakdown={breakdown} selected={selected} options={options} kind="line" />
    </ChartWidget>
  );
}

/** MS-контролы (метрика · вид · каналы) — одни и те же в свёрнутой карточке и в explorer'е. */
function MsChannelControls({
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
function MsChannelChart({
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
  grain?: 'day' | 'week' | 'month';
  kind: 'line' | 'bar';
}) {
  const series = useMsChannelSeries(period, { channels: selected, breakdown });
  const expandedHeight = useContext(ExpandedChartHeightContext);
  const nameById = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);

  if (series.isPending) return <ListSkeleton rows={4} />;
  if (series.isError) {
    return (
      <ErrorState
        title="Не удалось получить динамику каналов"
        reason={series.error instanceof Error ? series.error.message : 'ошибка'}
        onRetry={() => series.refetch()}
        retrying={series.isFetching}
      />
    );
  }
  const data = series.data;
  if (!data) return null;

  // Разбивка по каналам: отдельные серии (ограничены читаемым лимитом, честно подписан остаток).
  if (breakdown && data.groups && data.groups.length > 0) {
    const groups = data.groups.slice(0, MAX_BREAKDOWN_SERIES);
    // Общее окно всех групп: для «Всё» (window зависит от первого дня) берём МИНИМАЛЬНЫЙ день по
    // всем группам, чтобы линии densify'ились в одну сетку и X совпадал. Затем densify → бакетинг.
    const firstDay = groups
      .flatMap((g) => g.series.map((p) => p.day))
      .reduce<string | undefined>((a, b) => (a && a < b ? a : b), undefined);
    const bucketed = groups.map((g) => bucketPoints(densifyChannel(g.series, period, firstDay), grain));
    const gridDays = bucketed[0] ? bucketed[0].map((p) => p.day) : [];
    const strideIdx = pickIndexes(gridDays.length, Math.min(gridDays.length, CHART_MAX_POINTS));
    const labels = strideIdx.map((i) => gridDays[i]);
    const chartSeries = groups.map((g, gi) => ({
      name: nameById.get(g.sales_channel_id) ?? 'Канал',
      color: SERIES_COLORS[gi % SERIES_COLORS.length],
      values: strideIdx.map((i) => (bucketed[gi][i] ? metricValue(metric, bucketed[gi][i]) : null)),
    }));
    const hiddenTotal = data.group_total ?? selected.length;
    return (
      <div>
        <MsMultiLine series={chartSeries} labels={labels.map(fmt.day)} height={expandedHeight ?? 200} metric={metric} />
        {hiddenTotal > groups.length && (
          <p className="mt-2 text-2xs text-muted-foreground">
            Показаны первые {groups.length} каналов из {hiddenTotal} — разбивка ограничена для читаемости.
          </p>
        )}
        {breakdown && selected.length === 0 && (
          <p className="mt-2 text-2xs text-muted-foreground">Выберите каналы, чтобы разбить график по каждому.</p>
        )}
      </div>
    );
  }

  if (breakdown && selected.length === 0) {
    return <p className="py-4 text-xs text-muted-foreground">Выберите каналы, чтобы разбить график по каждому.</p>;
  }

  // Агрегат (все или выбранные каналы одной серией). Дозаполняем дневную сетку окна нулями,
  // ЗАТЕМ группируем по грануляции (порядок важен: бакетинг сырых редких дней потерял бы нули).
  const points = strideEvery(bucketPoints(densifyChannel(data.series, period), grain), CHART_MAX_POINTS);
  if (points.length < 2) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        Недостаточно данных по каналу за период. Если каналы пусты — запустите повторную загрузку истории на «Подключении».
      </p>
    );
  }
  const values = points.map((p) => metricValue(metric, p));
  const labels = points.map((p) => fmt.day(p.day));
  const titles = points.map((p) => `${fmt.day(p.day)}: ${fmtMetric(metric, metricValue(metric, p))}`);
  const total =
    metric === 'aov'
      ? (() => {
          const s = data.series.reduce((a, p) => a + p.sum, 0);
          const o = data.series.reduce((a, p) => a + p.orders, 0);
          return o > 0 ? s / o : null;
        })()
      : data.series.reduce((a, p) => a + (metric === 'revenue' ? p.sum : p.orders), 0);
  const caption = `${selected.length === 0 ? 'Все каналы' : `${selected.length} ${pluralRu(selected.length, ['канал', 'канала', 'каналов'])}`}`;

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

/** Индексы прореживания, согласованные с strideEvery (та же схема шага), чтобы X совпадал. */
function pickIndexes(total: number, sampled: number): number[] {
  if (total <= sampled) return Array.from({ length: total }, (_, i) => i);
  const step = Math.ceil(total / CHART_MAX_POINTS);
  const out: number[] = [];
  for (let i = 0; i < total; i += step) out.push(i);
  if (out[out.length - 1] !== total - 1) out.push(total - 1);
  return out;
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
  const nums = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const max = nums.length ? Math.max(...nums, 0) : 1;
  const n = labels.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const y = (v: number) => (max <= 0 ? 100 : 100 - (v / max) * 100);
  // Разбить на непрерывные сегменты по null (день без среднего чека = разрыв, не мост).
  const segmentsOf = (values: (number | null)[]) => {
    const segs: string[] = [];
    let cur: string[] = [];
    values.forEach((v, i) => {
      if (v == null) {
        if (cur.length) segs.push(cur.join(' '));
        cur = [];
      } else {
        cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
      }
    });
    if (cur.length) segs.push(cur.join(' '));
    return segs;
  };
  const hoverAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    setHovered(Math.round(ratio * Math.max(n - 1, 0)));
  };
  const axisIndexes = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);
  const hoverX = hovered == null ? null : x(hovered);
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
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="relative w-full" style={{ height }} aria-hidden="true">
            {series.map((s) =>
              segmentsOf(s.values).map((pts, si) => (
                <polyline
                  key={`${s.name}-${si}`}
                  points={pts}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )),
            )}
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
        <span className="text-2xs text-muted-foreground">· {METRIC_LABEL[metric]}</span>
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
function MsChannelRows({
  rows,
  totalOrders,
  noChannel,
}: {
  rows: SalesRow[];
  totalOrders: number;
  noChannel: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const [sort, setSort] = useState<SortKey>('revenue');
  const aov = (r: SalesRow) => (r.orders > 0 ? r.sum / r.orders : 0);
  const totalSum = useMemo(() => rows.reduce((a, r) => a + r.sum, 0), [rows]);
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
          {noChannel > 0 ? `заказов (без канала ${fmt.num(noChannel)})` : 'заказов'} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}

/** Топ городов доставки: строки-бары по числу заказов; разворот — все города. */
function MsGeographyRows({
  rows,
  noCity,
  totalOrders,
}: {
  rows: Array<{ city: string; orders: number; sum: number }>;
  noCity: number;
  totalOrders: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 6);
  const maxOrders = rows[0]?.orders ?? 1;
  return (
    <div className="space-y-2.5 pt-1">
      {shown.map((r) => (
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
      ))}
      {noCity > 0 && (
        <p className="text-2xs text-muted-foreground">
          Без города доставки (самовывоз / не указан): {fmt.num(noCity)} из {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}
