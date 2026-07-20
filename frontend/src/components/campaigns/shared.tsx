import type { Campaign, CampaignStatus } from '@/api/schemas';
import { CAMPAIGN_STATUS_LABEL } from '@/api/schemas';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Роли, которым сервер разрешает изменять кампанию (viewer — read-only). UI прячет
    write-контролы по той же таблице, что и 403 на бэке. */
export function canEditCampaign(campaign: Pick<Campaign, 'my_role'> | null | undefined): boolean {
  const role = campaign?.my_role;
  return role === 'member' || role === 'admin' || role === 'owner';
}

const STATUS_VARIANT: Record<CampaignStatus, 'default' | 'success' | 'secondary'> = {
  active: 'default',
  completed: 'success',
  archived: 'secondary',
};

export function CampaignStatusChip({ status }: { status: string }) {
  const key = (status in STATUS_VARIANT ? status : 'active') as CampaignStatus;
  return (
    <Badge variant={STATUS_VARIANT[key]}>{CAMPAIGN_STATUS_LABEL[key]}</Badge>
  );
}

/** Цветовая метка кампании; без цвета — нейтральная точка (hairline, без заливки). */
export function CampaignColorDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 rounded-full border border-border', className)}
      style={color ? { backgroundColor: color, borderColor: color } : undefined}
    />
  );
}

/** Платформа публикации — везде рядом с источником (методологии сетей различаются). */
export function NetworkBadge({ network }: { network: string }) {
  return (
    <Badge variant={network === 'ig' ? 'secondary' : 'default'}>
      {network === 'ig' ? 'IG' : 'TG'}
    </Badge>
  );
}

/** «10 июн — 12 июн» / «с 10 июн» / «—» для start/end дат кампании. */
export function campaignPeriodLabel(c: Pick<Campaign, 'start_date' | 'end_date'>): string {
  const d = (iso: string) => {
    const dt = new Date(`${iso}T00:00:00`);
    return dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  };
  if (c.start_date && c.end_date) return `${d(c.start_date)} — ${d(c.end_date)}`;
  if (c.start_date) return `с ${d(c.start_date)}`;
  if (c.end_date) return `до ${d(c.end_date)}`;
  return '—';
}
