import type { ReactNode } from 'react';
import { useTgFull, useTgGraphs } from '@/api/queries';
import { normalizeTgPosts } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

export function Digest() {
  const { days, inRange } = usePeriod();
  // isPending (не isLoading): канал-скоупные запросы выключены, пока канал не известен, —
  // скелетон должен показываться и в этом состоянии (isLoading у disabled-запроса = false).
  const { data: full, isPending: isFullPending } = useTgFull(days);
  const { data: graphs, isPending: isGraphsPending } = useTgGraphs();

  if (isFullPending || isGraphsPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    );
  }

  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((post) =>
    inRange(post.date),
  );
  const totalViews = posts.reduce((sum, post) => sum + post.reach, 0);
  const postsN = posts.length;

  let netSubscribers: number | null = null;
  const fSeries = graphs?.followers?.series ?? [];
  const joinedSeries = fSeries.find((s) => /join|подпис/i.test(s.name ?? ''));
  const leftSeries = fSeries.find((s) => /left|отпис/i.test(s.name ?? ''));
  if (joinedSeries && leftSeries) {
    const mLen = Math.min(joinedSeries.values.length, leftSeries.values.length);
    let totalJ = 0;
    let totalL = 0;
    for (let i = 0; i < mLen; i++) {
      totalJ += Number(joinedSeries.values[i] ?? 0);
      totalL += Number(leftSeries.values[i] ?? 0);
    }
    netSubscribers = totalJ - totalL;
  }

  const activeErvs = posts.map((p) => p.erv).filter((v): v is number => v !== null);
  const avgErv = activeErvs.length ? activeErvs.reduce((a, b) => a + b, 0) / activeErvs.length : null;

  const bestPost = posts.length > 0 ? [...posts].sort((a, b) => b.reach - a.reach)[0] : null;

  const wdViews: number[] = Array(7).fill(0);
  const wdCount: number[] = Array(7).fill(0);
  full?.posts?.forEach((p) => {
    if (!inRange(p.date) || !p.date) return;
    const day = new Date(p.date).getDay();
    wdViews[day] += Number(p.views ?? p.view_count ?? 0);
    wdCount[day] += 1;
  });
  const wdOrder = [1, 2, 3, 4, 5, 6, 0];
  const wdLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const wdAvg = wdOrder.map((idx) => {
    const count = wdCount[idx] ?? 0;
    return count ? (wdViews[idx] ?? 0) / count : 0;
  });
  const maxWd = Math.max(...wdAvg);
  const bestWd = maxWd > 0 ? wdLabels[wdAvg.indexOf(maxWd)] : null;

  let peakHour: number | null = null;
  const thData = graphs?.top_hours;
  if (thData && thData.values.length > 0) {
    const pi = thData.values.indexOf(Math.max(...thData.values));
    peakHour = thData.hours[pi] ?? pi;
  }

  if (posts.length === 0 && !graphs) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Недостаточно данных для авто-сводки.
      </div>
    );
  }

  // ── Three-tier summary: Insight (что произошло) → Evidence (где доказательство) → Action (что делать) ──
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;
  const insightLead =
    `За период — ${postsN} ${postsN === 1 ? 'пост' : 'постов'} и ${fmt.short(totalViews)} просмотров` +
    (netSubscribers !== null ? `, подписчики ${signed(netSubscribers)}` : '') +
    (avgErv !== null ? `. Средний ERV ${avgErv.toFixed(1)}%` : '') +
    '.';

  const hasBest = !!bestPost && bestPost.reach > 0;
  const bestCaptionRaw = bestPost?.caption ? markdownToPlainText(bestPost.caption) : '';
  const bestCaption = bestCaptionRaw
    ? bestCaptionRaw.length > 64
      ? `${bestCaptionRaw.slice(0, 64)}…`
      : bestCaptionRaw
    : 'без подписи';

  let actionText: string;
  if (bestWd && peakHour !== null) actionText = `Публикуйте в ${bestWd} около ${peakHour}:00 — в этот слот выше охват.`;
  else if (bestWd) actionText = `Публикуйте в ${bestWd} — в этот день выше охват.`;
  else if (peakHour !== null) actionText = `Публикуйте около ${peakHour}:00 — в этот час выше охват.`;
  else if (hasBest) actionText = 'Повторите тему топ-поста — она набрала больше всего.';
  else actionText = 'Накопите больше постов — тогда появятся рекомендации.';

  return (
    <div>
      <div className="text-sm font-medium text-ink3">Инсайт</div>
      <div className="mt-3 space-y-4">
        {/* INSIGHT — что произошло (доминирует) */}
        <div>
          <TierLabel>Итог</TierLabel>
          <p className="mt-1.5 text-base font-medium leading-relaxed text-foreground">{insightLead}</p>
        </div>

        {/* EVIDENCE — где доказательство */}
        {hasBest && (
          <div className="border-t pt-4">
            <TierLabel>Доказательство</TierLabel>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Сильнее всего сработал пост «<span className="text-foreground">{bestCaption}</span>» —{' '}
              <span className="font-medium text-foreground">{fmt.short(bestPost!.reach)}</span> просмотров
              {bestPost!.erv !== null ? `, ERV ${bestPost!.erv.toFixed(1)}%` : ''}.
              {bestPost!.permalink && (
                <>
                  {' '}
                  <a
                    href={bestPost!.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    Открыть →
                  </a>
                </>
              )}
            </p>
          </div>
        )}

        {/* ACTION — что сделать */}
        <div className="border-t pt-4">
          <TierLabel>Что сделать</TierLabel>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{actionText}</p>
        </div>
      </div>
    </div>
  );
}

/** Tier marker for the summary — a neutral hairline dot + label (no decorative colour per the DS). */
function TierLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ink3/60" />
      {children}
    </div>
  );
}
