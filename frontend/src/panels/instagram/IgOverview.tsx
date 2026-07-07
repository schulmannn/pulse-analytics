import { Link, useNavigate } from 'react-router-dom';
import { fmt } from '@/lib/format';
import { pctDelta } from '@/lib/delta';
import { pairDelta } from '@/lib/igMetrics';
import type { WindowPair } from '@/lib/igMetrics';
import type { IgData } from '@/lib/useIgData';

// A whole window without a single non-zero sample is «нет данных», not a real zero — the
// old render showed «0» с «↓100%» рядом с прочерками соседних ячеек (D6.1). Insights quota
// burn / missing metrics must read as a dash with no delta, never as a crash.
const isLive = (p: WindowPair) => p.hasCur && p.cur > 0;
import { KpiHero, KpiCard, signedNum } from '@/components/instagram/shared';
import { InsightsBlock } from '@/components/instagram/insights';
import { TopPostsBlock } from '@/components/instagram/content';

/**
 * IG Обзор — the focused summary, mirroring the Telegram Overview: a KPI hero (Охват, a real daily
 * series) + a 4-cell ledger, then the strongest takeaways alongside data-health, then a compact
 * top-posts strip with a link into the Контент view. One screen, no anchor soup.
 */
export function IgOverview({ ig }: { ig: IgData }) {
  const navigate = useNavigate();
  const erTrend =
    ig.erReach > 0 && ig.pairs.reach.hasCur && ig.pairs.reach.hasPrev && ig.erReachPrev > 0
      ? pctDelta(ig.erReach, ig.erReachPrev)
      : null;

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-border">
        <KpiHero
          label={`Охват · ${ig.window.days} дн.`}
          value={fmt.kpi(ig.pairs.reach.cur)}
          delta={pairDelta(ig.pairs.reach)}
          series={ig.series.reach.filter((p) => ig.inWindow(p.day))}
          drillTo="/metrics/ig-reach"
        />
        <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
          <KpiCard
            label="Подписчики"
            value={fmt.kpi(ig.followers)}
            deltaText={ig.netMovement.hasCur ? signedNum(ig.netMovement.cur) : undefined}
            deltaTone={ig.netMovement.cur > 0 ? 'up' : ig.netMovement.cur < 0 ? 'down' : 'flat'}
            onDrill={() => navigate('/metrics/ig-follows')}
          />
          <KpiCard
            label="Просмотры"
            value={isLive(ig.pairs.views) ? fmt.kpi(ig.pairs.views.cur) : '—'}
            trend={isLive(ig.pairs.views) ? pairDelta(ig.pairs.views) : null}
            onDrill={() => navigate('/metrics/ig-views')}
          />
          <KpiCard label="Вовлечённость" value={ig.erReach > 0 ? `${ig.erReach.toFixed(2)}%` : '—'} trend={erTrend} onDrill={() => navigate('/metrics/ig-er')} />
          <KpiCard
            label="Взаимодействия"
            value={isLive(ig.pairs.ti) ? fmt.kpi(ig.pairs.ti.cur) : '—'}
            trend={isLive(ig.pairs.ti) ? pairDelta(ig.pairs.ti) : null}
            onDrill={() => navigate('/metrics/ig-interactions')}
          />
        </div>
      </div>

      {/* «Движение аудитории» left the Обзор — the same numbers live in Аналитика's «Движение
          подписчиков» (ИА rule: one widget, one home; the ledger's «Подписчики ±N» keeps the net
          movement visible here). «Главное» takes the freed row: one more insight instead. */}
      <div className="mt-8 space-y-4 border-t border-border pt-8">
        <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Главное</h2>
        <InsightsBlock insights={ig.insights} limit={3} />
      </div>

      <section className="mt-8 space-y-4 border-t border-border pt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Топ публикаций</h2>
          <Link to="/instagram/content" className="shrink-0 text-sm font-medium text-primary hover:underline">
            Открыть контент →
          </Link>
        </div>
        <TopPostsBlock posts={ig.postsInWindow} limit={3} showSort={false} />
      </section>
    </div>
  );
}

