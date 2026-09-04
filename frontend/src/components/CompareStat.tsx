import type { ReactNode } from 'react';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import { DeltaPill, deltaLabel } from '@/components/DeltaPill';
import type { MetricDelta } from '@/lib/delta';

/**
 * Compact, non-temporal metric bodies retained for aggregate surfaces. The Telegram and Instagram
 * third-width Overview cards now use active-window sparklines instead.
 * An aggregate metric leads with its number + delta and then a period-over-period read: two bars
 * (this window vs the previous equal-length one) for a single value, or a stacked composition bar
 * for an additive metric. Honest by construction: no previous → no bars and no fake delta; missing
 * value → «—».
 *
 * Colours are neutral by rule — the current bar is a quiet foreground fill, the previous a muted
 * one; identity hues drive only the composition segments. Green/red stay reserved for the DeltaPill.
 */

/**
 * ГОЛОВА S-КАРТОЧКИ — число и дельта на ОДНОЙ базовой линии, слева. Опциональная
 * кнопка разбора несёт общеприложенческую a11y-подпись «Разбор: …».
 *
 * СЛОТ ДЕЛЬТЫ ДЕРЖИТСЯ ВСЕГДА (аудит #554, D9). Раньше «Ср. охват» печатал голое
 * число (пары окон нет → DeltaPill отдавал null), а соседние «Реакции» — число со стрелкой:
 * две карточки одного размера в одном ряду читались как карточки разных типов. Теперь слот говорит
 * всегда и говорит честно: «0%» — сравнили и изменений нет, «— к пред.» — сравнивать НЕ С ЧЕМ.
 * Сам DeltaPill не трогаем: его молчание на flat — канон для разбора и таблиц сравнения.
 *
 * `deltaText` — честные «п.п.» там, где относительный процент от процента был бы ложью (ER); выигрывает у пилюли.
 */
export function CompactStatHeadline({
  text,
  delta,
  deltaText,
  onDrill,
  drillLabel,
  live,
}: {
  text: string;
  delta?: MetricDelta | null;
  deltaText?: string | null;
  onDrill?: () => void;
  drillLabel?: string;
  live: boolean;
}) {
  const quiet = 'shrink-0 text-xs font-medium tabular-nums text-muted-foreground';
  return (
    <div className="flex items-baseline gap-2">
      <KpiValue
        text={text}
        onDrill={onDrill && live ? onDrill : undefined}
        drillLabel={drillLabel}
      />
      {live ? (
        deltaText ? (
          <span className={quiet}>{deltaText}</span>
        ) : deltaLabel(delta) ? (
          <DeltaPill delta={delta} />
        ) : (
          <span className={quiet}>{delta ? '0%' : '— к пред.'}</span>
        )
      ) : null}
    </div>
  );
}

/**
 * СТАТ БЕЗ ГРАФИКА — та же анатомия, что у соседей по ряду: число и дельта одной строкой
 * слева, внизу — одна пояснительная строка вместо искры.
 *
 * БЫЛО ЦЕНТРИРОВАНИЕ (референс владельца, 2026-08-14): крупный процент по центру тела,
 * строкой ниже — сравнение с прошлым периодом. Аудит #554 (D9) снял его: три соседние
 * карточки одного размера держали три разные оси выравнивания, и ряд читался как три разные
 * карточки вместо одной семьи. Всё остальное из того решения цело: графика здесь по-прежнему
 * нет, дельта ER остаётся в честных «п.п.», пояснение стоит внизу тем же тихим набором.
 */
export function StackedStat({
  text,
  delta,
  deltaText,
  onDrill,
  drillLabel,
  live,
  note,
}: {
  text: string;
  delta?: MetricDelta | null;
  deltaText?: string | null;
  onDrill?: () => void;
  drillLabel?: string;
  live: boolean;
  note?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4">
      <CompactStatHeadline
        text={text}
        delta={delta}
        deltaText={live ? deltaText : null}
        onDrill={onDrill}
        drillLabel={drillLabel}
        live={live}
      />
      {note ? <p className="text-2xs leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** One horizontal comparison bar — label · track · formatted value. */
function CompareBar({
  label,
  value,
  max,
  format,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  format: (n: number) => string;
  tone: 'current' | 'previous';
}) {
  const width = max > 0 && value > 0 ? Math.max(3, (value / max) * 100) : 0;
  const fill = tone === 'previous' ? 'bg-muted-foreground/30' : '';
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-2xs tracking-wide text-muted-foreground">{label}</span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/50">
        <div
          className={`h-full rounded-full ${fill}`}
          style={{
            width: `${width}%`,
            backgroundColor: tone === 'current' ? 'hsl(var(--chart-role-primary))' : undefined,
          }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-xs font-medium tabular-nums text-foreground">{format(value)}</span>
    </div>
  );
}

export interface CompareStatProps {
  /** Current-window value; render «—» when absent. */
  value: number | null;
  /** Previous equal-length window value; null → no comparison bars, no fake delta. */
  prev: number | null;
  delta?: MetricDelta | null;
  format: (n: number) => string;
  onDrill?: () => void;
  drillLabel?: string;
  /** False marks a metric with no live data this window (sparse / unavailable) → «—». */
  hasValue?: boolean;
  /** Row label for the current bar (default «Период»). */
  currentLabel?: string;
}

export function CompareStat({ value, prev, delta, format, onDrill, drillLabel, hasValue = true, currentLabel = 'Период' }: CompareStatProps) {
  const live = hasValue && value != null && Number.isFinite(value);
  const bars = live && prev != null && Number.isFinite(prev) && prev >= 0;
  const max = bars ? Math.max(value as number, prev as number) : 0;
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4">
      <CompactStatHeadline text={live ? format(value as number) : '—'} delta={bars ? delta : null} onDrill={onDrill} drillLabel={drillLabel} live={live} />
      {bars ? (
        <div className="space-y-2.5">
          <CompareBar label={currentLabel} value={value as number} max={max} format={format} tone="current" />
          <CompareBar label="Пред." value={prev as number} max={max} format={format} tone="previous" />
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          {live ? 'Нет данных за предыдущий период для сравнения.' : 'Нет данных за период.'}
        </p>
      )}
    </div>
  );
}

export interface CompositionPart {
  label: string;
  value: number;
  /** CSS colour for this segment/dot (a stable metric-identity hue). */
  color: string;
}

export interface CompositionStatProps {
  /** Total for the headline (e.g. all interactions). Render «—» when absent. */
  total: number | null;
  delta?: MetricDelta | null;
  /** Additive parts that make up the total; empty → falls back to a bare headline. */
  parts: CompositionPart[];
  format: (n: number) => string;
  onDrill?: () => void;
  drillLabel?: string;
  hasValue?: boolean;
  /** Optional note under the headline when there is no breakdown to show. */
  emptyNote?: ReactNode;
}

/** Additive metric as a stacked composition bar + legend (e.g. IG interactions = likes + comments
    + saves + shares). Segments use stable identity hues; the headline carries the total + delta. */
export function CompositionStat({ total, delta, parts, format, onDrill, drillLabel, hasValue = true, emptyNote }: CompositionStatProps) {
  const live = hasValue && total != null && Number.isFinite(total);
  const sum = parts.reduce((acc, p) => acc + (Number.isFinite(p.value) ? p.value : 0), 0);
  const showBar = live && parts.length > 0 && sum > 0;
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4">
      <CompactStatHeadline text={live ? format(total as number) : '—'} delta={delta} onDrill={onDrill} drillLabel={drillLabel} live={live} />
      {showBar ? (
        <div className="space-y-3">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/50">
            {parts.map((p) => (
              <div
                key={p.label}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${(p.value / sum) * 100}%`, background: p.color }}
                title={`${p.label}: ${format(p.value)}`}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {parts.map((p) => (
              <div key={p.label} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="min-w-0 truncate">{p.label}</span>
                <span className="ml-auto shrink-0 font-medium tabular-nums text-foreground">{format(p.value)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">{live ? emptyNote ?? 'Разбивка недоступна за период.' : 'Нет данных за период.'}</p>
      )}
    </div>
  );
}
