import { Link, useOutletContext } from 'react-router-dom';
import { fmt } from '@/lib/format';
import { pctDelta } from '@/lib/delta';
import { pairDelta } from '@/lib/igMetrics';
import type { IgData } from '@/lib/useIgData';
import { KpiHero, KpiCard } from '@/components/instagram/shared';
import { InsightsBlock } from '@/components/instagram/insights';
import { TopPostsBlock } from '@/components/instagram/content';
import { IgDataHealth } from '@/components/instagram/health';

/**
 * IG Обзор — the focused summary, mirroring the Telegram Overview: a KPI hero (Охват, a real daily
 * series) + a 4-cell ledger, then the strongest takeaways alongside data-health, then a compact
 * top-posts strip with a link into the Контент view. One screen, no anchor soup.
 */
export function IgOverview() {
  const ig = useOutletContext<IgData>();
  const erTrend =
    ig.pairs.reach.hasCur && ig.pairs.reach.hasPrev && ig.erReachPrev > 0
      ? pctDelta(ig.erReach, ig.erReachPrev)
      : null;

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-border">
        <KpiHero
          label={`Охват · ${ig.window.days} дн.`}
          value={fmt.short(ig.pairs.reach.cur)}
          delta={pairDelta(ig.pairs.reach)}
          series={ig.series.reach.filter((p) => ig.inWindow(p.day))}
        />
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
          <KpiCard label="Подписчики" value={fmt.num(ig.followers)} trend={pairDelta(ig.pairs.follower)} />
          <KpiCard label="Просмотры" value={fmt.short(ig.pairs.views.cur)} trend={pairDelta(ig.pairs.views)} />
          <KpiCard label="Вовлечённость" value={ig.erReach > 0 ? `${ig.erReach.toFixed(2)}%` : '—'} trend={erTrend} />
          <KpiCard label="Взаимодействия" value={fmt.short(ig.pairs.ti.cur)} trend={pairDelta(ig.pairs.ti)} />
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-border pt-8 lg:grid-cols-2 lg:gap-12">
        <div className="space-y-4">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Главное</h2>
          <InsightsBlock insights={ig.insights} limit={2} />
        </div>
        <IgDataHealth accountName={ig.profile?.username} lastSync={ig.lastSync} isMock={ig.isMock} />
      </div>

      <section className="mt-8 space-y-4 border-t border-border pt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Топ публикаций</h2>
          <Link to="/instagram/content" className="shrink-0 text-[13px] font-medium text-primary hover:underline">
            Открыть контент →
          </Link>
        </div>
        <TopPostsBlock posts={ig.posts} limit={3} showSort={false} />
      </section>
    </div>
  );
}
