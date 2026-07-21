import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCampaignPosts, useCampaigns } from '@/api/queries';
import type { Campaign, CampaignStatus } from '@/api/schemas';
import { CampaignDialog } from '@/components/campaigns/CampaignDialog';
import {
  CampaignColorDot,
  CampaignStatusChip,
  campaignPeriodLabel,
} from '@/components/campaigns/shared';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  const { data, isPending, isError, error, refetch, isRefetching } =
    useCampaigns(channelId);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  // Tree List (Astryx): одна развёрнутая кампания за раз — ветка публикаций грузится лениво.
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (isDemoMode()) {
    return (
      <EmptyState
        title="Кампании недоступны в демо-режиме"
        reason="Подключите свой источник, чтобы группировать публикации в кампании."
      />
    );
  }
  if (channelId == null) {
    return (
      <EmptyState
        title="Сначала выберите источник"
        reason="Кампания создаётся внутри рабочего пространства выбранного источника."
      />
    );
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
  const visible =
    filter === 'all' ? campaigns : campaigns.filter((c) => c.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              type="button"
              variant={filter === f.key ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setFilter(f.key)}
              className={cn(
                filter === f.key &&
                  'border-transparent bg-primary/15 text-foreground',
              )}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          Новая кампания
        </Button>
      </div>

      {campaigns.length === 0 ? (
        <EmptyState
          title="Кампаний пока нет"
          reason="Сгруппируйте публикации по смыслу — «Запуск продукта», «Black Friday», «Интеграции с блогерами» — и смотрите их общий результат."
        />
      ) : visible.length === 0 ? (
        <EmptyState compact title="В этом статусе кампаний нет." />
      ) : (
        <Table
          className="border-collapse text-left"
          data-testid="campaigns-table"
        >
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="min-w-[220px] pl-0">Кампания</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>Период</TableHead>
              <TableHead className="text-right">Публикации</TableHead>
              <TableHead className="text-right last:pr-0">Обновлена</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((c) => (
              <Fragment key={c.id}>
              <TableRow
                onClick={() => navigate(`/campaigns/${c.id}`)}
                className="group cursor-pointer"
              >
                <TableCell className="pl-0">
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      aria-expanded={expandedId === c.id}
                      aria-label={expandedId === c.id ? `Скрыть публикации «${c.name}»` : `Показать публикации «${c.name}»`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedId(expandedId === c.id ? null : c.id);
                      }}
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className={`h-3.5 w-3.5 transition-transform ${expandedId === c.id ? 'rotate-90' : ''}`}
                        aria-hidden="true"
                      >
                        <path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <CampaignColorDot color={c.color} />
                    <div className="min-w-0">
                      <span className="block truncate font-medium text-foreground group-hover:text-primary">
                        {c.name}
                      </span>
                      {c.description ? (
                        <span className="block max-w-xs truncate text-xs text-muted-foreground">
                          {c.description}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <CampaignStatusChip status={c.status} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {campaignPeriodLabel(c)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums text-foreground">
                  {fmt.num(c.post_count ?? 0)}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground last:pr-0">
                  {c.updated_at ? fmt.date(c.updated_at) : '—'}
                </TableCell>
              </TableRow>
              {expandedId === c.id && <CampaignPostsBranch campaignId={c.id} />}
              </Fragment>
            ))}
          </TableBody>
        </Table>
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


/**
 * Ветка Tree List: ленивые публикации развёрнутой кампании (грузятся только при развороте).
 * Вертикальная направляющая — визуальный язык дерева; кап в 8 строк, дальше — «открыть кампанию».
 * В демо честная заглушка: membership-запросы в demo-режиме выключены (useCampaignPosts гейт).
 */
const BRANCH_CAP = 8;

function CampaignPostsBranch({ campaignId }: { campaignId: number }) {
  const demo = isDemoMode();
  const postsQ = useCampaignPosts(demo ? null : campaignId);
  const posts = postsQ.data?.posts ?? [];
  return (
    <TableRow className="hover:bg-transparent" data-testid="campaign-branch">
      <TableCell colSpan={5} className="pb-3 pl-1 pt-0">
        <div className="ml-[7px] border-l border-border pl-4">
          {demo ? (
            <p className="py-2 text-xs text-muted-foreground">Состав кампании недоступен в демо-режиме.</p>
          ) : postsQ.isPending ? (
            <div className="space-y-1.5 py-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
          ) : postsQ.isError ? (
            <p className="py-2 text-xs text-destructive">Не удалось загрузить публикации.</p>
          ) : posts.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">Публикаций пока нет — добавьте их из «Контента».</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {posts.slice(0, BRANCH_CAP).map((post) => {
                const metric =
                  post.network === 'tg'
                    ? post.tg_views != null
                      ? `${fmt.kpi(post.tg_views)} просм.`
                      : null
                    : post.ig_reach != null
                      ? `${fmt.kpi(post.ig_reach)} охват`
                      : null;
                return (
                  <li key={`${post.network}:${post.channel_id}:${post.post_ref}`} className="flex items-center gap-2.5 py-1.5 text-xs">
                    <span className="flex h-4 w-7 shrink-0 items-center justify-center rounded-sm bg-muted text-2xs font-medium uppercase text-muted-foreground">
                      {post.network}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {post.caption?.trim() || post.post_ref}
                    </span>
                    {metric && <span className="shrink-0 tabular-nums text-muted-foreground">{metric}</span>}
                    <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                      {post.published_at ? fmt.date(post.published_at) : '—'}
                    </span>
                  </li>
                );
              })}
              {posts.length > BRANCH_CAP && (
                <li className="py-1.5 text-2xs text-muted-foreground">
                  и ещё {fmt.num(posts.length - BRANCH_CAP)} — откройте кампанию целиком.
                </li>
              )}
            </ul>
          )}
        </div>
      </TableCell>
    </TableRow>
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
