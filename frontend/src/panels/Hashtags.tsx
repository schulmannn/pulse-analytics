import { useTgFull } from '@/api/queries';
import type { TgFull } from '@/api/schemas';
import { normalizeTgPosts } from '@/lib/posts';
import { ChartSection, breakdownVariants } from '@/components/ChartWidget';
import { useWidgetPeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

interface TagStats {
  count: number;
  sum: number;
}

type InRange = (dateISO: string | null | undefined) => boolean;

/**
 * Hashtag ERV-lift over the IN-WINDOW posts: for each tag carried by ≥2 posts, its average ERV and
 * the lift vs the no-tag baseline. Top-10 by lift (else avg ERV). Pure, so the widget re-derives it
 * per its own period (variants-fn form) — the bars follow the card's 7д/30д/90д/Всё pill.
 */
function deriveHashtags(full: TgFull | undefined, inRange: InRange) {
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter(
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

  const breakdownItems = items.map((item) => ({
    label: item.label.startsWith('#') ? item.label : `#${item.label}`,
    value: item.sortValue,
    display: item.lift != null ? `×${item.lift.toFixed(2)} · ${item.count}п` : `${item.avgErv.toFixed(1)}% · ${item.count}п`,
    color: item.lift != null ? (item.lift >= 1 ? 'hsl(var(--brand-verdant))' : 'hsl(var(--brand-ember))') : undefined,
  }));

  return { breakdownItems, baseAvg, hasItems: items.length > 0 };
}

/** «база без тегов» caption — reads the card's OWN window (useWidgetPeriod) so it matches the bars. */
function HashtagsBase({ full }: { full: TgFull | undefined }) {
  const { inRange } = useWidgetPeriod();
  const { baseAvg } = deriveHashtags(full, inRange);
  if (baseAvg === null) return null;
  return (
    <div className="mt-3 text-xs font-medium text-muted-foreground">
      база без тегов: <strong className="text-foreground">{baseAvg.toFixed(1)}%</strong> ERV
    </div>
  );
}

/** Whole-payload predicate — gates card EXISTENCE on the full fetch, so a narrow window that
    happens to be empty doesn't make the whole card vanish (the per-window empty shows in-card). */
const alwaysInRange = () => true;

export function Hashtags() {
  // ONE wide fetch (limit 0 = server cap 100); the widget windows it client-side per its own period.
  const { data: full, isPending, isError } = useTgFull(0);

  if (isPending) {
    return (
      <ChartSection title="Влияние хэштегов на ERV" defaultSize="full">
        <Skeleton className="h-40 w-full" />
      </ChartSection>
    );
  }

  if (isError || !full) {
    return (
      <ChartSection title="Влияние хэштегов на ERV" defaultSize="full">
        <div className="py-6 text-center text-sm text-muted-foreground">Не удалось загрузить хэштеги.</div>
      </ChartSection>
    );
  }

  if (!deriveHashtags(full, alwaysInRange).hasItems) {
    return (
      <ChartSection title="Влияние хэштегов на ERV" defaultSize="full">
        <div className="py-6 text-center text-sm text-muted-foreground">
          Мало данных: нужно ≥2 поста с одним хэштегом.
        </div>
      </ChartSection>
    );
  }

  return (
    <ChartSection
      title="Влияние хэштегов на ERV"
      defaultSize="full"
      periodControl
      variants={(period) => breakdownVariants(deriveHashtags(full, period.inRange).breakdownItems)}
    >
      <HashtagsBase full={full} />
    </ChartSection>
  );
}
