import { fmt } from '@/lib/format';
import { DeltaPill } from '@/components/DeltaPill';
import { Card, CardContent } from '@/components/ui/card';
import { pairDelta, type WindowPair } from '@/lib/igMetrics';
import type { IgInsight } from '@/lib/igInsights';

/** Auto-insights as analyst notes: a tone dot, the takeaway, the numbers behind it, and how sure
    we are. `limit` lets the Overview surface just the single strongest insight. */
export function InsightsBlock({ insights, limit }: { insights: IgInsight[]; limit?: number }) {
  const list = limit ? insights.slice(0, limit) : insights;
  if (list.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Недостаточно данных для выводов.
        </CardContent>
      </Card>
    );
  }
  const dot = (t: IgInsight['tone']) => (t === 'up' ? 'bg-verdant' : t === 'down' ? 'bg-ember' : 'bg-primary');
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
      {list.map((ins, i) => (
        <div key={i} className="flex items-start gap-3 bg-background p-4">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot(ins.tone)}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium leading-relaxed text-foreground">{ins.text}</p>
            {ins.evidence && <p className="mt-1 text-xs tabular-nums text-muted-foreground">{ins.evidence}</p>}
            {/* Surface confidence only when it's a caveat — a quiet "мало данных", never a boast. */}
            {ins.confidence === 'low' && (
              <span className="mt-2 inline-block rounded-full bg-status-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
                мало данных
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Period-over-period comparison — the honest way to show Instagram aggregate metrics (views /
    saves / likes / shares) that arrive as current-vs-previous totals, not a daily series. */
export function PeriodCompareBlock({ rows }: { rows: { label: string; pair: WindowPair }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
            <th className="p-4">Метрика</th>
            <th className="p-4 text-right">Текущий</th>
            <th className="p-4 text-right">Предыдущий</th>
            <th className="p-4 text-right">Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.label} className="hover:bg-hover-row">
              <td className="p-4 text-muted-foreground">{r.label}</td>
              <td className="p-4 text-right font-medium tabular-nums">{fmt.short(r.pair.cur)}</td>
              <td className="p-4 text-right tabular-nums text-muted-foreground">
                {r.pair.hasPrev ? fmt.short(r.pair.prev) : '—'}
              </td>
              <td className="p-4 text-right">
                <span className="inline-flex justify-end">
                  <DeltaPill delta={pairDelta(r.pair)} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
