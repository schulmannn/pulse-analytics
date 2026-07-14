import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Campaign, CampaignPost } from '@/api/schemas';
import { useCampaignPosts } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';

/**
 * Канонический стейт фильтра кампании — URL-параметр `?campaign=<id>` (воспроизводимая
 * навигация, browser Back работает). ЕДИНСТВЕННАЯ точка чтения/записи: панели контента и
 * аналитики берут id ТОЛЬКО через useCampaignFilter — никаких разрозненных чтений
 * location/localStorage по компонентам. Идиома merge-and-replace как у `?tab=`
 * (AnalyticsTabs): дефолт («все кампании») держит URL чистым.
 */

export function parseCampaignParam(raw: string | null): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

export function useCampaignFilter() {
  const [params, setParams] = useSearchParams();
  const campaignId = parseCampaignParam(params.get('campaign'));
  const setCampaignId = useCallback(
    (next: number | null) => {
      setParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          if (next == null) merged.delete('campaign');
          else merged.set('campaign', String(next));
          return merged;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { campaignId, setCampaignId };
}

/** Недоступный/удалённый campaign id из URL безопасно сбрасывается, как только список
    кампаний загружен и id в нём не нашёлся (deep-link на чужую/стёртую кампанию). */
export function useResetMissingCampaign(
  campaignId: number | null,
  campaigns: Campaign[] | undefined,
  setCampaignId: (next: number | null) => void,
) {
  useEffect(() => {
    if (campaignId == null || campaigns === undefined) return;
    if (!campaigns.some((c) => c.id === campaignId)) setCampaignId(null);
  }, [campaignId, campaigns, setCampaignId]);
}

/** Ключ membership-строки; та же тройка, что PK campaign_posts (без campaign_id). */
export function membershipKey(network: string, channelId: number, postRef: string): string {
  return `${network}:${channelId}:${postRef}`;
}

export function buildMembershipSet(
  posts: Pick<CampaignPost, 'network' | 'channel_id' | 'post_ref'>[],
): Set<string> {
  return new Set(posts.map((p) => membershipKey(p.network, p.channel_id, p.post_ref)));
}

/** Мемо-обёртка для панелей: set membership выбранной кампании (пустой = фильтра нет). */
export function useMembershipSet(
  posts: Pick<CampaignPost, 'network' | 'channel_id' | 'post_ref'>[] | undefined,
): Set<string> {
  return useMemo(() => buildMembershipSet(posts ?? []), [posts]);
}

/** Source-exact membership test: is (network, channelId, postRef) a member of this set? The triple
    is the whole identity — an IG membership or another channel's post never matches a TG source. */
export function isSourceMember(
  memberSet: Set<string>,
  network: string,
  channelId: number | null,
  postRef: string | number | null | undefined,
): boolean {
  if (channelId == null || postRef == null) return false;
  return memberSet.has(membershipKey(network, channelId, String(postRef)));
}

/** Campaign scope for the Telegram analytics «Форматы» surface. A source is exactly (tg, channelId);
    when a campaign is selected, `inCampaign` keeps ONLY posts whose (tg, channelId, id) is in the
    campaign — never another channel or Instagram membership, and never the global views_summary. With
    no campaign selected it is a pass-through (`active` false, `inCampaign` always true). Reuses
    `useCampaignPosts` (React Query dedupes the fetch across every caller on the tab). */
export interface TgCampaignScope {
  campaignId: number | null;
  channelId: number | null;
  /** A campaign is selected; unresolved source state is represented by `isPending`. */
  active: boolean;
  /** Campaign-posts request is loading (only meaningful while `active`). */
  isPending: boolean;
  /** Campaign-posts request failed (only meaningful while `active`). */
  isError: boolean;
  /** How many of the campaign's posts belong to THIS source (tg, channelId) — 0 ⇒ nothing matches. */
  sourceMemberCount: number;
  /** Keep-predicate for a normalized TG post id (pass-through when no campaign is active). */
  inCampaign: (postId: number | null | undefined) => boolean;
  retry: () => void;
}

export function useTgCampaignScope(): TgCampaignScope {
  const { channelId } = useSelectedChannel();
  const { campaignId } = useCampaignFilter();
  const q = useCampaignPosts(campaignId);
  const posts = q.data?.posts;
  const memberSet = useMembershipSet(posts);
  // A selected campaign is active even during the short channel-bootstrap window. Treat that
  // window as pending and reject posts until the exact source resolves; briefly showing the whole
  // channel would be a much worse lie than a skeleton.
  const active = campaignId != null;

  const sourceMemberCount = useMemo(() => {
    if (channelId == null || !posts) return 0;
    return posts.reduce((n, p) => (p.network === 'tg' && p.channel_id === channelId ? n + 1 : n), 0);
  }, [posts, channelId]);

  const inCampaign = useCallback(
    (postId: number | null | undefined) =>
      !active ? true : isSourceMember(memberSet, 'tg', channelId, postId),
    [active, memberSet, channelId],
  );

  return {
    campaignId,
    channelId,
    active,
    isPending: active ? q.isPending || channelId == null : false,
    isError: active ? q.isError : false,
    sourceMemberCount,
    inCampaign,
    retry: () => void q.refetch(),
  };
}
