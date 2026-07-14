import { useTgFull } from '@/api/queries';
import { normalizeTgPosts } from '@/lib/posts';
import {
  deriveContentOpportunities,
  opportunityShareBoundary,
  opportunityX,
  opportunityY,
} from '@/lib/contentOpportunity';
import { useWidgetPeriod } from '@/lib/period';
import { fmt, pluralRu } from '@/lib/format';
import { cn } from '@/lib/utils';

/** `inCampaign` (default pass-through) narrows the posts to the selected campaign's members for the
    active source on the Analytics «Форматы» surface — derived from raw posts, never all-channel. */
export function ContentOpportunity({
  inCampaign = () => true,
}: { inCampaign?: (postId: number | null | undefined) => boolean } = {}) {
  const { data } = useTgFull(0);
  const { inRange } = useWidgetPeriod();
  const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter(
    (post) => inRange(post.date) && inCampaign(post.id),
  );
  const items = deriveContentOpportunities(posts);

  if (items.length < 2) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Нужно хотя бы два формата публикаций для сравнения.</p>;
  }

  const recommendations = items.filter((item) => item.opportunity);
  const points: Array<{ item: (typeof items)[number]; x: number; y: number }> = [];
  items.forEach((item, index) => {
    let x = opportunityX(item.share);
    let y = opportunityY(item.reachIndex);
    for (let attempt = 0; attempt < 5 && points.some((other) => Math.hypot(x - other.x, y - other.y) < 13); attempt += 1) {
      x = Math.min(92, Math.max(8, x + (index % 2 === 0 ? 8 : -8)));
      y = Math.min(88, Math.max(12, y + (attempt % 2 === 0 ? 7 : -4)));
    }
    points.push({ item, x, y });
  });
  const shareBoundary = opportunityShareBoundary(items.length) * 100;

  return (
    <div className="space-y-5">
      <div className="relative h-72 overflow-hidden rounded border border-border bg-background/30 px-8 pb-9 pt-5">
        <div aria-hidden="true" className="absolute inset-x-8 top-1/2 border-t border-dashed border-border" />
        <div aria-hidden="true" className="absolute bottom-9 top-5 border-l border-dashed border-border" style={{ left: `${shareBoundary}%` }} />
        <span className="absolute left-2 top-4 text-2xs text-muted-foreground">выше среднего</span>
        <span className="absolute bottom-2 left-8 text-2xs text-muted-foreground">реже публикуем</span>
        <span className="absolute bottom-2 right-8 text-2xs text-muted-foreground">чаще публикуем</span>
        {points.map(({ item, x, y }) => {
          return (
            <div
              key={item.key}
              className="group absolute -translate-x-1/2 translate-y-1/2"
              style={{ left: `${x}%`, bottom: `${y}%` }}
            >
              <button
                type="button"
                className={cn(
                  'relative flex h-9 min-w-9 items-center justify-center rounded-full border px-2 text-xs font-medium tabular-nums transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  item.opportunity
                    ? 'border-verdant/50 bg-verdant/15 text-verdant'
                    : item.confidence === 'low'
                      ? 'border-border bg-muted text-muted-foreground'
                      : 'border-primary/40 bg-primary/10 text-primary',
                )}
                aria-label={`${item.label}: ${Math.round(item.share * 100)}% публикаций, охват ${Math.round(item.reachIndex * 100)}% от среднего`}
              >
                {item.label}
              </button>
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-48 -translate-x-1/2 rounded border border-border bg-popover p-2 text-left text-xs shadow-lg group-hover:block group-focus-within:block">
                <div className="font-medium text-foreground">{item.label}</div>
                <div className="mt-1 space-y-0.5 text-muted-foreground">
                  <div>{item.count} {pluralRu(item.count, ['публикация', 'публикации', 'публикаций'])} · {Math.round(item.share * 100)}%</div>
                  <div>Ср. охват {fmt.short(item.avgReach)} · {Math.round(item.reachIndex * 100)}% от среднего</div>
                  {item.avgErv != null && <div>Средний ERV {item.avgErv.toFixed(1)}%</div>}
                  {item.confidence === 'low' && <div>Малая выборка — вывод предварительный</div>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3 text-sm">
        <div>
          <div className="font-medium text-foreground">{recommendations.length ? 'Возможность для теста' : 'Явной возможности пока нет'}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {recommendations.length
              ? `${recommendations.map((item) => item.label).join(', ')} дают охват выше среднего, но используются реже других форматов.`
              : 'Частота публикаций и средний охват форматов сейчас сбалансированы.'}
          </p>
        </div>
        <p className="max-w-sm text-2xs text-ink3">Наблюдение по текущей выборке, не прогноз результата.</p>
      </div>
    </div>
  );
}
