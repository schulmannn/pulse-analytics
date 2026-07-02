import { useTgFull, useTgGraphs, useHistory, useVelocity } from '@/api/queries';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { usePeriod } from '@/lib/period';
import { dailyWindowDelta, subscriberChange } from '@/lib/delta';
import { markdownToPlainText } from '@/lib/markdown';
import { buildTgInsights, type TgInsight } from '@/lib/tgInsights';
import { Skeleton } from '@/components/ui/skeleton';

const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WD_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Highest-lift hashtag (used ≥2×) by per-post ERV vs the channel's average ERV. */
function topHashtagLift(posts: NormalizedPost[]): { tag: string; lift: number } | null {
  const withReach = posts.filter((p) => p.reach > 0 && p.erv != null);
  if (withReach.length === 0) return null;
  const globalErv = withReach.reduce((s, p) => s + (p.erv as number), 0) / withReach.length;
  if (globalErv <= 0) return null;
  const map = new Map<string, { sum: number; n: number }>();
  for (const p of withReach) {
    for (const raw of new Set(p.hashtags.map((t) => t.toLowerCase().replace(/^#/, '')))) {
      if (!raw) continue;
      const e = map.get(raw) ?? { sum: 0, n: 0 };
      e.sum += p.erv as number;
      e.n += 1;
      map.set(raw, e);
    }
  }
  let best: { tag: string; lift: number } | null = null;
  for (const [tag, e] of map) {
    if (e.n < 2) continue;
    const lift = ((e.sum / e.n - globalErv) / globalErv) * 100;
    if (!best || lift > best.lift) best = { tag: `#${tag}`, lift };
  }
  return best;
}

/**
 * Actionable auto-insights for Telegram: each is a statement → why → action, with a concrete
 * evidence post where relevant. Pure rule engine (lib/tgInsights) fed by signals gathered here.
 * Comparative insights (views/ER/subscriber Δ) need a preset window — for a custom range or
 * all-time they're skipped (no defined previous window), mirroring the KPI range-guards.
 */
export function Insights() {
  const { days, range, inRange } = usePeriod();
  const { data, isPending } = useTgFull(days);
  const { data: graphs } = useTgGraphs();
  const { data: history } = useHistory(730);
  const { data: velocity } = useVelocity();

  if (isPending) return <InsightsSkeleton />;

  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter((p) => inRange(p.date));
  const historyRows = history?.rows ?? [];
  const comparable = !range && days > 0;

  const viewsDelta = comparable ? dailyWindowDelta(historyRows, (r) => Number(r.views ?? 0), days) : null;
  const erDelta = comparable
    ? dailyWindowDelta(historyRows, (r) => Number(r.reactions ?? 0) + Number(r.forwards ?? 0), days)
    : null;
  const subChange = comparable ? subscriberChange(historyRows, days) : null;

  const eng = posts.reduce((s, p) => s + p.eng, 0);
  const er = members > 0 ? (eng / members) * 100 : null;

  // Best weekday by average reach.
  const wdViews = Array<number>(7).fill(0);
  const wdCount = Array<number>(7).fill(0);
  posts.forEach((p) => {
    if (!p.date) return;
    // UTC to match the UTC day-keys the daily charts/drill-down bucket by.
    const d = new Date(p.date).getUTCDay();
    wdViews[d] += p.reach;
    wdCount[d] += 1;
  });
  const wdAvg = WD_ORDER.map((i) => (wdCount[i] ? wdViews[i] / wdCount[i] : 0));
  const maxWd = Math.max(...wdAvg);
  const bestWeekday = maxWd > 0 ? WD_LABELS[wdAvg.indexOf(maxWd)] : null;

  // Peak hour from the MTProto top-hours graph.
  let peakHour: number | null = null;
  const th = graphs?.top_hours;
  if (th && th.values.length > 0) {
    const pi = th.values.indexOf(Math.max(...th.values));
    peakHour = th.hours[pi] ?? pi;
  }

  const topPost = posts.length > 0 ? [...posts].sort((a, b) => b.reach - a.reach)[0] : null;
  const topPostInput =
    topPost && topPost.reach > 0
      ? {
          caption: markdownToPlainText(topPost.caption) || 'без подписи',
          reach: topPost.reach,
          erv: topPost.erv,
          permalink: topPost.permalink,
        }
      : null;

  const insights = buildTgInsights({
    viewsDelta,
    subscriberChange: subChange,
    erDelta,
    er,
    bestWeekday,
    peakHour,
    velocity: { day1Share: velocity?.day1_share ?? null, t80Days: velocity?.t80_days ?? null },
    topPost: topPostInput,
    topHashtag: topHashtagLift(posts),
    postsCount: posts.length,
  });

  if (insights.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Пока недостаточно данных для инсайтов — добавьте период с историей.
      </p>
    );
  }

  // Hairline ledger (gap-px over bg-border draws the 1px dividers), matching IgInsights.
  // An odd last cell spans both columns so no empty border-coloured half-row is left behind.
  return (
    <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2">
      {insights.map((ins, i) => (
        <InsightCell
          key={i}
          insight={ins}
          spanFull={insights.length % 2 === 1 && i === insights.length - 1}
        />
      ))}
    </div>
  );
}

function InsightCell({ insight, spanFull }: { insight: TgInsight; spanFull?: boolean }) {
  const dot =
    insight.tone === 'up' ? 'bg-verdant' : insight.tone === 'down' ? 'bg-ember' : 'bg-primary';
  const ev = insight.evidence;
  const evText = ev?.caption ? (ev.caption.length > 52 ? `${ev.caption.slice(0, 52)}…` : ev.caption) : '';
  return (
    <div className={`flex items-start gap-3 bg-background p-4${spanFull ? ' sm:col-span-2' : ''}`}>
      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium leading-snug text-foreground">{insight.statement}</p>
        {insight.why && <p className="text-sm leading-snug text-muted-foreground">{insight.why}</p>}
        {insight.action && (
          <p className="text-sm leading-snug text-muted-foreground">
            <span aria-hidden="true" className="font-medium text-verdant">→ </span>
            {insight.action}
          </p>
        )}
        {ev?.permalink && evText && (
          <a
            href={ev.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs font-medium text-primary hover:underline"
            title={ev.caption}
          >
            Пример: «{evText}» →
          </a>
        )}
      </div>
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-2 bg-background p-4">
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
