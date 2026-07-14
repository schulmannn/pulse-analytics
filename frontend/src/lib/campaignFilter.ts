import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Campaign, CampaignPost } from '@/api/schemas';

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
