import { Link, useOutletContext } from 'react-router-dom';
import { fmt } from '@/lib/format';
import { pctDelta } from '@/lib/delta';
import { pairDelta } from '@/lib/igMetrics';
import type { IgData } from '@/lib/useIgData';
import { KpiHero, KpiCard, signedNum } from '@/components/instagram/shared';
import { InsightsBlock } from '@/components/instagram/insights';
import { TopPostsBlock } from '@/components/instagram/content';

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
          <KpiCard
            label="Подписчики"
            value={fmt.num(ig.followers)}
            deltaText={ig.netMovement.hasCur ? signedNum(ig.netMovement.cur) : undefined}
            deltaTone={ig.netMovement.cur > 0 ? 'up' : ig.netMovement.cur < 0 ? 'down' : 'flat'}
          />
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
        <AudienceMovement ig={ig} />
      </div>

      <section className="mt-8 space-y-4 border-t border-border pt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Топ публикаций</h2>
          <Link to="/instagram/content" className="shrink-0 text-sm font-medium text-primary hover:underline">
            Открыть контент →
          </Link>
        </div>
        <TopPostsBlock posts={ig.posts} limit={3} showSort={false} />
      </section>
    </div>
  );
}

/**
 * Real audience movement (follows / unfollows / net) — a stronger second signal than an API status
 * or a second views chart. On @bynotem's data it shows the important truth: follows come, but
 * unfollows outrun them.
 */
function AudienceMovement({ ig }: { ig: IgData }) {
  const follows = ig.pairs.follows.cur;
  const unfollows = ig.pairs.unfollows.cur;
  const net = ig.netMovement.cur;
  const max = Math.max(follows, unfollows, 1);
  const hasData = ig.pairs.follows.hasCur || ig.pairs.unfollows.hasCur;

  const bar = (label: string, value: number, sign: string, positive: boolean) => (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-medium tabular-nums ${positive ? 'text-verdant' : 'text-ember'}`}>{sign}{fmt.num(value)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${positive ? 'bg-verdant' : 'bg-ember'}`} style={{ width: `${Math.round((value / max) * 100)}%` }} />
      </div>
    </div>
  );

  return (
    <div>
      <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Движение аудитории · {ig.window.days} дн.</h2>
      {hasData ? (
        <>
          <div className="mt-3 space-y-3">
            {bar('Подписки', follows, '+', true)}
            {bar('Отписки', unfollows, '−', false)}
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">Чистый прирост</span>
            <span className={`text-lg font-medium tabular-nums ${net > 0 ? 'text-verdant' : net < 0 ? 'text-ember' : 'text-foreground'}`}>
              {signedNum(net)}
            </span>
          </div>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Нет данных о движении подписчиков за период.</p>
      )}
    </div>
  );
}
