import type { Campaign, CampaignStatus } from '@/api/schemas';
import { CAMPAIGN_STATUS_LABEL } from '@/api/schemas';
import { cn } from '@/lib/utils';

/** Роли, которым сервер разрешает изменять кампанию (viewer — read-only). UI прячет
    write-контролы по той же таблице, что и 403 на бэке. */
export function canEditCampaign(campaign: Pick<Campaign, 'my_role'> | null | undefined): boolean {
  const role = campaign?.my_role;
  return role === 'member' || role === 'admin' || role === 'owner';
}

const STATUS_CLASS: Record<CampaignStatus, string> = {
  active: 'bg-primary/10 text-primary',
  completed: 'bg-verdant/10 text-verdant',
  archived: 'bg-muted text-muted-foreground',
};

export function CampaignStatusChip({ status }: { status: string }) {
  const key = (status in STATUS_CLASS ? status : 'active') as CampaignStatus;
  return (
    <span className={cn('inline-flex rounded px-1.5 py-0.5 text-2xs font-medium', STATUS_CLASS[key])}>
      {CAMPAIGN_STATUS_LABEL[key]}
    </span>
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
    <span
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-2xs font-medium',
        network === 'ig' ? 'bg-muted text-foreground' : 'bg-primary/10 text-primary',
      )}
    >
      {network === 'ig' ? 'IG' : 'TG'}
    </span>
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
