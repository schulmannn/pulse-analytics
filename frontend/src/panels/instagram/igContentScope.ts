import type { IgData } from '@/lib/useIgData';
import type { IgPost, CampaignPostInput } from '@/api/schemas';
import { useCampaignPosts } from '@/api/queries';
import { membershipKey, useCampaignFilter, useMembershipSet } from '@/lib/campaignFilter';
import { useSelectedChannel } from '@/lib/channel-context';
import { postInteractionsByFormat } from '@/lib/igMetrics';

// ─────────────────────────────────────────────────────────────────────────────
// Shared campaign-scope + selection helpers (identical windowing on both branches)
// ─────────────────────────────────────────────────────────────────────────────

export function useIgScopedPosts(ig: IgData) {
  const { channelId } = useSelectedChannel();
  const { campaignId } = useCampaignFilter();
  const campaignPostsQ = useCampaignPosts(campaignId);
  const memberSet = useMembershipSet(campaignPostsQ.data?.posts);
  // Фильтр кампании применяется к списку постов; производные (форматы) следуют за видимым набором.
  const posts =
    campaignId != null && channelId != null
      ? ig.postsInWindow.filter((p) => p.id && memberSet.has(membershipKey('ig', channelId, p.id)))
      : ig.postsInWindow;
  const formatItems =
    campaignId == null && ig.formatItems.length > 0
      ? ig.formatItems
      : postInteractionsByFormat(posts);
  return { channelId, campaignId, campaignPostsQ, posts, formatItems };
}

/** ig-метаданные (дата/формат/подпись) едут в membership с клиента — в БД их нет (сервер валидирует). */
export function toCampaignItems(posts: IgPost[], channelId: number | null, selected: Set<string>): CampaignPostInput[] {
  if (channelId == null) return [];
  return posts
    .filter((p) => p.id && selected.has(p.id))
    .map((p) => ({
      network: 'ig' as const,
      channel_id: channelId,
      post_ref: p.id!,
      published_at: p.timestamp ?? undefined,
      media_type: (p.media_product_type === 'REELS' ? 'REELS' : p.media_type) ?? undefined,
      caption: p.caption ? p.caption.slice(0, 300) : undefined,
    }));
}
