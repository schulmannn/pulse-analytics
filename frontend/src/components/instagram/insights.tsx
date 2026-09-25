import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DeltaPill } from '@/components/DeltaPill';
import { EmptyState } from '@/components/EmptyState';
import { pairDelta, type WindowPair } from '@/lib/igMetrics';
import type { IgInsight } from '@/lib/igInsights';

/** One insight as an analyst note: tone dot, takeaway, the numbers, and a quiet confidence caveat.
    `boxed` = a ledger cell (multi-insight grid); `dense` = a row of the single-column list (узкий
    тайл); без обоих — плоская заметка одиночного инсайта. */
function InsightItem({ ins, boxed, dense }: { ins: IgInsight; boxed?: boolean; dense?: boolean }) {
  const dot = ins.tone === 'up' ? 'bg-verdant' : ins.tone === 'down' ? 'bg-ember' : 'bg-primary';
  return (
    <div
      className={cn(
        'flex items-start gap-3',
        boxed && 'bg-background p-4',
        // Строка списка ДЕЛИТ высоту тайла поровну (flex-1) и клипается: длина инсайта — величина
        // непредсказуемая (текст+доказательство переносятся на узком тайле), а высота 264px задана
        // жёстко. Перенос переполняет тайл внутренним скроллом — это прямой запрет доски.
        dense && 'min-h-0 flex-1 overflow-hidden py-2 first:pt-0 last:pb-0',
      )}
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0">
        <p className={cn('text-sm font-medium leading-relaxed text-foreground', dense && 'line-clamp-2')}>{ins.text}</p>
        {ins.evidence && (
          <p className={cn('mt-1 text-xs tabular-nums text-muted-foreground', dense && 'line-clamp-2')}>{ins.evidence}</p>
        )}
        {/* Surface confidence only when it's a caveat — a quiet "мало данных", never a boast. */}
        {ins.confidence === 'low' && (
          <span className="mt-2 inline-block rounded-full bg-status-warn/15 px-1.5 py-0.5 text-2xs font-medium text-status-warn">
            мало данных
          </span>
        )}
      </div>
    </div>
  );
}

/** Auto-insights as analyst notes. `limit` caps the list; `variant` picks the shape. «auto»: один
    инсайт — плоская заметка, два и больше — хайрлайн-леджер в две колонки (широкие карточки).
    «list» — одна колонка строк, делящих высоту фикс-тайла поровну: в 264px половинной карточки
    две колонки рубят фразу пополам, а строки держат и текст, и цифры под ним. Больше ДВУХ строк
    в такой тайл не ставить: замерено на демо-данных — три строки переполняют тело на узком тайле
    (мобильный 398px: +35px; десктопный 1024–1152: 335–399px, +28px) и идут впритык даже на 1440.
    Полный список — карточкой «Главное» в Аналитике: она во всю ширину и по высоте свободна. */
export function InsightsBlock({
  insights,
  limit,
  variant = 'auto',
}: { insights: IgInsight[]; limit?: number; variant?: 'auto' | 'list' }) {
  const list = limit ? insights.slice(0, limit) : insights;
  if (list.length === 0) {
    return <EmptyState title="Недостаточно данных для выводов." />;
  }
  if (variant === 'list') {
    return (
      <div className="flex h-full flex-col divide-y divide-border">
        {list.slice(0, 2).map((ins, i) => (
          <InsightItem key={i} ins={ins} dense />
        ))}
      </div>
    );
  }
  if (list.length === 1) {
    return <InsightItem ins={list[0]} />;
  }
  return (
    <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2">
      {list.map((ins, i) => (
        <InsightItem key={i} ins={ins} boxed />
      ))}
    </div>
  );
}

/** Period-over-period comparison — the honest way to show Instagram aggregate metrics (views /
    saves / likes / shares) that arrive as current-vs-previous totals, not a daily series. */
export function PeriodCompareBlock({ rows }: { rows: { label: string; pair: WindowPair }[] }) {
  return (
    <div className="data-table-surface data-table-scroll">
      <table className="data-table text-left text-sm">
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
            <tr key={r.label} className="transition-colors hover:bg-hover-row">
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
