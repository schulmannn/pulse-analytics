import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
// Astryx runtime primitives (scoped design-system rollout) — subpath imports for tree-shaking.
import { Token } from '@astryxdesign/core/Token';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text as AxText } from '@astryxdesign/core/Text';
import { Button as AxButton } from '@astryxdesign/core/Button';
import {
  WorkspaceInspector,
  WorkspaceSurface,
  WorkspaceViewToolbar,
  WORKSPACE_DENSITY_CELL,
  WORKSPACE_DENSITY_HEAD,
  type WorkspaceDensity,
} from '@/components/data-workspace';
import type { IgData } from '@/lib/useIgData';
import type { IgPost, CampaignPostInput } from '@/api/schemas';
import { useIgTags, useRemoveCampaignPosts } from '@/api/queries';
import { ChartSection } from '@/components/ChartWidget';
import { PillSelect } from '@/components/PillSelect';
import { SearchField } from '@/components/SearchField';
import { Button } from '@/components/ui/button';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { Section } from '@/components/instagram/shared';
import {
  ReelsBlock,
  FormatsBlock,
  HashtagsBlock,
  StoriesBlock,
  TagsBlock,
} from '@/components/instagram/content';
import { IgPostDetailModal } from '@/components/instagram/IgPostDetailModal';
import { AddToCampaignDialog } from '@/components/campaigns/AddToCampaignDialog';
import { CampaignFilterControl } from '@/components/campaigns/CampaignFilterControl';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { RichText } from '@/components/RichText';
import { exportIgPosts } from '@/lib/igExport';
import { exportFilename } from '@/lib/analyticsExport';
import { fmt } from '@/lib/format';
import { MEDIA_TYPE_LABEL } from '@/lib/igMetrics';
import { compareToMedian, medianDeltaLabel, periodMedian, MEDIAN_MIN_SAMPLE } from '@/lib/postMedian';
import {
  IG_SECONDARY_VIEWS,
  applyIgContentFilters,
  applyIgSecondaryView,
  classifyIgFormat,
  filterIgPosts,
  igEr,
  igInteractions,
  parseIgContentFilters,
  parseIgSecondaryView,
  sortIgPosts,
  type IgContentFilters,
  type IgContentFormat,
  type IgContentSort,
  type IgSecondaryView,
} from '@/lib/igContentFilters';
import { cn } from '@/lib/utils';
import { useIgScopedPosts, toCampaignItems } from '@/panels/instagram/igContentScope';

// ─────────────────────────────────────────────────────────────────────────────
// Desktop — Astryx data-workspace pilot: dense Publications table + a scoped Astryx
// table toolbar (column visibility · density), Astryx active-filter tokens, an
// adjacent selected-post inspector, and the secondary analyses behind a compact tab.
// The whole surface is wrapped in a pilot-scoped <Theme> that mirrors the app's mode;
// all business behaviour (URL-backed filters, campaign scope, selection/bulk actions,
// sort/median semantics, empty/loading/error) is preserved.
// ─────────────────────────────────────────────────────────────────────────────

const SECONDARY_LABEL: Record<IgSecondaryView, string> = {
  formats: 'Форматы',
  reels: 'Reels',
  hashtags: 'Хэштеги',
  stories: 'Stories',
  tags: 'Отметки',
};

const FORMAT_OPTIONS: { value: IgContentFormat; label: string }[] = [
  { value: 'all', label: 'Все форматы' },
  { value: 'photo', label: 'Фото' },
  { value: 'video', label: 'Видео' },
  { value: 'carousel', label: 'Карусель' },
  { value: 'reels', label: 'Reels' },
];

/** Human word for a post's honest media bucket — shared by the row badge and the inspector. */
function igFormatLabel(post: IgPost): string {
  const bucket = classifyIgFormat(post);
  if (bucket === 'reels') return 'Reels';
  if (bucket === 'carousel') return 'Карусель';
  if (bucket === 'video') return 'Видео';
  return MEDIA_TYPE_LABEL[post.media_type ?? ''] ?? 'Фото';
}

// The metric columns the table can show/hide + sort by. The getter is the single source of truth for
// the value, its sort (via IG_CONTENT_SORT_COLUMNS) AND the median comparison — no divergence.
type MetricTone = 'signal' | 'muted';
interface MetricCol {
  key: Exclude<IgContentSort, 'date'>;
  label: string;
  tone: MetricTone;
  get: (p: IgPost) => number | null;
  format: (v: number) => string;
}
const METRIC_COLS: MetricCol[] = [
  { key: 'reach', label: 'Охват', tone: 'signal', get: (p) => (p.reach == null ? null : Number(p.reach)), format: fmt.num },
  { key: 'views', label: 'Просмотры', tone: 'muted', get: (p) => (p.views == null ? null : Number(p.views)), format: fmt.num },
  { key: 'interactions', label: 'Взаимодействия', tone: 'muted', get: igInteractions, format: fmt.num },
  { key: 'saved', label: 'Сохранения', tone: 'muted', get: (p) => (p.saved == null ? null : Number(p.saved)), format: fmt.num },
  { key: 'shares', label: 'Репосты', tone: 'muted', get: (p) => (p.shares == null ? null : Number(p.shares)), format: fmt.num },
  { key: 'er', label: 'ER', tone: 'muted', get: igEr, format: (v) => `${v.toFixed(2)}%` },
];

/** Metric columns are optional; selection, publication identity and date stay visible. */
const COLUMN_OPTIONS: { value: string; label: string }[] = [
  ...METRIC_COLS.map((c) => ({ value: c.key, label: c.label })),
];
const ALL_COLUMN_KEYS = COLUMN_OPTIONS.map((o) => o.value);

export function IgContentDesktop({ ig, tabs }: { ig: IgData; tabs: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params);
  const { channelId, campaignId, campaignPostsQ, posts, formatItems } = useIgScopedPosts(ig);

  const filters = useMemo(() => parseIgContentFilters(params), [params]);
  const secondary = parseIgSecondaryView(params.get('more'));
  const removeMut = useRemoveCampaignPosts();

  // openId → the post shown in the adjacent inspector; detailId → the full modal (explicit action).
  const [openId, setOpenId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Снимок выбора при открытии диалога (onDone чистит selection; диалог живёт до экрана результата).
  const [addItems, setAddItems] = useState<CampaignPostInput[] | null>(null);
  // Table view state (local, not URL-backed): which columns show + row density.
  const [visibleCols, setVisibleCols] = useState<string[]>(ALL_COLUMN_KEYS);
  const [density, setDensity] = useState<WorkspaceDensity>('balanced');

  // Сброс выбора/инспектора при смене источника/кампании/окна/фильтров (примитивные deps — window.* стабильны).
  useEffect(() => {
    setSelected(new Set());
    setAddItems(null);
    setOpenId(null);
    setDetailId(null);
  }, [channelId, campaignId, ig.window.since, ig.window.until, filters.q, filters.format]);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  // React Router does not queue consecutive setSearchParams updaters like React state. Keep an
  // eager ref so a fast «clear search → pick format» sequence composes both URL changes.
  const commitParams = (next: URLSearchParams) => {
    paramsRef.current = next;
    setParams(next, { replace: true });
  };
  const update = (patch: Partial<IgContentFilters>) => {
    const current = paramsRef.current;
    commitParams(applyIgContentFilters(current, { ...parseIgContentFilters(current), ...patch }));
  };
  const toggleSort = (key: IgContentFilters['sort']) => {
    const current = parseIgContentFilters(paramsRef.current);
    update(key === current.sort ? { order: current.order === 'desc' ? 'asc' : 'desc' } : { sort: key, order: 'desc' });
  };
  const setSecondary = (next: IgSecondaryView) =>
    commitParams(applyIgSecondaryView(paramsRef.current, next));

  // Comparable-period scope = the windowed (campaign-scoped) set; medians measured over THIS set,
  // not the search subset, so a search never shifts the benchmark.
  const scope = posts;
  const visible = filterIgPosts(scope, { q: filters.q, format: filters.format });
  const rows = sortIgPosts(visible, filters.sort, filters.order);

  const medianOf = (get: (p: IgPost) => number | null) =>
    periodMedian(scope.map(get).filter((v): v is number => v != null));
  // One median per metric column, keyed the same as the column — used by cells AND the inspector.
  const medians = useMemo(
    () => Object.fromEntries(METRIC_COLS.map((c) => [c.key, medianOf(c.get)])) as Record<MetricCol['key'], number | null>,
    // scope identity is enough — the getters are module constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );
  const reachMedian = medians.reach;

  const shownMetricCols = METRIC_COLS.filter((c) => visibleCols.includes(c.key));
  const cellY = WORKSPACE_DENSITY_CELL[density];
  const headY = WORKSPACE_DENSITY_HEAD[density];

  const updateVisibleColumns = (next: string[]) => {
    setVisibleCols(next);
    if (filters.sort !== 'date' && !next.includes(filters.sort)) {
      update({ sort: 'date', order: 'desc' });
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const visibleIds = rows.map((p) => p.id).filter((id): id is string => !!id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });

  const selectedItems = toCampaignItems(rows, channelId, selected);
  const onRemoveFromCampaign = () => {
    if (campaignId == null || selectedItems.length === 0) return;
    removeMut.mutate({ campaignId, items: selectedItems }, { onSuccess: () => setSelected(new Set()) });
  };

  const openPost = openId != null ? scope.find((p) => p.id === openId) ?? null : null;
  const detailPost = detailId != null ? scope.find((p) => p.id === detailId) ?? null : null;
  const hasContentFilters = filters.q.trim() !== '' || filters.format !== 'all';

  const openFullDetail = (id: string) => setDetailId(id);
  const inspectorAddToCampaign = (post: IgPost) => {
    if (post.id == null || channelId == null) return;
    setAddItems(toCampaignItems([post], channelId, new Set([post.id])));
  };

  const toolbar = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {tabs}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            exportIgPosts(
              rows,
              exportFilename({
                network: 'instagram',
                section: 'content',
                source: ig.profile?.username ?? '',
                from: ig.window.since,
                to: ig.window.until,
              }),
            )
          }
          disabled={rows.length === 0}
          aria-label="Экспорт показанных публикаций в CSV"
          title={rows.length === 0 ? 'Нет публикаций для экспорта' : `CSV: ${rows.length} показанных публикаций`}
          className="text-muted-foreground"
        >
          Экспорт таблицы
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <CampaignFilterControl />
          <SearchField
            className="w-56"
            value={filters.q}
            onChange={(q) => update({ q })}
            placeholder="Поиск по тексту и хэштегам"
            ariaLabel="Поиск по публикациям"
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Формат</span>
            <PillSelect<IgContentFormat>
              value={filters.format}
              onValueChange={(v) => update({ format: v })}
              ariaLabel="Формат публикаций"
              testId="ig-format-filter"
              options={FORMAT_OPTIONS}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span className="tabular-nums" data-testid="ig-content-result-count">{fmt.num(rows.length)} публ.</span>
          {hasContentFilters && (
            <button type="button" onClick={() => update({ q: '', format: 'all' })} className="text-2xs font-medium text-primary hover:underline">
              Сбросить фильтры
            </button>
          )}
          {campaignId != null && campaignPostsQ.data && (
            <span className="tabular-nums">
              {fmt.num(scope.length)} из {fmt.num(campaignPostsQ.data.posts.length)} публ. кампании — из этого источника
            </span>
          )}
          {scope.length > 0 && reachMedian == null && <span>сравнение появится от {MEDIAN_MIN_SAMPLE} публикаций</span>}
        </div>
      </div>
      {/* Reusable data-workspace view toolbar — column visibility + row density. The search/format
          filters above stay native for their established URL/selectPill contracts. */}
      <WorkspaceViewToolbar
        columns={COLUMN_OPTIONS}
        visibleColumns={visibleCols}
        onVisibleColumnsChange={updateVisibleColumns}
        selectAllLabel="Все показатели"
        density={density}
        onDensityChange={setDensity}
      />
      {/* Активные фильтры — снимаемые Astryx-токены; модель уже в URL (igContentFilters), токены
          лишь визуализируют её и снимают по одному. */}
      {hasContentFilters && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="ig-filter-chips">
          {filters.q.trim() !== '' && (
            <Token
              label={`Поиск: «${filters.q.trim()}»`}
              size="sm"
              color="blue"
              description="Убрать поиск"
              onRemove={() => update({ q: '' })}
            />
          )}
          {filters.format !== 'all' && (
            <Token
              label={`Формат: ${FORMAT_OPTIONS.find((option) => option.value === filters.format)?.label ?? filters.format}`}
              size="sm"
              color="gray"
              description="Убрать фильтр формата"
              onRemove={() => update({ format: 'all' })}
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        {selectedItems.length > 0 ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">Выбрано: {fmt.num(selectedItems.length)}</span>
            <Button
              type="button"
              size="sm"
              onClick={() => setAddItems(selectedItems)}
              data-testid="add-to-campaign"
            >
              Добавить в кампанию
            </Button>
            {campaignId != null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRemoveFromCampaign}
                disabled={removeMut.isPending}
                data-testid="remove-from-campaign"
              >
                {removeMut.isPending ? 'Убираю…' : 'Убрать из кампании'}
              </Button>
            )}
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
          <span className="text-2xs text-muted-foreground">
            {campaignId != null
              ? 'Отметьте публикации, чтобы добавить или убрать их из кампании'
              : 'Отметьте публикации, чтобы добавить их в кампанию'}
          </span>
        )}
        {removeMut.isError && <span role="alert" className="text-2xs text-destructive">Не удалось убрать из кампании.</span>}
      </div>
    </>
  );

  const dialog = addItems && addItems.length > 0 && (
    <AddToCampaignDialog items={addItems} onClose={() => setAddItems(null)} onDone={() => setSelected(new Set())} />
  );
  const detail = detailPost && (
    <IgPostDetailModal
      post={detailPost}
      reachComparison={compareToMedian(detailPost.reach == null ? null : Number(detailPost.reach), reachMedian)}
      benchmarkUnavailable={reachMedian == null}
      onAddToCampaign={
        detailPost.id != null && channelId != null
          ? () => {
              const items = toCampaignItems([detailPost], channelId, new Set([detailPost.id!]));
              setDetailId(null);
              setAddItems(items);
            }
          : undefined
      }
      onClose={() => setDetailId(null)}
    />
  );

  const secondaryBlock = (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs text-muted-foreground">Разборы</span>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Дополнительные разборы контента">
          {IG_SECONDARY_VIEWS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={secondary === key}
              onClick={() => setSecondary(key)}
              className={cn(
                'btn-pill px-3 py-1 text-xs font-medium transition-colors',
                secondary === key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {SECONDARY_LABEL[key]}
            </button>
          ))}
        </div>
      </div>
      <IgSecondaryBody view={secondary} ig={ig} posts={scope} formatItems={formatItems} />
    </section>
  );
  const campaignDataBlocked = campaignId != null && (campaignPostsQ.isPending || campaignPostsQ.isError);

  // Self-contained shadcn card shell — the header (tabs/export + filters/table-view/actions) sits on a
  // tinted rule above whatever body the current state renders (skeleton / error / empty / table).
  const publicationsCard = (body: ReactNode) => (
    <section
      data-ig-content-publications
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs dark:border-white/6"
    >
      <div className="space-y-3 border-b border-border px-4 py-4 sm:px-5">{toolbar}</div>
      {body}
    </section>
  );

  const emptyMessage =
    campaignId != null && scope.length === 0
      ? 'В этой кампании нет публикаций из текущего источника за выбранный период.'
      : scope.length === 0
        ? 'За выбранный период публикаций нет.'
        : 'Ничего не найдено по выбранным фильтрам.';

  // ─── One card body per state (loading / error / empty / table) ────────────────
  let cardBody: ReactNode;
  if (campaignId != null && campaignPostsQ.isPending) {
    cardBody = <TableSkeleton rows={3} columns={5} className="px-4 py-4 sm:px-5" />;
  } else if (campaignId != null && campaignPostsQ.isError) {
    cardBody = (
      <ErrorState
        compact
        size="table"
        title="Не удалось загрузить публикации кампании"
        onRetry={() => campaignPostsQ.refetch()}
        retrying={campaignPostsQ.isRefetching}
      />
    );
  } else if (rows.length === 0) {
    cardBody = (
      <div data-testid="ig-content-empty">
        <EmptyState compact size="table" title={emptyMessage} />
      </div>
    );
  } else {
    cardBody = (
      <div className="overflow-x-auto" data-ig-content-table>
        <table className="data-table data-table--compact text-left text-sm" data-ig-content-density={density}>
          <thead>
            <tr className={cn('border-b border-border bg-muted/25 text-2xs font-medium tracking-wide text-muted-foreground')}>
              <th className={cn('w-10 pl-4 pr-2 sm:pl-5', headY)}>
                <Checkbox
                  aria-label="Выбрать все видимые публикации"
                  checked={allVisibleSelected}
                  onCheckedChange={toggleAllVisible}
                />
              </th>
              <th className={cn('w-12 pl-0 pr-3 text-center', headY)}></th>
              <th className={cn('min-w-[240px] px-3', headY)}>Публикация</th>
              {shownMetricCols.map((c) => {
                const active = c.key === filters.sort;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
                    className={cn('w-[104px] px-3 text-right', headY)}
                  >
                    <SortButton label={c.label} active={active} order={filters.order} onClick={() => toggleSort(c.key)} />
                  </th>
                );
              })}
              <th
                aria-sort={filters.sort === 'date' ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
                className={cn('w-[96px] px-3 pr-4 text-right sm:pr-5', headY)}
              >
                <SortButton label="Дата" active={filters.sort === 'date'} order={filters.order} onClick={() => toggleSort('date')} />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((post, idx) => {
              const clickable = post.id != null;
              const isOpen = post.id != null && post.id === openId;
              const isSelected = post.id != null && selected.has(post.id);
              return (
                <tr
                  key={post.id ?? idx}
                  data-ig-content-row
                  data-ig-content-open={isOpen ? '' : undefined}
                  data-ig-content-selected={isSelected ? '' : undefined}
                  onClick={clickable ? () => setOpenId(post.id!) : undefined}
                  className={cn(
                    'group transition-colors',
                    clickable && 'cursor-pointer',
                    isOpen
                      ? 'bg-primary/10'
                      : isSelected
                        ? 'bg-primary/5 hover:bg-primary/8'
                        : 'hover:bg-muted/40',
                  )}
                >
                  <td className={cn('pl-4 pr-2 sm:pl-5', cellY)} onClick={(e) => e.stopPropagation()}>
                    {post.id != null && (
                      <Checkbox
                        aria-label="Выбрать публикацию"
                        checked={selected.has(post.id)}
                        onCheckedChange={() => toggleSelect(post.id!)}
                        data-testid="ig-post-select"
                      />
                    )}
                  </td>
                  <td className={cn('pl-0 pr-3 text-center', cellY)}>
                    <IgPostThumb post={post} />
                  </td>
                  <td className={cn('px-3', cellY)}>
                    {clickable ? (
                      <button
                        type="button"
                        onClick={() => setOpenId(post.id!)}
                        data-ig-content-open-trigger
                        className="block w-full max-w-sm space-y-1 rounded text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/45 md:max-w-md lg:max-w-lg"
                      >
                        <span className={cn('line-clamp-1 font-medium', post.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                          {post.caption || 'Без подписи'}
                        </span>
                        <span className="mt-1 flex items-center gap-2">
                          <IgFormatTag post={post} />
                        </span>
                      </button>
                    ) : (
                      <div className="max-w-sm space-y-1 md:max-w-md lg:max-w-lg">
                        <div className={cn('line-clamp-1 font-medium', post.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                          {post.caption ? <RichText text={post.caption} /> : 'Без подписи'}
                        </div>
                        <div className="mt-1 flex items-center gap-2"><IgFormatTag post={post} /></div>
                      </div>
                    )}
                  </td>
                  {shownMetricCols.map((c) => {
                    return (
                      <td key={c.key} className={cn('px-3 text-right', cellY)}>
                        <MedianCell value={c.get(post)} median={medians[c.key]} tone={c.tone} format={c.format} />
                      </td>
                    );
                  })}
                  <td className={cn('px-3 pr-4 text-right text-xs tabular-nums text-muted-foreground sm:pr-5', cellY)}>
                    {post.timestamp ? fmt.date(post.timestamp) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <WorkspaceSurface>
        <div
          className={cn(
            'grid gap-6 lg:items-start',
            openPost && 'lg:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]',
          )}
        >
          <div className="min-w-0">{publicationsCard(cardBody)}</div>
          {openPost && (
            <IgPostInspector
              post={openPost}
              reachMedian={reachMedian}
              campaignScoped={campaignId != null}
              canCampaign={channelId != null}
              onClose={() => setOpenId(null)}
              onOpenFull={openFullDetail}
              onAddToCampaign={inspectorAddToCampaign}
            />
          )}
        </div>
      </WorkspaceSurface>

      {!campaignDataBlocked && secondaryBlock}
      {detail}
      {dialog}
    </div>
  );
}

/**
 * The adjacent desktop inspector — a focused, read-first summary of the row selected in the table,
 * built from Astryx LayoutPanel + MetadataList + Text + Token + Button. It never re-fetches or
 * duplicates business logic: it reads the already-loaded post and the period reach-median, and the
 * full IgPostDetailModal stays one explicit «Открыть подробнее» click away.
 */
function IgPostInspector({
  post,
  reachMedian,
  campaignScoped,
  canCampaign,
  onClose,
  onOpenFull,
  onAddToCampaign,
}: {
  post: IgPost;
  reachMedian: number | null;
  campaignScoped: boolean;
  canCampaign: boolean;
  onClose: () => void;
  onOpenFull: (id: string) => void;
  onAddToCampaign: (post: IgPost) => void;
}) {
  return (
    <WorkspaceInspector
      label="Детали выбранной публикации"
      title="Детали публикации"
      onClose={onClose}
      bodyProps={{ 'data-ig-content-inspector': '', 'data-ig-content-inspector-open': '' }}
      footer={
        <>
          {post.id != null && (
            <AxButton
              label="Открыть подробнее"
              variant="primary"
              size="sm"
              onClick={() => onOpenFull(post.id!)}
            />
          )}
          {!campaignScoped && canCampaign && post.id != null && (
            <AxButton
              label="Добавить в кампанию"
              variant="secondary"
              size="sm"
              onClick={() => onAddToCampaign(post)}
            />
          )}
        </>
      }
    >
      <div className="flex items-start gap-3">
        <IgPostThumb post={post} />
        <div className="min-w-0 flex-1 space-y-1">
          <AxText type="label" maxLines={2}>
            {post.caption || 'Без подписи'}
          </AxText>
          <div className="flex flex-wrap items-center gap-1.5">
            <Token label={igFormatLabel(post)} size="sm" color="gray" />
            {post.timestamp && <AxText type="supporting" size="2xs">{fmt.date(post.timestamp)}</AxText>}
          </div>
        </div>
      </div>

      <InspectorBenchmark post={post} reachMedian={reachMedian} />

      <MetadataList title="Показатели" columns="single" label={{ position: 'start' }}>
        <MetadataListItem label="Охват">{fmt.num(post.reach)}</MetadataListItem>
        <MetadataListItem label="Просмотры">{fmt.num(post.views)}</MetadataListItem>
        <MetadataListItem label="Взаимодействия">{fmt.num(igInteractions(post))}</MetadataListItem>
        <MetadataListItem label="ER">{igEr(post) != null ? `${igEr(post)!.toFixed(2)}%` : '—'}</MetadataListItem>
        <MetadataListItem label="Сохранения">{fmt.num(post.saved)}</MetadataListItem>
        <MetadataListItem label="Репосты">{fmt.num(post.shares)}</MetadataListItem>
      </MetadataList>
    </WorkspaceInspector>
  );
}

/** Honest reach-vs-median line for the inspector — same semantics as the table cell and the modal. */
function InspectorBenchmark({ post, reachMedian }: { post: IgPost; reachMedian: number | null }) {
  const cmp = compareToMedian(post.reach == null ? null : Number(post.reach), reachMedian);
  if (!cmp) {
    if (reachMedian == null) {
      return <AxText type="supporting" size="2xs">Недостаточно публикаций для сравнения с медианой периода</AxText>;
    }
    return null;
  }
  const color = cmp.dir === 'above' ? 'green' : cmp.dir === 'below' ? 'red' : 'gray';
  return <Token label={`Охват ${medianDeltaLabel(cmp)}`} size="sm" color={color} />;
}

/** The selected secondary analysis — one block at a time (the desktop table is the hero). */
function IgSecondaryBody({
  view,
  ig,
  posts,
  formatItems,
}: {
  view: IgSecondaryView;
  ig: IgData;
  posts: IgPost[];
  formatItems: { label: string; value: number }[];
}) {
  switch (view) {
    case 'formats':
      return <FormatsBlock items={formatItems} />;
    case 'reels':
      return (
        <Section title="Reels: удержание и просмотры">
          <ReelsBlock posts={posts} />
        </Section>
      );
    case 'hashtags':
      return (
        <WidgetGroup id="ig-hashtags-sec" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
          <ChartSection id="ig-hashtags" title="Эффективность хэштегов" defaultSize="full" noExpand>
            <HashtagsBlock posts={posts} />
          </ChartSection>
        </WidgetGroup>
      );
    case 'stories':
      return (
        <Section title="Stories за 24 часа">
          <StoriesBlock stories={ig.stories} />
        </Section>
      );
    case 'tags':
      return <IgTagsSecondary />;
    default:
      return null;
  }
}

/** Photo tags are the only secondary view that needs this request; keep it off the default path. */
function IgTagsSecondary() {
  const tags = useIgTags();
  return (
    <WidgetGroup id="ig-tags-sec" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartSection id="ig-tags" title="Отметки на фото" defaultSize="full" noExpand>
        <TagsBlock tags={tags.data?.data ?? []} mock={tags.data?.mock} />
      </ChartSection>
    </WidgetGroup>
  );
}

/** Sortable column header button (aria-sort lives on the <th>). Mirrors Posts.tsx. */
function SortButton({ label, active, order, onClick }: { label: string; active: boolean; order: 'asc' | 'desc'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('ml-auto inline-flex items-center gap-1 tabular-nums transition-colors', active ? 'text-primary' : 'hover:text-foreground')}
    >
      {label}
      <span aria-hidden="true" className={cn('text-2xs', !active && 'text-ink3/60')}>
        {active ? (order === 'desc' ? '↓' : '↑') : '↕'}
      </span>
    </button>
  );
}

/** Format word for the caption subline — the honest bucket the search/filter uses, made legible. */
function IgFormatTag({ post }: { post: IgPost }) {
  return (
    <span
      data-ig-content-format
      className="inline-flex rounded-full border border-border bg-background px-1.5 py-0.5 text-2xs leading-none text-muted-foreground"
    >
      {igFormatLabel(post)}
    </span>
  );
}

/**
 * A metric cell with explicit comparable-period median context. Value is always shown; the «±N% к
 * медиане» delta appears only when periodMedian cleared the min-sample gate (never a faked
 * benchmark). Missing value → «—». Colour is reserved for the signal column (reach).
 */
function MedianCell({
  value,
  median,
  tone,
  format,
}: {
  value: number | null;
  median: number | null;
  tone: 'signal' | 'muted';
  format: (v: number) => string;
}) {
  if (value == null) return <span className="text-muted-foreground/40">—</span>;
  const cmp = compareToMedian(value, median);
  const deltaColor =
    tone === 'signal' && cmp
      ? cmp.dir === 'above'
        ? 'text-verdant'
        : cmp.dir === 'below'
          ? 'text-ember'
          : 'text-muted-foreground'
      : 'text-muted-foreground';
  return (
    <>
      <span className={cn('block font-medium tabular-nums', tone === 'signal' ? 'text-foreground' : 'text-muted-foreground')}>{format(value)}</span>
      {cmp && <span className={cn('block text-2xs', deltaColor)}>{medianDeltaLabel(cmp)}</span>}
    </>
  );
}

/** Small square preview for a table row; neutral word-fallback on missing/broken cover. */
function IgPostThumb({ post }: { post: IgPost }) {
  const [broken, setBroken] = useState(false);
  const isVideo = post.media_type === 'VIDEO' || post.media_product_type === 'REELS';
  const cover = post.thumbnail_url || (!isVideo ? post.media_url : null) || null;
  const label = classifyIgFormat(post) === 'reels' ? 'Reels' : classifyIgFormat(post) === 'video' ? 'Видео' : classifyIgFormat(post) === 'carousel' ? 'Альбом' : 'Фото';
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-muted">
      {cover && !broken ? (
        <img loading="lazy" src={cover} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <span className="px-0.5 text-center text-2xs font-medium leading-tight text-muted-foreground">{label}</span>
      )}
    </div>
  );
}
