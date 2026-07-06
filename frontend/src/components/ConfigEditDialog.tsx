import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useChannels } from '@/api/queries';
import { WidgetBody } from '@/components/ConfigWidget';
import { ChannelScope } from '@/lib/channel-context';
import { ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { DEFAULT_WIDGET_DAYS } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { VIZ_LABEL } from '@/lib/widgetRender';
import { getMetric, metricsForSource } from '@/lib/widgetMetrics';
import { channelsForSource } from '@/lib/channelSource';
import { editorSpec, type EditorSpec } from '@/lib/widgetCapabilities';
import type { WidgetSize } from '@/components/ChartWidget';
import type { DimensionDef } from '@/lib/dimensions';
import type { ComparisonDisplay, ComparisonMode, FilterOp, TargetType, WidgetConfig, WidgetFilter, WidgetGrain } from '@/lib/widgetConfig';

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
  { value: 'same_period_last_month', label: 'Прошлый месяц' },
  { value: 'same_period_last_year', label: 'Год назад' },
  { value: 'same_weekday', label: 'День недели' },
  { value: 'moving_average', label: 'Скольз. среднее' },
];

// One-line «против чего сравниваем» — surfaced under the mode selector so the baseline (and why the
// number differs) is explained inline, not guessed from the label.
const CMP_DESCRIPTION: Partial<Record<ComparisonMode, string>> = {
  previous_period: 'База — предыдущее окно той же длины.',
  same_period_last_month: 'База — то же окно месяцем ранее.',
  same_period_last_year: 'База — то же окно год назад.',
  same_weekday: 'Каждый день — против типичного значения этого дня недели в окне (нужна дневная гранулярность).',
  moving_average: 'Призрачная линия — скользящее среднее ряда (тренд / run-rate).',
};

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
  onChange,
  onClose,
}: {
  config: WidgetConfig;
  onChange: (patch: Partial<WidgetConfig>) => void;
  onClose: () => void;
}) {
  const spec = editorSpec(config);
  // Modal focus contract (like PostDetailModal/DetailShell): move focus in, trap Tab, restore the
  // opener on close — without it aria-modal hides content the keyboard is actually walking.
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
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

  const reset = () =>
    onChange({
      viz: getMetric(config.metricId)?.defaultViz ?? 'kpi',
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
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`Настройка виджета «${config.title || spec.label}»`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto grid w-full max-w-3xl grid-cols-1 gap-5 rounded-xl border border-border bg-card p-5 focus:outline-none sm:grid-cols-[minmax(0,1fr)_300px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left — live preview: the SAME body the card shows, over the config being edited, so every
            change is seen before it's committed (edits already write through to the store). */}
        <div className="min-w-0">
          <div className="mb-2 text-sm font-medium text-foreground">Предпросмотр</div>
          <div className="flex h-[280px] flex-col overflow-hidden rounded-xl border border-border bg-card p-4">
            <div className="truncate text-xs font-medium tracking-wider text-muted-foreground">
              {config.title || spec.label}
            </div>
            <div className="mt-3 min-h-0 flex-1">
              <ExpandedChartHeightContext.Provider value={null}>
                {config.source != null ? (
                  <ChannelScope channelId={config.source}>
                    <WidgetBody config={config} />
                  </ChannelScope>
                ) : (
                  <WidgetBody config={config} />
                )}
              </ExpandedChartHeightContext.Provider>
            </div>
          </div>
        </div>

        {/* Right — controls + actions. */}
        <div className="flex max-h-[70vh] min-w-0 flex-col">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-sm font-medium text-foreground">Настройка виджета</div>
            <div className="truncate text-xs text-muted-foreground">{spec.label}</div>
          </div>
          <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
            <WidgetConfigControls config={config} spec={spec} onChange={onChange} />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
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
      </div>
    </div>,
    document.body,
  );
}

/**
 * The reusable metric-builder control body — every field (visualisation / period / grain / comparison
 * / target / filter / source / title / size / accent / background), gated by the metric's shape.
 * Shared by the edit dialog (writes a stored config) and the create dialog (writes a local draft), so
 * both feel like one editor. Header + Reset/Done chrome stays with each dialog wrapper.
 */
export function WidgetConfigControls({
  config,
  spec,
  onChange,
}: {
  config: WidgetConfig;
  spec: EditorSpec;
  onChange: (patch: Partial<WidgetConfig>) => void;
}) {
  const cap = spec.capabilities;
  const cmpMode: ComparisonMode = config.comparison?.mode ?? 'none';
  const cmpDisplay: ComparisonDisplay = config.comparison?.display ?? 'ghost_line';

  return (
    <>
      {/* Visualisation — the control when the widget supports switching (>1 option), else a disabled
          hint (steep: the vocabulary stays visible with a reason). */}
      {cap.viz && spec.supportedViz.length > 1 ? (
        <Field label="Визуализация">
          <Segmented
            options={spec.supportedViz.map((v) => ({ value: v, label: VIZ_LABEL[v] }))}
            value={config.viz}
            onChange={(viz) => onChange({ viz })}
          />
        </Field>
      ) : (
        spec.disabledReasons?.viz && <DisabledField label="Визуализация" reason={spec.disabledReasons.viz} />
      )}

      <Field label="Период">
        <Segmented
          options={PERIODS.map((p) => ({ value: String(p.days), label: p.label }))}
          value={String(config.period ?? DEFAULT_WIDGET_DAYS)}
          onChange={(v) => onChange({ period: Number(v) as PeriodDays })}
        />
      </Field>

      {cap.grain ? (
        <Field label="Грануляция">
          <Segmented
            options={GRAINS.map((g) => ({ value: g.value, label: g.label }))}
            value={config.grain ?? 'day'}
            onChange={(v) => onChange({ grain: v as WidgetGrain })}
          />
        </Field>
      ) : (
        spec.disabledReasons?.grain && <DisabledField label="Грануляция" reason={spec.disabledReasons.grain} />
      )}

      {cap.comparison ? (
        <Field label="Сравнение">
          <Segmented
            options={CMP_MODES.map((m) => ({ value: m.value, label: m.label }))}
            value={cmpMode}
            onChange={(v) => {
              const mode = v as ComparisonMode;
              onChange({ comparison: mode === 'none' ? undefined : { mode, display: cmpDisplay } });
            }}
          />
          {CMP_DESCRIPTION[cmpMode] && (
            <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">{CMP_DESCRIPTION[cmpMode]}</p>
          )}
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
      ) : (
        spec.disabledReasons?.comparison && <DisabledField label="Сравнение" reason={spec.disabledReasons.comparison} />
      )}

      {cap.target ? (
        <TargetField config={config} onChange={onChange} />
      ) : (
        spec.disabledReasons?.target && <DisabledField label="Цель" reason={spec.disabledReasons.target} />
      )}

      {cap.filter && spec.filterDims.length > 0 ? (
        <Field label="Фильтр">
          <FilterBuilder
            dims={spec.filterDims}
            filters={config.filters ?? []}
            onChange={(filters) => onChange({ filters: filters.length ? filters : undefined })}
          />
        </Field>
      ) : (
        spec.disabledReasons?.filter && <DisabledField label="Фильтр" reason={spec.disabledReasons.filter} />
      )}

      <SourceField config={config} onChange={onChange} />

      <label className="mt-4 block">
        <span className="text-2xs tracking-wide text-muted-foreground">Заголовок</span>
        <input
          value={config.title ?? ''}
          placeholder={spec.label}
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
    </>
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

/** A control the current metric doesn't support — shown greyed with the reason rather than silently
 *  omitted, so the full control vocabulary stays visible and the user learns WHY it is off (steep). */
function DisabledField({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="mt-4 opacity-55" aria-disabled="true">
      <span className="text-2xs tracking-wide text-muted-foreground">{label}</span>
      <p className="mt-1 text-2xs italic text-muted-foreground">Недоступно · {reason}</p>
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

/** «Цель» (S9): a fixed goal value or a dynamic goal = another metric's current value. Forecast is a
 *  follow-up. «Нет» clears it. The card draws a goal line + «N% от цели» progress. */
const TARGET_TYPES: Array<{ value: 'none' | TargetType; label: string }> = [
  { value: 'none', label: 'Нет' },
  { value: 'fixed', label: 'Число' },
  { value: 'dynamic', label: 'Метрика' },
];

function TargetField({ config, onChange }: { config: WidgetConfig; onChange: (patch: Partial<WidgetConfig>) => void }) {
  const metric = getMetric(config.metricId);
  const type: 'none' | TargetType = config.target?.type ?? 'none';
  // Dynamic target candidates: same-source scalar metrics (value/series carry a valueRaw), not self.
  const candidates = metric
    ? metricsForSource(metric.source === 'ig' ? 'ig' : 'tg').filter(
        (m) => (m.kind === 'value' || m.kind === 'series') && m.id !== metric.id,
      )
    : [];
  return (
    <Field label="Цель">
      <Segmented
        options={TARGET_TYPES}
        value={type}
        onChange={(t) => {
          if (t === 'none') onChange({ target: undefined });
          else if (t === 'fixed') onChange({ target: { type: 'fixed', value: config.target?.value } });
          else onChange({ target: { type: 'dynamic', metricId: config.target?.metricId ?? candidates[0]?.id } });
        }}
      />
      {type === 'fixed' && (
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={config.target?.value != null ? config.target.value : ''}
          placeholder="значение цели"
          onChange={(e) => {
            const raw = e.target.value.trim();
            const num = raw === '' ? undefined : Number(raw);
            onChange({ target: { type: 'fixed', value: num !== undefined && Number.isFinite(num) && num > 0 ? num : undefined } });
          }}
          className="mt-2 w-full rounded border border-border bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
        />
      )}
      {type === 'dynamic' && (
        <select
          value={config.target?.metricId ?? ''}
          onChange={(e) => onChange({ target: { type: 'dynamic', metricId: e.target.value || undefined } })}
          className="mt-2 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
        >
          {candidates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </Field>
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
  // Scope the source list to the METRIC's network so an Instagram metric never lists Telegram
  // channels (and vice-versa) — the same rule as the source switcher. Legacy composites carry no
  // MetricDef and are Telegram, so anything that isn't an IG metric is treated as 'tg' (mirrors the
  // metric-picker narrowing above).
  const source = getMetric(config.metricId)?.source === 'ig' ? 'ig' : 'tg';
  const list = channelsForSource(channels.data?.channels ?? [], source);
  const igEmpty = source === 'ig' && list.length === 0;
  // A pin left from before source-aware filtering (e.g. a Telegram channel on an IG widget) is no
  // longer eligible; surface it as a disabled option so the value still round-trips and the mismatch
  // is visible, instead of the <select> silently showing a blank/wrong row.
  const pinned = config.source ?? null;
  const stalePin = pinned != null && !list.some((c) => c.id === pinned);
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
        {stalePin && (
          <option value={pinned} disabled>
            Недоступный источник — сменить
          </option>
        )}
      </select>
      {igEmpty && (
        <p className="mt-1 text-2xs text-muted-foreground">
          Нет подключённых аккаунтов Instagram — источник берётся из свитчера. Подключите в разделе «Источники».
        </p>
      )}
    </label>
  );
}
