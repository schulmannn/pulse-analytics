import { useTgFull } from '@/api/queries';
import { EmptyState } from '@/components/EmptyState';
import type { TgFull } from '@/api/schemas';
import { normalizeTgPosts } from '@/lib/posts';
import { ChartSection } from '@/components/ChartWidget';
import { breakdownVariants } from '@/components/widgets/variants';
import { ErrorState } from '@/components/ErrorState';
import { useWidgetPeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

interface TagStats {
  count: number;
  sum: number;
}

type InRange = (dateISO: string | null | undefined) => boolean;
type Keep = (postId: number | null | undefined) => boolean;
const keepAll: Keep = () => true;

/**
 * Hashtag ERV-lift over the IN-WINDOW posts: for each tag carried by ≥2 posts, its average ERV and
 * the lift vs the no-tag baseline. Top-10 by lift (else avg ERV). Pure, so the widget re-derives it
 * for the resolved feed/Home window. `keep` additionally scopes to a selected campaign.
 */
function deriveHashtags(full: TgFull | undefined, inRange: InRange, keep: Keep = keepAll) {
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter(
    (post) => post.erv !== null && inRange(post.date) && keep(post.id),
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

/** «База без тегов» reads the same resolved window as the bars. */
function HashtagsBase({ full, keep }: { full: TgFull | undefined; keep: Keep }) {
  const { inRange } = useWidgetPeriod();
  const { baseAvg } = deriveHashtags(full, inRange, keep);
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

/** `inCampaign` (default pass-through) scopes the lift to the selected campaign's members for the
    active source on the Analytics «Форматы» surface — derived from raw posts, never all-channel. */
export function Hashtags({
  inCampaign = keepAll,
}: { inCampaign?: Keep } = {}) {
  // ONE wide fetch (limit 0 = server cap 100); the resolved feed/Home period windows it client-side.
  const { data: full, isPending, isError, refetch } = useTgFull(0);

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
        <ErrorState title="Не удалось загрузить хэштеги" onRetry={() => refetch()} />
      </ChartSection>
    );
  }

  if (!deriveHashtags(full, alwaysInRange, inCampaign).hasItems) {
    return (
      <ChartSection title="Влияние хэштегов на ERV" defaultSize="full">
        <EmptyState compact title="Мало данных для хэштегов" reason="Нужно ≥2 поста с одним хэштегом" />
      </ChartSection>
    );
  }

  return (
    <ChartSection
      title="Влияние хэштегов на ERV"
      defaultSize="full"
      periodControl
      variants={(period) => breakdownVariants(deriveHashtags(full, period.inRange, inCampaign).breakdownItems)}
    >
      <HashtagsBase full={full} keep={inCampaign} />
    </ChartSection>
  );
}
