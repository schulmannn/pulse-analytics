import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import {
  useCampaignPosts,
  useCampaignSummary,
  useDeleteCampaign,
  useRemoveCampaignPosts,
  useUpdateCampaign,
} from '@/api/queries';
import type { CampaignPost } from '@/api/schemas';
import { EmptyState } from '@/components/EmptyState';
import { useConfirm } from '@/components/ConfirmDialogProvider';
import { ErrorState } from '@/components/ErrorState';
import { CampaignDialog } from '@/components/campaigns/CampaignDialog';
import { canEditCampaign } from '@/components/campaigns/shared';
import { Skeleton } from '@/components/ui/skeleton';
import {
  campaignSourceKey,
  campaignSourceOptions,
  filterCampaignPosts,
  parseCampaignSourceKey,
} from '@/lib/campaignSources';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { CampaignPageDesktop } from '@/panels/campaign/CampaignPageDesktop';
import { CampaignPageMobile } from '@/panels/campaign/CampaignPageMobile';
import type { CampaignViewProps } from '@/panels/campaign/campaignView';

const CAMPAIGNS_LIST = '/posts?view=campaigns';

/**
 * Оркестратор страницы кампании: маршрут `/campaigns/:id`, запросы (сводка + source-scoped
 * сводка + публикации), гейты (загрузка/ошибка/404/пусто), мутации (edit/archive/delete/убрать
 * membership) и URL-фильтр источника (?source=). Презентация — desktop/mobile-ветка (JS, не CSS:
 * обе несут WidgetGroup с фикс. id, монтируется одна за раз). Роли: viewer read-only.
 */
export function CampaignPage() {
  const params = useParams();
  const id = /^\d+$/.test(params.id ?? '') ? Number(params.id) : null;
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const summaryQ = useCampaignSummary(id);
  const postsQ = useCampaignPosts(id);
  const update = useUpdateCampaign(id ?? 0);
  const del = useDeleteCampaign();
  const removePosts = useRemoveCampaignPosts();
  const [editOpen, setEditOpen] = useState(false);

  const baseSummary = summaryQ.data?.summary;
  const sourceOptions = useMemo(
    () => campaignSourceOptions(baseSummary?.by_source ?? []),
    [baseSummary?.by_source],
  );
  const rawSource = searchParams.get('source');
  const requestedSource = useMemo(() => parseCampaignSourceKey(rawSource), [rawSource]);
  const selectedSource = requestedSource && sourceOptions.some(
    (option) => option.key === campaignSourceKey(requestedSource),
  )
    ? requestedSource
    : null;
  const scopedSummaryQ = useCampaignSummary(id, selectedSource, baseSummary != null && selectedSource != null);
  const summary = selectedSource ? scopedSummaryQ.data?.summary : baseSummary;
  const campaign = baseSummary?.campaign ?? summary?.campaign ?? null;
  const posts = useMemo(
    () => filterCampaignPosts(postsQ.data?.posts ?? [], selectedSource),
    [postsQ.data, selectedSource],
  );

  // Невалидный/устаревший ?source= (нет в опциях) чистим из URL, чтобы фильтр не залипал.
  useEffect(() => {
    if (!baseSummary || !rawSource || selectedSource) return;
    const next = new URLSearchParams(searchParams);
    next.delete('source');
    setSearchParams(next, { replace: true });
  }, [baseSummary, rawSource, searchParams, selectedSource, setSearchParams]);

  const onSelectSource = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('source', value);
    else next.delete('source');
    setSearchParams(next);
  };

  if (id == null) return <EmptyState title="Кампания не найдена" action={{ to: CAMPAIGNS_LIST, label: 'К списку кампаний' }} />;
  if (summaryQ.isPending) return <CampaignPageSkeleton />;
  if (summaryQ.isError) {
    const notFound = summaryQ.error instanceof ApiError && summaryQ.error.status === 404;
    if (notFound) {
      return (
        <EmptyState
          title="Кампания не найдена"
          reason="Она могла быть удалена, или у вас нет к ней доступа."
          action={{ to: CAMPAIGNS_LIST, label: 'К списку кампаний' }}
        />
      );
    }
    return (
      <ErrorState
        title="Не удалось загрузить кампанию"
        reason={summaryQ.error instanceof Error ? summaryQ.error.message : 'ошибка сервера'}
        onRetry={() => summaryQ.refetch()}
        retrying={summaryQ.isRefetching}
      />
    );
  }
  if (selectedSource && scopedSummaryQ.isPending) return <CampaignPageSkeleton />;
  if (selectedSource && scopedSummaryQ.isError) {
    return (
      <ErrorState
        title="Не удалось загрузить данные источника"
        reason={scopedSummaryQ.error instanceof Error ? scopedSummaryQ.error.message : 'ошибка сервера'}
        onRetry={() => scopedSummaryQ.refetch()}
        retrying={scopedSummaryQ.isRefetching}
      />
    );
  }
  if (!summary || !campaign) return <EmptyState title="Кампания не найдена" action={{ to: CAMPAIGNS_LIST, label: 'К списку кампаний' }} />;

  const isArchived = campaign.status === 'archived';
  const onDelete = async () => {
    const ok = await confirm({
      title: `Удалить кампанию «${campaign.name}»?`,
      reason: 'Публикации останутся в источниках — удаляется только группировка.',
    });
    if (!ok) return;
    del.mutate(campaign.id, { onSuccess: () => navigate(CAMPAIGNS_LIST) });
  };
  const onToggleArchive = () => {
    update.mutate({ status: isArchived ? 'active' : 'archived' });
  };
  const removeMembership = (list: CampaignPost[]) => {
    removePosts.mutate({
      campaignId: campaign.id,
      items: list.map((p) => ({ network: p.network as 'tg' | 'ig', channel_id: p.channel_id, post_ref: p.post_ref })),
    });
  };
  const onRemovePost = async (p: CampaignPost) => {
    const ok = await confirm({
      title: 'Убрать публикацию из кампании?',
      reason: 'Сама публикация не удаляется.',
      actionLabel: 'Убрать',
    });
    if (!ok) return;
    removeMembership([p]);
  };
  const onRemovePosts = async (list: CampaignPost[]) => {
    if (list.length === 0) return;
    const ok = await confirm({
      title: `Убрать ${list.length} публ. из кампании?`,
      reason: 'Сами публикации не удаляются.',
      actionLabel: 'Убрать',
    });
    if (!ok) return;
    removeMembership(list);
  };

  const viewProps: CampaignViewProps = {
    campaign,
    summary,
    baseSummary,
    posts,
    postsQ,
    canEdit: canEditCampaign(campaign),
    isArchived,
    sourceOptions,
    selectedSource,
    onSelectSource,
    onEdit: () => setEditOpen(true),
    onToggleArchive,
    onDelete,
    onRemovePost,
    onRemovePosts,
    archivePending: update.isPending,
    deletePending: del.isPending,
    removePending: removePosts.isPending,
  };

  return (
    <>
      {isDesktop ? <CampaignPageDesktop {...viewProps} /> : <CampaignPageMobile {...viewProps} />}
      {editOpen && <CampaignDialog initial={campaign} onClose={() => setEditOpen(false)} />}
    </>
  );
}

function CampaignPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid grid-cols-3 gap-6 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-12" />
          </div>
        ))}
      </div>
      <Skeleton className="h-[264px] w-full" />
    </div>
  );
}
