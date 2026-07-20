import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CampaignPost } from '@/api/schemas';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { NetworkBadge } from '@/components/campaigns/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import {
  applyCampaignPostTableState,
  filterPostsByQuery,
  parseCampaignPostTableState,
  type CampaignPostMetric,
  type CampaignPostTableState,
  type PostSortKey,
  postInteractions,
  postPrimaryResult,
  type SortOrder,
  sortPosts,
} from '@/lib/campaignPageModel';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import type { CampaignPostsQuery } from '@/panels/campaign/campaignView';

const postKey = (p: CampaignPost) => `${p.network}:${p.channel_id}:${p.post_ref}`;

/**
 * Desktop-таблица сводит сети в две честно подписанные колонки: «Основной результат» использует
 * tg_views или ig_reach, «Взаимодействия» — сумму доступных реакций конкретной сети. Подпись под
 * каждым числом всегда раскрывает методологию строки. Мутация «убрать» затрагивает только
 * membership, публикация цела.
 *
 * `interactive` (desktop) добавляет поиск, сортировку по колонкам (URL: `q`/`sort`/`order`),
 * счётчик результата, чекбоксы и групповое удаление. Без него (mobile) — прежняя простая таблица.
 */
export function CampaignPostsTable({
  posts,
  postsQ,
  canEdit,
  onRemovePost,
  onRemovePosts,
  removePending,
  interactive = false,
}: {
  posts: CampaignPost[];
  postsQ: CampaignPostsQuery;
  canEdit: boolean;
  onRemovePost: (post: CampaignPost) => void;
  onRemovePosts?: (posts: CampaignPost[]) => void;
  removePending: boolean;
  interactive?: boolean;
}) {
  if (postsQ.isPending) {
    return (
      <Frame>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </Frame>
    );
  }
  if (postsQ.isError) {
    return (
      <Frame>
        <ErrorState title="Не удалось загрузить публикации" onRetry={() => postsQ.refetch()} retrying={postsQ.isRefetching} />
      </Frame>
    );
  }
  if (posts.length === 0) {
    return (
      <Frame>
        <EmptyState compact title="Публикаций нет." />
      </Frame>
    );
  }
  return interactive ? (
    <InteractivePostsTable posts={posts} canEdit={canEdit} onRemovePost={onRemovePost} onRemovePosts={onRemovePosts} removePending={removePending} />
  ) : (
    <Frame>
      <SimplePostsTable posts={posts} canEdit={canEdit} onRemovePost={onRemovePost} removePending={removePending} />
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-foreground">Публикации кампании</h3>
      {children}
    </div>
  );
}

const SORT_COLUMNS: { key: PostSortKey; label: string }[] = [
  { key: 'result', label: 'Основной результат' },
  { key: 'interactions', label: 'Взаимодействия' },
];

/** Desktop: поиск + сортировка (URL) + счётчик + чекбоксы + групповое удаление. */
function InteractivePostsTable({
  posts,
  canEdit,
  onRemovePost,
  onRemovePosts,
  removePending,
}: {
  posts: CampaignPost[];
  canEdit: boolean;
  onRemovePost: (post: CampaignPost) => void;
  onRemovePosts?: (posts: CampaignPost[]) => void;
  removePending: boolean;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tableState = useMemo(() => parseCampaignPostTableState(searchParams), [searchParams]);
  const { q: query, sort, order } = tableState;

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () => sortPosts(filterPostsByQuery(posts, query), sort, order),
    [posts, query, sort, order],
  );

  // Выбор чистим от строк, выпавших из фильтра/удалённых, чтобы «Убрать выбранные» не бил вслепую.
  useEffect(() => {
    const visible = new Set(rows.map(postKey));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => visible.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const patchTableState = (patch: Partial<CampaignPostTableState>) => {
    setSearchParams(applyCampaignPostTableState(searchParams, { ...tableState, ...patch }), { replace: true });
  };
  const onSort = (key: PostSortKey) => {
    if (key === sort) patchTableState({ order: order === 'desc' ? 'asc' : 'desc' });
    else patchTableState({ sort: key, order: 'desc' });
  };

  const selectedRows = rows.filter((p) => selected.has(postKey(p)));
  const allVisibleSelected = rows.length > 0 && rows.every((p) => selected.has(postKey(p)));
  const toggle = (p: CampaignPost) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = postKey(p);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(rows.map(postKey)));
  const removeSelected = () => {
    if (selectedRows.length === 0) return;
    onRemovePosts?.(selectedRows);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="text-sm font-medium text-foreground">Публикации кампании</h3>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="campaign-posts-count">
          {query ? `${fmt.num(rows.length)} из ${fmt.num(posts.length)} публ.` : `${fmt.num(posts.length)} публ.`}
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => patchTableState({ q: e.target.value })}
          aria-label="Поиск публикаций кампании"
          placeholder="Поиск по подписи или источнику"
          className="ml-auto h-8 min-w-52 rounded border border-border bg-background px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:bg-muted focus:border-primary"
          data-testid="campaign-posts-search"
        />
      </div>

      {canEdit && (
        <div className="mb-2 flex min-h-8 items-center gap-2" data-testid="campaign-bulk-bar">
          {selectedRows.length > 0 ? (
            <>
              <span className="text-xs tabular-nums text-muted-foreground">Выбрано: {fmt.num(selectedRows.length)}</span>
              <button
                type="button"
                onClick={removeSelected}
                disabled={removePending}
                className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50"
                data-testid="campaign-bulk-remove"
              >
                {removePending ? 'Убираю…' : 'Убрать выбранные'}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="btn-pill px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Снять выбор
              </button>
            </>
          ) : (
            <span className="text-2xs text-muted-foreground">Отметьте публикации, чтобы убрать их из кампании</span>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState compact title="Ничего не найдено по запросу." />
      ) : (
        <div className="data-table-surface data-table-scroll">
          <table className="data-table text-left text-sm" data-testid="campaign-posts-table">
            <thead>
              <tr className="border-b border-border text-xs font-medium text-muted-foreground">
                {canEdit && (
                  <th className="w-10 py-3 pl-0 pr-2">
                    <Checkbox
                      aria-label="Выбрать все публикации"
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAll}
                      data-testid="campaign-select-all"
                    />
                  </th>
                )}
                <th className="min-w-[260px] py-3 pl-0 pr-3">Публикация</th>
                <th className="min-w-[160px] px-3 py-3">Источник</th>
                {SORT_COLUMNS.map((c) => (
                  <SortHeader key={c.key} label={c.label} active={sort === c.key} order={order} onClick={() => onSort(c.key)} align="right" />
                ))}
                <SortHeader label="Дата" active={sort === 'date'} order={order} onClick={() => onSort('date')} align="left" />
                {canEdit && <th className="px-3 py-3 text-right last:pr-0"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p) => {
                const k = postKey(p);
                return (
                  <tr key={k} className="transition-colors hover:bg-hover-row">
                    {canEdit && (
                      <td className="py-3 pl-0 pr-2">
                        <Checkbox
                          aria-label="Выбрать публикацию"
                          checked={selected.has(k)}
                          onCheckedChange={() => toggle(p)}
                          data-testid="campaign-post-select"
                        />
                      </td>
                    )}
                    <PostCell post={p} first />
                    <SourceCell post={p} />
                    <CampaignMetricCell metric={postPrimaryResult(p)} />
                    <CampaignMetricCell metric={postInteractions(p)} />
                    <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                      {p.published_at ? fmt.date(p.published_at) : '—'}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-3 text-right last:pr-0">
                        <button
                          type="button"
                          onClick={() => onRemovePost(p)}
                          disabled={removePending}
                          className="text-xs font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                        >
                          Убрать
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  active,
  order,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  order: SortOrder;
  onClick: () => void;
  align: 'left' | 'right';
}) {
  return (
    <th
      aria-sort={active ? (order === 'desc' ? 'descending' : 'ascending') : undefined}
      className={cn('px-3 py-3', align === 'right' ? 'text-right' : 'text-left')}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        <span className="text-2xs">{active ? (order === 'desc' ? '↓' : '↑') : ''}</span>
      </button>
    </th>
  );
}

/** Mobile / read-only: прежняя простая таблица без выбора и сортировки. */
function SimplePostsTable({
  posts,
  canEdit,
  onRemovePost,
  removePending,
}: {
  posts: CampaignPost[];
  canEdit: boolean;
  onRemovePost: (post: CampaignPost) => void;
  removePending: boolean;
}) {
  return (
    <div className="data-table-surface data-table-scroll">
      <table className="data-table text-left text-sm" data-testid="campaign-posts-table">
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
            <tr key={postKey(p)} className="transition-colors hover:bg-hover-row">
              <SourceCell post={p} first />
              <PostCell post={p} />
              <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                {p.published_at ? fmt.date(p.published_at) : '—'}
              </td>
              <LegacyMetricCell value={p.network === 'tg' ? p.tg_views : p.ig_views} accessible={p.accessible} />
              <LegacyMetricCell value={p.network === 'ig' ? p.ig_reach : null} accessible={p.accessible} />
              <LegacyMetricCell value={p.network === 'tg' ? p.tg_reactions : p.ig_likes} accessible={p.accessible} />
              <LegacyMetricCell value={p.network === 'tg' ? p.tg_forwards : p.ig_shares} accessible={p.accessible} />
              {canEdit && (
                <td className="px-3 py-3 text-right last:pr-0">
                  <button
                    type="button"
                    onClick={() => onRemovePost(p)}
                    disabled={removePending}
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
  );
}

function SourceCell({ post: p, first = false }: { post: CampaignPost; first?: boolean }) {
  return (
    <td className={cn(first ? 'py-3 pl-0 pr-3' : 'px-3 py-3')}>
      <div className="flex items-center gap-2">
        <NetworkBadge network={p.network} />
        <span className="max-w-[140px] truncate text-xs text-muted-foreground">
          {p.accessible ? p.channel_title || p.channel_username || `#${p.channel_id}` : 'Источник недоступен'}
        </span>
      </div>
    </td>
  );
}

function PostCell({ post: p, first = false }: { post: CampaignPost; first?: boolean }) {
  return (
    <td className={cn(first ? 'py-3 pl-0 pr-3' : 'px-3 py-3')}>
      {p.accessible ? (
        <span className={cn('line-clamp-1 max-w-md', p.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
          {p.caption ? markdownToPlainText(p.caption) : 'Без подписи'}
        </span>
      ) : (
        <span className="italic text-muted-foreground">Содержимое скрыто</span>
      )}
    </td>
  );
}

function CampaignMetricCell({ metric }: { metric: CampaignPostMetric }) {
  return (
    <td className="min-w-[190px] px-3 py-3 text-right tabular-nums">
      <div className="font-medium text-foreground">
        {metric.value == null ? <span className="text-muted-foreground/40">—</span> : fmt.short(metric.value)}
      </div>
      <div className="mt-0.5 text-2xs text-muted-foreground" title={metric.label}>
        {metric.label}
      </div>
    </td>
  );
}

function LegacyMetricCell({ value, accessible }: { value: number | null | undefined; accessible: boolean }) {
  return (
    <td className="px-3 py-3 text-right font-medium tabular-nums text-muted-foreground">
      {!accessible || value == null ? <span className="text-muted-foreground/40">—</span> : fmt.short(value)}
    </td>
  );
}
