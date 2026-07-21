import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
// Astryx runtime primitives (via the shared data-workspace boundary) — subpath imports for tree-shaking.
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text as AxText } from '@astryxdesign/core/Text';
import { Button as AxButton } from '@astryxdesign/core/Button';
import type { CampaignPost } from '@/api/schemas';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { SearchField } from '@/components/SearchField';
import { NetworkBadge } from '@/components/campaigns/shared';
import {
  WorkspaceInspector,
  WorkspaceSurface,
  WorkspaceViewToolbar,
  type WorkspaceDensity,
} from '@/components/data-workspace';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { Button } from '@/components/ui/button';
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
        <TableSkeleton rows={3} columns={5} />
      </Frame>
    );
  }
  if (postsQ.isError) {
    return (
      <Frame>
        <ErrorState compact title="Не удалось загрузить публикации" onRetry={() => postsQ.refetch()} retrying={postsQ.isRefetching} />
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

// The two configurable metric columns. Keys match PostSortKey, so column visibility, sorting and the
// inspector all read one source of truth. Publication/source/date + selection/remove stay pinned.
interface CampaignMetricCol {
  key: Extract<PostSortKey, 'result' | 'interactions'>;
  label: string;
  get: (p: CampaignPost) => CampaignPostMetric;
}
const METRIC_COLS: CampaignMetricCol[] = [
  { key: 'result', label: 'Основной результат', get: postPrimaryResult },
  { key: 'interactions', label: 'Взаимодействия', get: postInteractions },
];
const COLUMN_OPTIONS = METRIC_COLS.map((c) => ({ value: c.key, label: c.label }));
const ALL_COLUMN_KEYS = COLUMN_OPTIONS.map((o) => o.value);

/** Desktop: поиск + сортировка (URL) + счётчик + чекбоксы + групповое удаление + вид таблицы + инспектор. */
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
  // Table view state (local, not URL-backed): which metric columns show + row density.
  const [visibleCols, setVisibleCols] = useState<string[]>(ALL_COLUMN_KEYS);
  const [density, setDensity] = useState<WorkspaceDensity>('balanced');
  // openKey → the post shown in the adjacent inspector (row click).
  const [openKey, setOpenKey] = useState<string | null>(null);

  const rows = useMemo(
    () => sortPosts(filterPostsByQuery(posts, query), sort, order),
    [posts, query, sort, order],
  );

  // Выбор и инспектор чистим от строк, выпавших из фильтра/удалённых, чтобы действия не били вслепую.
  useEffect(() => {
    const visible = new Set(rows.map(postKey));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => visible.has(k)));
      return next.size === prev.size ? prev : next;
    });
    setOpenKey((prev) => (prev != null && !visible.has(prev) ? null : prev));
  }, [rows]);

  const patchTableState = (patch: Partial<CampaignPostTableState>) => {
    // URL is shared with sibling controls (source filter / chart mode). Reading the live location
    // prevents a fast sibling change from being overwritten before this component re-renders.
    const current = new URLSearchParams(window.location.search);
    const next = applyCampaignPostTableState(current, { ...parseCampaignPostTableState(current), ...patch });
    setSearchParams(next, { replace: true });
  };
  const onSort = (key: PostSortKey) => {
    if (key === sort) patchTableState({ order: order === 'desc' ? 'asc' : 'desc' });
    else patchTableState({ sort: key, order: 'desc' });
  };

  // Скрытие активной метрики сортировки безопасно возвращает сортировку к «дата, убыв».
  const updateVisibleColumns = (next: string[]) => {
    setVisibleCols(next);
    if (sort !== 'date' && !next.includes(sort)) patchTableState({ sort: 'date', order: 'desc' });
  };
  const shownMetricCols = METRIC_COLS.filter((c) => visibleCols.includes(c.key));

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

  const openPost = openKey != null ? rows.find((p) => postKey(p) === openKey) ?? null : null;

  return (
    <WorkspaceSurface>
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 className="text-sm font-medium text-foreground">Публикации кампании</h3>
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="campaign-posts-count">
            {query ? `${fmt.num(rows.length)} из ${fmt.num(posts.length)} публ.` : `${fmt.num(posts.length)} публ.`}
          </span>
          <SearchField
            className="ml-auto min-w-52"
            value={query}
            onChange={(q) => patchTableState({ q })}
            ariaLabel="Поиск публикаций кампании"
            placeholder="Поиск по подписи или источнику"
            testId="campaign-posts-search"
          />
        </div>

        {canEdit && (
          <div className="mb-2 flex min-h-8 items-center gap-2" data-testid="campaign-bulk-bar">
            {selectedRows.length > 0 ? (
              <>
                <span className="text-xs tabular-nums text-muted-foreground">Выбрано: {fmt.num(selectedRows.length)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={removeSelected}
                  disabled={removePending}
                  className="text-muted-foreground hover:text-destructive"
                  data-testid="campaign-bulk-remove"
                >
                  {removePending ? 'Убираю…' : 'Убрать выбранные'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  Снять выбор
                </Button>
              </>
            ) : (
              <span className="text-2xs text-muted-foreground">Отметьте публикации, чтобы убрать их из кампании</span>
            )}
          </div>
        )}

        <div className="mb-3">
          <WorkspaceViewToolbar
            columns={COLUMN_OPTIONS}
            visibleColumns={visibleCols}
            onVisibleColumnsChange={updateVisibleColumns}
            selectAllLabel="Все показатели"
            density={density}
            onDensityChange={setDensity}
          />
        </div>

        <div
          className={cn(
            'grid gap-6 lg:items-start',
            openPost && 'lg:grid-cols-[minmax(0,1fr)_minmax(300px,340px)]',
          )}
        >
          <div className="min-w-0">
            {rows.length === 0 ? (
              <EmptyState compact title="Ничего не найдено по запросу." />
            ) : (
              <div className="data-table-surface">
                <div className="data-table-scroll">
                  <table
                    className="data-table text-left text-sm"
                    data-testid="campaign-posts-table"
                    data-density={density}
                  >
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
                      {shownMetricCols.map((c) => (
                        <SortHeader key={c.key} label={c.label} active={sort === c.key} order={order} onClick={() => onSort(c.key)} align="right" />
                      ))}
                      <SortHeader label="Дата" active={sort === 'date'} order={order} onClick={() => onSort('date')} align="left" />
                      {canEdit && <th className="px-3 py-3 text-right last:pr-0"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((p) => {
                      const k = postKey(p);
                      const isOpen = k === openKey;
                      const isSelected = selected.has(k);
                      return (
                        <tr
                          key={k}
                          data-campaign-post-row
                          data-campaign-post-open={isOpen ? '' : undefined}
                          onClick={() => setOpenKey(k)}
                          className={cn(
                            'cursor-pointer transition-colors',
                            isOpen ? 'bg-primary/10' : isSelected ? 'bg-primary/5 hover:bg-primary/8' : 'hover:bg-hover-row',
                          )}
                        >
                          {canEdit && (
                            <td className="py-3 pl-0 pr-2" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                aria-label="Выбрать публикацию"
                                checked={selected.has(k)}
                                onCheckedChange={() => toggle(p)}
                                data-testid="campaign-post-select"
                              />
                            </td>
                          )}
                          <PostCell post={p} first onOpen={() => setOpenKey(k)} />
                          <SourceCell post={p} />
                          {shownMetricCols.map((c) => (
                            <CampaignMetricCell key={c.key} metric={c.get(p)} />
                          ))}
                          <td className="px-3 py-3 text-xs tabular-nums text-muted-foreground">
                            {p.published_at ? fmt.date(p.published_at) : '—'}
                          </td>
                          {canEdit && (
                            <td className="px-3 py-3 text-right last:pr-0" onClick={(e) => e.stopPropagation()}>
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
              </div>
            )}
          </div>

          {openPost && (
            <CampaignPostInspector
              post={openPost}
              canEdit={canEdit}
              removePending={removePending}
              onClose={() => setOpenKey(null)}
              onRemove={() => onRemovePost(openPost)}
            />
          )}
        </div>
      </div>
    </WorkspaceSurface>
  );
}

/**
 * Соседний инспектор выбранной строки — read-first сводка на Astryx LayoutPanel. Читает уже
 * загруженную публикацию и те же campaign-хелперы, что и таблица: сеть/источник, подпись, дата,
 * основной результат и взаимодействия с честной семантикой недоступности. Ничего не пересчитывает.
 */
function CampaignPostInspector({
  post,
  canEdit,
  removePending,
  onClose,
  onRemove,
}: {
  post: CampaignPost;
  canEdit: boolean;
  removePending: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  const primary = postPrimaryResult(post);
  const interactions = postInteractions(post);
  const sourceLabel = post.accessible
    ? post.channel_title || post.channel_username || `#${post.channel_id}`
    : 'Источник недоступен';
  const metricText = (metric: CampaignPostMetric) => (metric.value == null ? '—' : fmt.short(metric.value));
  return (
    <WorkspaceInspector
      label="Детали выбранной публикации"
      title="Детали публикации"
      onClose={onClose}
      bodyProps={{ 'data-campaign-inspector': '', 'data-campaign-inspector-open': '' }}
      footer={
        canEdit ? (
          <AxButton
            label={removePending ? 'Убираю…' : 'Убрать из кампании'}
            variant="secondary"
            size="sm"
            isDisabled={removePending}
            onClick={onRemove}
          />
        ) : undefined
      }
    >
      <div className="flex items-center gap-2">
        <NetworkBadge network={post.network} />
        <AxText type="supporting" size="2xs">{sourceLabel}</AxText>
      </div>
      <AxText type="label" maxLines={3}>
        {post.accessible
          ? post.caption
            ? markdownToPlainText(post.caption)
            : 'Без подписи'
          : 'Содержимое скрыто'}
      </AxText>
      {post.published_at && <AxText type="supporting" size="2xs">{fmt.date(post.published_at)}</AxText>}

      <MetadataList title="Показатели" columns="single" label={{ position: 'start' }}>
        <MetadataListItem label={primary.label}>{metricText(primary)}</MetadataListItem>
        <MetadataListItem label={interactions.label}>{metricText(interactions)}</MetadataListItem>
      </MetadataList>
    </WorkspaceInspector>
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

function PostCell({ post: p, first = false, onOpen }: { post: CampaignPost; first?: boolean; onOpen?: () => void }) {
  const body = p.accessible ? (
    <span className={cn('line-clamp-1 max-w-md', p.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
      {p.caption ? markdownToPlainText(p.caption) : 'Без подписи'}
    </span>
  ) : (
    <span className="italic text-muted-foreground">Содержимое скрыто</span>
  );
  return (
    <td className={cn(first ? 'py-3 pl-0 pr-3' : 'px-3 py-3')}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          data-campaign-post-open-trigger
          className="block w-full max-w-md rounded text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/45"
        >
          {body}
        </button>
      ) : (
        body
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
