import { EmptyState } from '@/components/EmptyState';
import { NetworkBadge } from '@/components/campaigns/shared';
import { fmt } from '@/lib/format';
import type { SourceLeaderRow } from '@/lib/campaignPageModel';

/** Ranked campaign sources; each bar is normalized inside its own platform methodology. */
export function CampaignSourceLeaderboard({ leaders }: { leaders: SourceLeaderRow[] }) {
  if (leaders.length === 0) return <EmptyState compact size="chart" title="Нет источников." />;
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {leaders.map((source) => (
        <div key={source.key} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
          <div className="flex items-center gap-2">
            <NetworkBadge network={source.network} />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{source.label}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {fmt.num(source.posts)} публ.
            </span>
            <span className="w-16 text-right text-xs font-medium tabular-nums text-foreground">
              {source.metricText}
            </span>
          </div>
          {source.share != null && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/60"
                  style={{ width: `${Math.max(2, Math.round(source.share * 100))}%` }}
                />
              </div>
              <span className="w-9 text-right text-2xs tabular-nums text-muted-foreground">
                {Math.round(source.share * 100)}%
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
