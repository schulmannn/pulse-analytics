import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useChannels } from '@/api/queries';
import { DEFAULT_WIDGET_DAYS } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { VIZ_LABEL } from '@/lib/widgetRender';
import type { MetricDef } from '@/lib/widgetMetrics';
import type { WidgetSize } from '@/components/ChartWidget';
import { dimensionsFor, type DimensionDef } from '@/lib/dimensions';
import type { ComparisonDisplay, ComparisonMode, FilterOp, WidgetConfig, WidgetFilter, WidgetGrain } from '@/lib/widgetConfig';

/**
 * The universal metric-builder editor — the steep «Edit widget» for a WidgetConfig. Unlike the
 * legacy prefs dialog (title / accent / size only), this edits the whole semantic object:
 * visualisation · period · grain · comparison · target · source · accent · background · title · size.
 * Controls appear by the metric's shape (metric.kind / supportedViz) so a value metric shows fewer
 * knobs than a series one, but every widget feels like the same system.
 *
 * Writes are patches to the config store (onChange) — the store normalises + re-renders, so the
 * dialog always reflects the stored truth. Filters (S7) and dynamic/forecast targets (S9) get their
 * own controls in those sprints; here target is a fixed goal line.
 */

const PERIODS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

const GRAINS: Array<{ value: WidgetGrain; label: string }> = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'quarter', label: 'Квартал' },
  { value: 'year', label: 'Год' },
];

const CMP_MODES: Array<{ value: ComparisonMode; label: string }> = [
  { value: 'none', label: 'Выкл' },
  { value: 'previous_period', label: 'Пред. период' },
  { value: 'same_period_last_year', label: 'Год назад' },
];

const CMP_DISPLAY: Array<{ value: ComparisonDisplay; label: string }> = [
  { value: 'delta', label: 'Дельта' },
  { value: 'ghost_line', label: 'Пунктир' },
  { value: 'both', label: 'Оба' },
];

const SIZES: Array<{ value: WidgetSize; label: string }> = [
  { value: 'third', label: 'Треть' },
  { value: 'half', label: 'Половина' },
  { value: 'full', label: 'Полный' },
];

const SWATCHES = [1, 2, 3, 4, 5, 6] as const;

export function ConfigEditDialog({
  config,
  metric,
  onChange,
  onClose,
}: {
  config: WidgetConfig;
  metric: MetricDef;
  onChange: (patch: Partial<WidgetConfig>) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const isSeries = metric.kind === 'series';
  const filterDims = dimensionsFor(metric.dimensions);
  // Comparison (a ghost line) + target (a goal line) only render on a series chart — a value/KPI has
  // nowhere to draw them and a breakdown is a distribution, so both controls are gated to series to
  // avoid shipping knobs with no visible effect. (KPI delta-comparison + progress caption = S8/S9.)
  const showComparison = isSeries;
  const showTarget = isSeries;
  const cmpMode: ComparisonMode = config.comparison?.mode ?? 'none';
  const cmpDisplay: ComparisonDisplay = config.comparison?.display ?? 'ghost_line';

  const reset = () =>
    onChange({
      viz: metric.defaultViz,
      title: undefined,
      period: undefined,
      grain: undefined,
      includeToday: undefined,
      source: undefined,
      size: undefined,
      filters: undefined,
      comparison: undefined,
      target: undefined,
      style: undefined,
    });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`Настройка виджета «${config.title || metric.label}»`}
      onClick={onClose}
    >
      <div className="my-auto w-full max-w-md rounded-xl border border-border bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Настройка метрики</div>
          <div className="truncate text-xs text-muted-foreground">{metric.label}</div>
        </div>

        {/* Visualisation — only when the metric supports more than one. */}
        {metric.supportedViz.length > 1 && (
          <Field label="Визуализация">
            <Segmented
              options={metric.supportedViz.map((v) => ({ value: v, label: VIZ_LABEL[v] }))}
              value={config.viz}
              onChange={(viz) => onChange({ viz })}
            />
          </Field>
        )}

        <Field label="Период">
          <Segmented
            options={PERIODS.map((p) => ({ value: String(p.days), label: p.label }))}
            value={String(config.period ?? DEFAULT_WIDGET_DAYS)}
            onChange={(v) => onChange({ period: Number(v) as PeriodDays })}
          />
        </Field>

        {isSeries && (
          <Field label="Грануляция">
            <Segmented
              options={GRAINS.map((g) => ({ value: g.value, label: g.label }))}
              value={config.grain ?? 'day'}
              onChange={(v) => onChange({ grain: v as WidgetGrain })}
            />
          </Field>
        )}

        {showComparison && (
          <Field label="Сравнение">
            <Segmented
              options={CMP_MODES.map((m) => ({ value: m.value, label: m.label }))}
              value={cmpMode}
              onChange={(v) => {
                const mode = v as ComparisonMode;
                onChange({ comparison: mode === 'none' ? undefined : { mode, display: cmpDisplay } });
              }}
            />
            {cmpMode !== 'none' && (
              <div className="mt-2">
                <Segmented
                  options={CMP_DISPLAY.map((d) => ({ value: d.value, label: d.label }))}
                  value={cmpDisplay}
                  onChange={(v) => onChange({ comparison: { mode: cmpMode, display: v as ComparisonDisplay } })}
                />
              </div>
            )}
          </Field>
        )}

        {showTarget && (
          <label className="mt-4 block">
            <span className="text-2xs tracking-wide text-muted-foreground">Целевой уровень</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={config.target?.type === 'fixed' && config.target.value != null ? config.target.value : ''}
              placeholder="нет"
              onChange={(e) => {
                const raw = e.target.value.trim();
                const num = raw === '' ? undefined : Number(raw);
                onChange({ target: num !== undefined && Number.isFinite(num) && num > 0 ? { type: 'fixed', value: num } : undefined });
              }}
              className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
          </label>
        )}

        {filterDims.length > 0 && (
          <Field label="Фильтр">
            <FilterBuilder
              dims={filterDims}
              filters={config.filters ?? []}
              onChange={(filters) => onChange({ filters: filters.length ? filters : undefined })}
            />
          </Field>
        )}

        <SourceField config={config} onChange={onChange} />

        <label className="mt-4 block">
          <span className="text-2xs tracking-wide text-muted-foreground">Заголовок</span>
          <input
            value={config.title ?? ''}
            placeholder={metric.label}
            onChange={(e) => onChange({ title: e.target.value || undefined })}
            className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </label>

        <Field label="Размер">
          <Segmented
            options={SIZES.map((s) => ({ value: s.value, label: s.label }))}
            value={config.size ?? 'half'}
            onChange={(v) => onChange({ size: v as WidgetSize })}
          />
        </Field>

        {/* Accent + tinted background → config.style. */}
        <div className="mt-4">
          <span className="text-2xs tracking-wide text-muted-foreground">Акцент</span>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              aria-label="Стандартный акцент"
              aria-pressed={!config.style?.color}
              onClick={() => onChange({ style: { ...config.style, color: undefined } })}
              className={`h-5 w-5 rounded-full transition-shadow ${!config.style?.color ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: 'hsl(var(--primary))' }}
            />
            {SWATCHES.map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Акцент ${n}`}
                aria-pressed={config.style?.color === n}
                onClick={() => onChange({ style: { ...config.style, color: n } })}
                className={`h-5 w-5 rounded-full transition-shadow ${config.style?.color === n ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
                style={{ backgroundColor: `hsl(var(--chart-${n}))` }}
              />
            ))}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={!!config.style?.tinted}
          onClick={() => onChange({ style: { ...config.style, tinted: config.style?.tinted ? undefined : true } })}
          className="mt-4 flex w-full items-center justify-between gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>Цветной фон</span>
          <span
            aria-hidden="true"
            className={
              config.style?.tinted
                ? 'rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary'
                : 'rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground'
            }
          >
            {config.style?.tinted ? 'вкл' : 'выкл'}
          </span>
        </button>

        <div className="mt-5 flex items-center justify-between border-t border-border pt-3">
          <button type="button" onClick={reset} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
            Сбросить
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-pill bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Готово
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <span className="text-2xs tracking-wide text-muted-foreground">{label}</span>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** A bounded segmented control (steep's Explore segments). */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-border">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`flex-1 border-r border-border px-2 py-1.5 text-xs font-medium transition-colors last:border-r-0 ${
              active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Per-dimension filter chips (S7): each dimension shows include/exclude + selectable value chips.
 *  A dimension with no selected values contributes no filter (an empty filter list clears it). */
function FilterBuilder({
  dims,
  filters,
  onChange,
}: {
  dims: DimensionDef[];
  filters: WidgetFilter[];
  onChange: (filters: WidgetFilter[]) => void;
}) {
  const setDim = (dimId: string, op: FilterOp, values: string[]) => {
    const others = filters.filter((f) => f.dimensionId !== dimId);
    onChange(values.length ? [...others, { dimensionId: dimId, op, values }] : others);
  };
  return (
    <div className="space-y-3">
      {dims.map((dim) => {
        const f = filters.find((x) => x.dimensionId === dim.id);
        const op: FilterOp = f?.op === 'not_in' ? 'not_in' : 'in';
        const selected = new Set((f?.values ?? []).map(String));
        const toggle = (v: string) => {
          const next = new Set(selected);
          if (next.has(v)) next.delete(v);
          else next.add(v);
          setDim(dim.id, op, [...next]);
        };
        return (
          <div key={dim.id}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-2xs font-medium tracking-wide text-muted-foreground">{dim.label}</span>
              {selected.size > 0 && (
                <div role="group" aria-label={`Режим фильтра «${dim.label}»`} className="flex overflow-hidden rounded border border-border">
                  {(['in', 'not_in'] as FilterOp[]).map((o) => (
                    <button
                      key={o}
                      type="button"
                      aria-pressed={op === o}
                      onClick={() => setDim(dim.id, o, [...selected])}
                      className={`px-1.5 py-0.5 text-2xs font-medium transition-colors ${
                        op === o ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                      } border-r border-border last:border-r-0`}
                    >
                      {o === 'in' ? 'Вкл' : 'Искл'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dim.values.map((v) => {
                const on = selected.has(v);
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(v)}
                    className={`rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors ${
                      on ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {v}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** «Источник» — pin the widget to a fixed channel (default: follow the switcher). IG-only sources
 *  are excluded (the catalogue is TG-data widgets until S11 wires IG resolution). */
function SourceField({ config, onChange }: { config: WidgetConfig; onChange: (patch: Partial<WidgetConfig>) => void }) {
  const channels = useChannels();
  const list = (channels.data?.channels ?? []).filter((c) => c.source !== 'ig');
  return (
    <label className="mt-4 block">
      <span className="text-2xs tracking-wide text-muted-foreground">Источник</span>
      <select
        value={config.source ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange({ source: v === '' ? undefined : Number(v) });
        }}
        className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
      >
        <option value="">Как в свитчере</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title || (c.username ? `@${c.username}` : `Канал ${c.id}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
