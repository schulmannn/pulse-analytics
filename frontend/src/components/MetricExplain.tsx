import { InfoTooltip } from '@/components/InfoTooltip';
import { explainRows, metricLabel } from '@/lib/metricExplain';
import type { WidgetMeta } from '@/lib/resolveWidgetMetric';

/**
 * «Почему это число такое» — metric explainability (Data-quality / trust). One pure builder
 * ({@link explainRows}) feeds two surfaces: a compact ⓘ tooltip on the card and a full inline panel
 * in the detail / explorer. Especially load-bearing for the derived metrics whose number is easy to
 * mistrust — ERV, viral rate, net followers, and any hidden comparison.
 */

/**
 * Full inline panel for the detail / explorer surface: a definition list of the metric's
 * explainability, mirroring the metric page's «О метрике» block but enriched with the live
 * period / sample / freshness / comparison facts.
 */
export function MetricExplainPanel({
  metricId,
  meta,
  className = '',
}: {
  metricId?: string;
  meta?: WidgetMeta;
  className?: string;
}) {
  const rows = explainRows(metricId, meta);
  if (rows.length === 0) return null;
  return (
    <div className={className}>
      <div className="mb-2 text-2xs font-medium tracking-wider text-muted-foreground">Почему это число такое</div>
      <dl className="space-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3">
            <dt className="w-28 shrink-0 text-muted-foreground">{r.label}</dt>
            <dd className={`min-w-0 ${r.warn ? 'text-status-warn' : 'text-foreground'}`}>{r.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Compact ⓘ affordance for the card: the same rows inside the shared (portaled, a11y) InfoTooltip,
 * so the explanation is one hover/tap away without stealing tile space. Renders nothing when the
 * metric has no catalogue definition (legacy widgets) and no resolved meta.
 */
export function MetricExplainTooltip({ metricId, meta }: { metricId?: string; meta?: WidgetMeta }) {
  const rows = explainRows(metricId, meta);
  if (rows.length === 0) return null;
  return (
    <InfoTooltip title={metricLabel(metricId)}>
      <span className="block space-y-1 text-muted-foreground">
        {rows.map((r) => (
          <span key={r.label} className="block">
            <span className={r.warn ? 'text-status-warn' : 'text-foreground'}>{r.label}:</span> {r.text}
          </span>
        ))}
      </span>
    </InfoTooltip>
  );
}
