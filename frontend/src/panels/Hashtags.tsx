import { useTgFull } from '@/api/queries';
import { normalizeTgPosts } from '@/lib/posts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Breakdown } from '@/components/Breakdown';
import { usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

interface TagStats {
  count: number;
  sum: number;
}

export function Hashtags() {
  const { days, inRange } = usePeriod();
  const { data: full, isPending, isError } = useTgFull(days);

  if (isPending) {
    return (
      <Card>
        <CardHeader><Skeleton className="h-4 w-1/4" /></CardHeader>
        <CardContent><Skeleton className="h-32 w-full" /></CardContent>
      </Card>
    );
  }

  if (isError || !full) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить хэштеги
        </CardContent>
      </Card>
    );
  }

  const posts = normalizeTgPosts(full.posts ?? [], full.channel ?? {}).filter(
    (post) => post.erv !== null && inRange(post.date),
  );

  let baseSum = 0;
  let baseCount = 0;
  const tagMap: Record<string, TagStats> = {};
  const originalCasing: Record<string, string> = {};

  posts.forEach((p) => {
    const erv = p.erv as number;
    if (!p.hashtags || p.hashtags.length === 0) {
      baseSum += erv;
      baseCount++;
    } else {
      const uniquePostTags = Array.from(new Set(p.hashtags.map((t) => t.toLowerCase())));
      p.hashtags.forEach((t) => {
        const low = t.toLowerCase();
        if (!originalCasing[low]) originalCasing[low] = t;
      });
      uniquePostTags.forEach((lowTag) => {
        const state = tagMap[lowTag] ?? { count: 0, sum: 0 };
        state.count++;
        state.sum += erv;
        tagMap[lowTag] = state;
      });
    }
  });

  const baseAvg = baseCount > 0 ? baseSum / baseCount : null;

  const items = Object.entries(tagMap)
    .map(([low, state]) => {
      const avgErv = state.sum / state.count;
      const lift = baseAvg ? avgErv / baseAvg : null;
      return { label: originalCasing[low] || low, count: state.count, avgErv, lift, sortValue: lift ?? avgErv };
    })
    .filter((t) => t.count >= 2)
    .sort((a, b) => b.sortValue - a.sortValue)
    .slice(0, 10);

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xs font-medium tracking-wider text-muted-foreground">Аналитика хэштегов</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center text-sm text-muted-foreground">
            Мало данных: нужно ≥2 поста с одним хэштегом.
          </div>
        </CardContent>
      </Card>
    );
  }

  const breakdownItems = items.map((item) => ({
    label: item.label.startsWith('#') ? item.label : `#${item.label}`,
    value: item.sortValue,
    display: item.lift != null ? `×${item.lift.toFixed(2)} · ${item.count}п` : `${item.avgErv.toFixed(1)}% · ${item.count}п`,
    color: item.lift != null ? (item.lift >= 1 ? 'hsl(var(--brand-verdant))' : 'hsl(var(--brand-ember))') : undefined,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-medium tracking-wider text-muted-foreground">Влияние хэштегов на ERV</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Breakdown items={breakdownItems} />
        {baseAvg !== null && (
          <div className="pt-1 text-xs font-medium text-muted-foreground">
            база без тегов: <strong className="text-foreground">{baseAvg.toFixed(1)}%</strong> ERV
          </div>
        )}
      </CardContent>
    </Card>
  );
}
