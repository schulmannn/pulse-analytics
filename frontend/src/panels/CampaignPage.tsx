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
import { BarChart } from '@/components/BarChart';
import { ChartSection } from '@/components/ChartWidget';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LineChart } from '@/components/LineChart';
import { PieChart } from '@/components/PieChart';
import { CampaignDialog } from '@/components/campaigns/CampaignDialog';
import {
  CampaignColorDot,
  CampaignStatusChip,
  NetworkBadge,
  campaignPeriodLabel,
  canEditCampaign,
} from '@/components/campaigns/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import {
  comparisonText,
  comparisonUnavailableText,
  campaignExtremes,
  formatSlices,
  platformKpis,
  ratioLabel,
  timelineSeries,
} from '@/lib/campaignSummary';
import {
  campaignSourceKey,
  campaignSourceOptions,
  filterCampaignPosts,
  parseCampaignSourceKey,
} from '@/lib/campaignSources';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * Страница кампании: сводка (платформы раздельно, методологии подписаны), динамика
 * публикаций/охвата во времени, источники и форматы, таблица публикаций с удалением
 * membership. Роли: viewer — read-only (my_role приходит с сервера), member+ видит
 * действия. Ширины виджетов — только half (50%) и full (100%); временные line-чарты
 * всегда full.
 */
export function CampaignPage() {
  const params = useParams();
  const id = /^\d+$/.test(params.id ?? '') ? Number(params.id) : null;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

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
  const canEdit = canEditCampaign(campaign);

  useEffect(() => {
    if (!baseSummary || !rawSource || selectedSource) return;
    const next = new URLSearchParams(searchParams);
    next.delete('source');
    setSearchParams(next, { replace: true });
  }, [baseSummary, rawSource, searchParams, selectedSource, setSearchParams]);

  const selectSource = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('source', value);
    else next.delete('source');
    setSearchParams(next);
  };

  if (id == null) return <EmptyState title="Кампания не найдена" action={{ to: '/posts?view=campaigns', label: 'К списку кампаний' }} />;
  if (summaryQ.isPending) return <CampaignPageSkeleton />;
  if (summaryQ.isError) {
    const notFound = summaryQ.error instanceof ApiError && summaryQ.error.status === 404;
    if (notFound) {
      return (
        <EmptyState
          title="Кампания не найдена"
          reason="Она могла быть удалена, или у вас нет к ней доступа."
          action={{ to: '/posts?view=campaigns', label: 'К списку кампаний' }}
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
  if (!summary || !campaign) return <EmptyState title="Кампания не найдена" action={{ to: '/posts?view=campaigns', label: 'К списку кампаний' }} />;

  const kpis = platformKpis(summary);
  const series = timelineSeries(summary.timeline);
  const slices = formatSlices(summary.by_format);
  const cmpText = comparisonText(summary);
  const cmpMissing = comparisonUnavailableText(summary);
  const extremes = campaignExtremes(summary);
  const isArchived = campaign.status === 'archived';

  const onDelete = () => {
    if (!window.confirm(`Удалить кампанию «${campaign.name}»? Публикации останутся в источниках.`)) return;
    del.mutate(campaign.id, { onSuccess: () => navigate('/posts?view=campaigns') });
  };
  const onToggleArchive = () => {
    update.mutate({ status: isArchived ? 'active' : 'archived' });
  };
  const onRemovePost = (p: CampaignPost) => {
    if (!window.confirm('Убрать публикацию из кампании? Сама публикация не удаляется.')) return;
    removePosts.mutate({
      campaignId: campaign.id,
      items: [{ network: p.network as 'tg' | 'ig', channel_id: p.channel_id, post_ref: p.post_ref }],
    });
  };

  return (
    <div className="space-y-8">
      {/* ── Шапка кампании ── */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {campaign.color ? <CampaignColorDot color={campaign.color} className="size-3" /> : null}
          <h2 className="text-2xl font-medium tracking-tight text-foreground" data-testid="campaign-name">
            {campaign.name}
          </h2>
          <CampaignStatusChip status={campaign.status} />
          {campaign.start_date || campaign.end_date ? (
            <span className="text-sm text-muted-foreground">{campaignPeriodLabel(campaign)}</span>
          ) : null}
          {canEdit && (
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Изменить
              </button>
              <button
                type="button"
                onClick={onToggleArchive}
                disabled={update.isPending}
                className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                data-testid="campaign-archive-toggle"
              >
                {update.isPending ? '…' : isArchived ? 'Вернуть из архива' : 'В архив'}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={del.isPending}
                className="btn-pill px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                {del.isPending ? 'Удаление…' : 'Удалить'}
              </button>
            </div>
          )}
        </div>
        {campaign.description ? <p className="max-w-2xl text-sm text-muted-foreground">{campaign.description}</p> : null}
        {sourceOptions.length > 0 && (
          <label className="inline-flex w-fit items-center gap-2 text-xs text-muted-foreground">
            <span>Источник</span>
            <select
              value={selectedSource ? campaignSourceKey(selectedSource) : ''}
              onChange={(event) => selectSource(event.target.value)}
              className="h-8 min-w-56 rounded border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus:border-primary"
              data-testid="campaign-source-filter"
            >
              <option value="">Все источники</option>
              {sourceOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label} · {fmt.num(option.posts)} публ.
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-xs text-muted-foreground">
          {selectedSource
            ? `${fmt.num(summary.posts_total)} из ${fmt.num(baseSummary?.posts_total ?? summary.posts_total)} публ.`
            : `${fmt.num(summary.posts_total)} публ.`}
          {summary.undated_posts > 0 ? ` · без даты: ${fmt.num(summary.undated_posts)}` : ''}
          {summary.period?.from ? ` · период данных: ${summary.period.from} — ${summary.period.to}` : ''}
        </p>
        {summary.inaccessible_posts > 0 && (
          <p className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {fmt.num(summary.inaccessible_posts)} публ. из источников, недоступных вам, — они не входят в метрики ниже.
          </p>
        )}
      </div>

      {summary.posts_total === 0 ? (
        <EmptyState
          title={selectedSource ? 'У этого источника нет публикаций в кампании' : 'В кампании пока нет публикаций'}
          reason={selectedSource
            ? 'Выберите другой источник или вернитесь к сводке по всем источникам.'
            : 'Откройте «Контент», выберите публикации галочками и добавьте их в эту кампанию.'}
          action={{
            to: selectedSource?.network === 'ig' ? '/instagram/content' : '/posts',
            label: 'К списку публикаций',
          }}
        />
      ) : (
        <>
          {/* ── KPI: платформы раздельно, без смешивания методологий ── */}
          {(kpis.tg.length > 0 || kpis.ig.length > 0) && (
            <div className="space-y-4">
              {([['tg', kpis.tg], ['ig', kpis.ig]] as const).map(([net, tiles]) =>
                tiles.length === 0 ? null : (
                  <div key={net}>
                    <div className="mb-2 flex items-center gap-2">
                      <NetworkBadge network={net} />
                      <span className="text-2xs text-muted-foreground">
                        {net === 'tg'
                          ? 'Telegram: просмотры = показы поста'
                          : 'Instagram: сумма охватов публикаций без дедупликации аудитории; просмотры = plays'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
                      {tiles.map((t) => (
                        <div key={t.label} title={t.hint}>
                          <div className="text-2xs font-medium tracking-wider text-muted-foreground">{t.label}</div>
                          <div className="mt-1 text-xl font-medium tabular-nums text-foreground">{t.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              )}
              <p className="text-2xs text-muted-foreground" data-testid="campaign-comparison">
                {cmpText ?? cmpMissing}
              </p>
            </div>
          )}

          {/* ── Динамика и разбивки. Line-чарты времени — только full-ширина. ── */}
          <WidgetGroup id="campaign-charts" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
            {series.hasTg && (
              <ChartSection title="Просмотры TG · по дате публикации" fixedSize="full" noExpand>
                <LineChart values={series.tgViews} labels={series.labels} titles={series.titles} showPoints fullAxes />
              </ChartSection>
            )}
            {series.hasIg && (
              <ChartSection title="Сумма охватов IG · по дате публикации" fixedSize="full" noExpand>
                <LineChart values={series.igReach} labels={series.labels} titles={series.titles} showPoints fullAxes />
              </ChartSection>
            )}
            <ChartSection title="Публикации по дням" fixedSize="half" noExpand>
              <BarChart values={series.posts} labels={series.labels} titles={series.titles} />
            </ChartSection>
            <ChartSection title="Форматы" fixedSize="half" noExpand>
              {slices.values.length > 0 ? (
                <PieChart values={slices.values} labels={slices.labels} titles={slices.titles} />
              ) : (
                <EmptyState compact title="Нет данных о форматах." />
              )}
            </ChartSection>
            <ChartSection title="Источники" fixedSize="half" noExpand>
              <div className="flex h-full flex-col justify-start gap-2 overflow-y-auto">
                {summary.by_source.map((s) => (
                  <div key={`${s.network}:${s.channel_id}`} className="flex items-center gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <NetworkBadge network={s.network} />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {s.title || s.username || `Канал #${s.channel_id}`}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">{fmt.num(s.posts)} публ.</span>
                    <span className="w-20 text-right text-xs font-medium tabular-nums text-foreground">
                      {s.network === 'tg'
                        ? s.tg_views != null
                          ? fmt.short(s.tg_views)
                          : '—'
                        : s.ig_reach != null
                          ? fmt.short(s.ig_reach)
                          : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </ChartSection>
            <ChartSection title="Лучшее и худшее · к медиане платформы" fixedSize="half" noExpand>
              <div className="flex h-full flex-col justify-center gap-3">
                {([
                  ['Лучший пост', extremes.best],
                  ['Слабейший пост', extremes.worst],
                ] as const).map(([label, post]) =>
                  post ? (
                    <div key={label} className="flex items-center gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="min-w-0 flex-1">
                        <div className="text-2xs font-medium tracking-wider text-muted-foreground">{label}</div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <NetworkBadge network={post.network ?? 'tg'} />
                          <span className="min-w-0 truncate text-sm text-foreground">
                            {post.caption ? markdownToPlainText(post.caption) : `Публикация ${post.post_ref}`}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium tabular-nums text-foreground">{fmt.short(Number(post.value ?? 0))}</div>
                        <div className={cn('text-2xs', label === 'Лучший пост' ? 'text-verdant' : 'text-ember')}>
                          {ratioLabel(post.ratio) ?? ''}
                        </div>
                      </div>
                    </div>
                  ) : null,
                )}
                {!extremes.best && <EmptyState compact title="Недостаточно данных для сравнения постов." />}
              </div>
            </ChartSection>
          </WidgetGroup>

          {/* ── Таблица публикаций кампании ── */}
          <div>
            <h3 className="mb-3 text-sm font-medium text-foreground">Публикации кампании</h3>
            {postsQ.isPending ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : postsQ.isError ? (
              <ErrorState title="Не удалось загрузить публикации" onRetry={() => postsQ.refetch()} retrying={postsQ.isRefetching} />
            ) : posts.length === 0 ? (
              <EmptyState compact title="Публикаций нет." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm" data-testid="campaign-posts-table">
                  <thead>
                    <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                      <th className="py-3 pl-0 pr-3">Источник</th>
                      <th className="min-w-[220px] px-3 py-3">Пост</th>
                      <th className="px-3 py-3">Дата</th>
                      <th className="px-3 py-3 text-right">Просмотры</th>
                      <th className="px-3 py-3 text-right">Охват</th>
                      <th className="px-3 py-3 text-right">Реакции/Лайки</th>
                      <th className="px-3 py-3 text-right">Репосты</th>
                      {canEdit && <th className="px-3 py-3 text-right last:pr-0"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {posts.map((p) => (
                      <tr key={`${p.network}:${p.channel_id}:${p.post_ref}`} className="transition-colors hover:bg-hover-row">
                        <td className="py-3 pl-0 pr-3">
                          <div className="flex items-center gap-2">
                            <NetworkBadge network={p.network} />
                            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
                              {p.accessible ? p.channel_title || p.channel_username || `#${p.channel_id}` : 'Источник недоступен'}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {p.accessible ? (
                            <span className={cn('line-clamp-1 max-w-md', p.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                              {p.caption ? markdownToPlainText(p.caption) : 'Без подписи'}
                            </span>
                          ) : (
                            <span className="italic text-muted-foreground">Содержимое скрыто</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                          {p.published_at ? fmt.date(p.published_at) : '—'}
                        </td>
                        <MetricCell value={p.network === 'tg' ? p.tg_views : p.ig_views} accessible={p.accessible} />
                        <MetricCell value={p.network === 'ig' ? p.ig_reach : null} accessible={p.accessible} />
                        <MetricCell value={p.network === 'tg' ? p.tg_reactions : p.ig_likes} accessible={p.accessible} />
                        <MetricCell value={p.network === 'tg' ? p.tg_forwards : p.ig_shares} accessible={p.accessible} />
                        {canEdit && (
                          <td className="px-3 py-3 text-right last:pr-0">
                            <button
                              type="button"
                              onClick={() => onRemovePost(p)}
                              disabled={removePosts.isPending}
                              className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                            >
                              Убрать
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {editOpen && <CampaignDialog initial={campaign} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

function MetricCell({ value, accessible }: { value: number | null | undefined; accessible: boolean }) {
  return (
    <td className="px-3 py-3 text-right font-medium tabular-nums text-muted-foreground">
      {!accessible || value == null ? <span className="text-muted-foreground/40">—</span> : fmt.short(value)}
    </td>
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
