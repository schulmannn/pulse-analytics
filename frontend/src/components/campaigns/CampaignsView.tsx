import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCampaigns } from '@/api/queries';
import type { Campaign, CampaignStatus } from '@/api/schemas';
import { CampaignDialog } from '@/components/campaigns/CampaignDialog';
import { CampaignColorDot, CampaignStatusChip, campaignPeriodLabel } from '@/components/campaigns/shared';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { isDemoMode } from '@/lib/demo';
import { cn } from '@/lib/utils';
import { useSelectedChannel } from '@/lib/channel-context';

type StatusFilter = 'all' | CampaignStatus;
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'active', label: 'Активные' },
  { key: 'completed', label: 'Завершённые' },
  { key: 'archived', label: 'Архив' },
];

/**
 * Рабочий список кампаний — компактная таблица внутри раздела «Контент» (общая для TG и IG:
 * кампании кросс-платформенные и per-user). Строка → страница кампании /campaigns/:id.
 * Никаких маркетинговых карточек: имя+метка, статус, период, публикации, обновлена.
 */
export function CampaignsView() {
  const navigate = useNavigate();
  const { channelId } = useSelectedChannel();
  const { data, isPending, isError, error, refetch, isRefetching } = useCampaigns(channelId);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);

  if (isDemoMode()) {
    return (
      <EmptyState
        title="Кампании недоступны в демо-режиме"
        reason="Подключите свой источник, чтобы группировать публикации в кампании."
      />
    );
  }
  if (channelId == null) {
    return <EmptyState title="Сначала выберите источник" reason="Кампания создаётся внутри рабочего пространства выбранного источника." />;
  }
  if (isPending) return <CampaignsSkeleton />;
  if (isError) {
    return (
      <ErrorState
        title="Не удалось загрузить кампании"
        reason={error instanceof Error ? error.message : 'ошибка сервера'}
        onRetry={() => refetch()}
        retrying={isRefetching}
      />
    );
  }

  const campaigns = data?.campaigns ?? [];
  const visible = filter === 'all' ? campaigns : campaigns.filter((c) => c.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'btn-pill px-3 py-1 text-xs font-medium transition-colors',
                filter === f.key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="btn-pill bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Новая кампания
        </button>
      </div>

      {campaigns.length === 0 ? (
        <EmptyState
          title="Кампаний пока нет"
          reason="Сгруппируйте публикации по смыслу — «Запуск продукта», «Black Friday», «Интеграции с блогерами» — и смотрите их общий результат."
        />
      ) : visible.length === 0 ? (
        <EmptyState compact title="В этом статусе кампаний нет." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm" data-testid="campaigns-table">
            <thead>
              <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                <th className="min-w-[220px] py-3 pl-0 pr-3">Кампания</th>
                <th className="px-3 py-3">Статус</th>
                <th className="px-3 py-3">Период</th>
                <th className="px-3 py-3 text-right">Публикации</th>
                <th className="px-3 py-3 text-right last:pr-0">Обновлена</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/campaigns/${c.id}`)}
                  className="group cursor-pointer transition-colors hover:bg-hover-row"
                >
                  <td className="py-3 pl-0 pr-3">
                    <div className="flex items-center gap-2.5">
                      <CampaignColorDot color={c.color} />
                      <div className="min-w-0">
                        <span className="block truncate font-medium text-foreground group-hover:text-primary">
                          {c.name}
                        </span>
                        {c.description ? (
                          <span className="block max-w-xs truncate text-xs text-muted-foreground">{c.description}</span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <CampaignStatusChip status={c.status} />
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{campaignPeriodLabel(c)}</td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums text-foreground">
                    {fmt.num(c.post_count ?? 0)}
                  </td>
                  <td className="px-3 py-3 text-right text-xs tabular-nums text-muted-foreground last:pr-0">
                    {c.updated_at ? fmt.date(c.updated_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CampaignDialog
          initial={null}
          channelId={channelId}
          onClose={() => setCreateOpen(false)}
          onSaved={(c: Campaign) => navigate(`/campaigns/${c.id}`)}
        />
      )}
    </div>
  );
}

function CampaignsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-7 w-32" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="ml-auto h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}
