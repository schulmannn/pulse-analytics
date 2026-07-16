import { useCampaigns } from '@/api/queries';
import { useCampaignFilter, useResetMissingCampaign } from '@/lib/campaignFilter';
import { isDemoMode } from '@/lib/demo';
import { useSelectedChannel } from '@/lib/channel-context';
import { PillSelect } from '@/components/PillSelect';

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
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Кампания</span>
      <PillSelect
        value={campaignId != null ? String(campaignId) : ''}
        disabled={isPending}
        onValueChange={(v) => setCampaignId(v ? Number(v) : null)}
        ariaLabel="Фильтр по кампании"
        testId="campaign-filter"
        className="max-w-[180px]"
        options={[
          { value: '', label: 'Все' },
          ...(campaigns ?? []).map((c) => ({ value: String(c.id), label: c.name })),
        ]}
      />
    </div>
  );
}
