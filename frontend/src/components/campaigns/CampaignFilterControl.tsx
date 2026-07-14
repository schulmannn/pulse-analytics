import { useCampaigns } from '@/api/queries';
import { useCampaignFilter, useResetMissingCampaign } from '@/lib/campaignFilter';
import { isDemoMode } from '@/lib/demo';
import { useSelectedChannel } from '@/lib/channel-context';

/**
 * Компактный фильтр кампании для списков контента. Канонический стейт — URL `?campaign=`
 * (lib/campaignFilter); контрол только читает/пишет его. Недоступный или удалённый id
 * сбрасывается сам, как только список кампаний загружен (deep-link на чужую кампанию
 * тихо превращается в «Все»).
 */
export function CampaignFilterControl() {
  const { channelId } = useSelectedChannel();
  const { campaignId, setCampaignId } = useCampaignFilter();
  const { data, isPending, isError } = useCampaigns(channelId);
  const campaigns = data?.campaigns;
  useResetMissingCampaign(campaignId, isPending || isError ? undefined : (campaigns ?? []), setCampaignId);

  if (isDemoMode() || isError) return null;
  if (!isPending && (campaigns?.length ?? 0) === 0 && campaignId == null) return null;

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Кампания</span>
      <select
        value={campaignId ?? ''}
        disabled={isPending}
        onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}
        className="max-w-[180px] rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        data-testid="campaign-filter"
      >
        <option value="">Все</option>
        {(campaigns ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
