import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import type { IgPost, CampaignPostInput } from '@/api/schemas';
import { useIgTags, useRemoveCampaignPosts } from '@/api/queries';
import { ChartSection } from '@/components/ChartWidget';
import { PillSelect } from '@/components/PillSelect';
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
  IG_CONTENT_SORT_COLUMNS,
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
  type IgSecondaryView,
} from '@/lib/igContentFilters';
import { cn } from '@/lib/utils';
import { useIgScopedPosts, toCampaignItems } from '@/panels/instagram/igContentScope';

// ─────────────────────────────────────────────────────────────────────────────
// Desktop — dense Publications table + secondary analyses behind a compact tab
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

export function IgContentDesktop({ ig, tabs }: { ig: IgData; tabs: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const { channelId, campaignId, campaignPostsQ, posts, formatItems } = useIgScopedPosts(ig);

  const filters = useMemo(() => parseIgContentFilters(params), [params]);
  const secondary = parseIgSecondaryView(params.get('more'));
  const removeMut = useRemoveCampaignPosts();

  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Снимок выбора при открытии диалога (onDone чистит selection; диалог живёт до экрана результата).
  const [addItems, setAddItems] = useState<CampaignPostInput[] | null>(null);

  // Сброс выбора при смене источника/кампании/окна/фильтров (примитивные deps — window.* стабильны).
  useEffect(() => {
    setSelected(new Set());
    setAddItems(null);
  }, [channelId, campaignId, ig.window.since, ig.window.until, filters.q, filters.format]);

  const update = (patch: Partial<IgContentFilters>) =>
    setParams(applyIgContentFilters(params, { ...filters, ...patch }), { replace: true });
  const toggleSort = (key: IgContentFilters['sort']) =>
    update(key === filters.sort ? { order: filters.order === 'desc' ? 'asc' : 'desc' } : { sort: key, order: 'desc' });
  const setSecondary = (next: IgSecondaryView) =>
    setParams(applyIgSecondaryView(params, next), { replace: true });

  // Comparable-period scope = the windowed (campaign-scoped) set; medians measured over THIS set,
  // not the search subset, so a search never shifts the benchmark.
  const scope = posts;
  const visible = filterIgPosts(scope, { q: filters.q, format: filters.format });
  const rows = sortIgPosts(visible, filters.sort, filters.order);

  const medianOf = (get: (p: IgPost) => number | null) =>
    periodMedian(scope.map(get).filter((v): v is number => v != null));
  const reachMedian = medianOf((p) => (p.reach == null ? null : Number(p.reach)));
  const viewsMedian = medianOf((p) => (p.views == null ? null : Number(p.views)));
  const interactionsMedian = medianOf(igInteractions);
  const savedMedian = medianOf((p) => (p.saved == null ? null : Number(p.saved)));
  const sharesMedian = medianOf((p) => (p.shares == null ? null : Number(p.shares)));
  const erMedian = medianOf(igEr);

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
  const hasContentFilters = filters.q.trim() !== '' || filters.format !== 'all';

  const toolbar = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {tabs}
        <button
          type="button"
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
          className="btn-pill inline-flex h-8 items-center border border-border bg-background px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          Экспорт таблицы
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <CampaignFilterControl />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="sr-only">Поиск по публикациям</span>
            <input
              type="search"
              value={filters.q}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="Поиск по тексту и хэштегам"
              aria-label="Поиск по публикациям"
              className="h-8 w-56 rounded-full border border-border bg-background px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
            />
          </label>
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
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        {selectedItems.length > 0 ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">Выбрано: {fmt.num(selectedItems.length)}</span>
            <button
              type="button"
              onClick={() => setAddItems(selectedItems)}
              className="btn-pill inline-flex h-8 items-center bg-primary px-3.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="add-to-campaign"
            >
              Добавить в кампанию
            </button>
            {campaignId != null && (
              <button
                type="button"
                onClick={onRemoveFromCampaign}
                disabled={removeMut.isPending}
                className="btn-pill inline-flex h-8 items-center border border-border px-3.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                data-testid="remove-from-campaign"
              >
                {removeMut.isPending ? 'Убираю…' : 'Убрать из кампании'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="btn-pill inline-flex h-8 items-center px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Снять выбор
            </button>
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
  const detail = openPost && (
    <IgPostDetailModal
      post={openPost}
      reachComparison={compareToMedian(openPost.reach == null ? null : Number(openPost.reach), reachMedian)}
      benchmarkUnavailable={reachMedian == null}
      onAddToCampaign={
        openPost.id != null && channelId != null
          ? () => {
              const items = toCampaignItems([openPost], channelId, new Set([openPost.id!]));
              setOpenId(null);
              setAddItems(items);
            }
          : undefined
      }
      onClose={() => setOpenId(null)}
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

  // Self-contained shadcn card shell — the header (tabs/export + filters/actions) sits on a tinted
  // rule above whatever body the current state renders (skeleton / error / empty / table).
  const publicationsCard = (body: ReactNode) => (
    <section
      data-ig-content-publications
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm dark:border-white/[0.06]"
    >
      <div className="space-y-3 border-b border-border px-4 py-4 sm:px-5">{toolbar}</div>
      {body}
    </section>
  );

  // Loading / error gates for the campaign-scoped fetch (matches Posts.tsx).
  if (campaignId != null && campaignPostsQ.isPending) {
    return (
      <div className="space-y-8">
        {publicationsCard(
          <TableSkeleton rows={3} columns={5} className="px-4 py-4 sm:px-5" />,
        )}
      </div>
    );
  }
  if (campaignId != null && campaignPostsQ.isError) {
    return (
      <div className="space-y-8">
        {publicationsCard(
          <ErrorState
            compact
            size="table"
            title="Не удалось загрузить публикации кампании"
            onRetry={() => campaignPostsQ.refetch()}
            retrying={campaignPostsQ.isRefetching}
          />,
        )}
      </div>
    );
  }

  const emptyMessage =
    campaignId != null && scope.length === 0
      ? 'В этой кампании нет публикаций из текущего источника за выбранный период.'
      : scope.length === 0
        ? 'За выбранный период публикаций нет.'
        : 'Ничего не найдено по выбранным фильтрам.';

  return (
    <div className="space-y-8">
      {publicationsCard(
        rows.length === 0 ? (
          <div data-testid="ig-content-empty">
            <EmptyState compact size="table" title={emptyMessage} />
          </div>
        ) : (
          <div className="overflow-x-auto" data-ig-content-table>
            <table className="data-table data-table--compact text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/25 text-2xs font-medium tracking-wide text-muted-foreground">
                  <th className="w-10 py-2.5 pl-4 pr-2 sm:pl-5">
                    <Checkbox
                      aria-label="Выбрать все видимые публикации"
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                    />
                  </th>
                  <th className="w-12 py-2.5 pl-0 pr-3 text-center"></th>
                  <th className="min-w-[240px] px-3 py-2.5">Публикация</th>
                  {IG_CONTENT_SORT_COLUMNS.filter((c) => c.key !== 'date').map((c) => {
                    const active = c.key === filters.sort;
                    return (
                      <th
                        key={c.key}
                        aria-sort={active ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
                        className="w-[104px] px-3 py-2.5 text-right"
                      >
                        <SortButton label={c.label} active={active} order={filters.order} onClick={() => toggleSort(c.key)} />
                      </th>
                    );
                  })}
                  <th
                    aria-sort={filters.sort === 'date' ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
                    className="w-[96px] px-3 py-2.5 pr-4 text-right sm:pr-5"
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
                          ? 'bg-primary/[0.10]'
                          : isSelected
                            ? 'bg-primary/[0.05] hover:bg-primary/[0.08]'
                            : 'hover:bg-muted/40',
                      )}
                    >
                      <td className="py-3 pl-4 pr-2 sm:pl-5" onClick={(e) => e.stopPropagation()}>
                        {post.id != null && (
                          <Checkbox
                            aria-label="Выбрать публикацию"
                            checked={selected.has(post.id)}
                            onCheckedChange={() => toggleSelect(post.id!)}
                            data-testid="ig-post-select"
                          />
                        )}
                      </td>
                      <td className="py-3 pl-0 pr-3 text-center">
                        <IgPostThumb post={post} />
                      </td>
                      <td className="px-3 py-3">
                        {clickable ? (
                          <button
                            type="button"
                            onClick={() => setOpenId(post.id!)}
                            data-ig-content-open-trigger
                            className="block w-full max-w-sm space-y-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/45 md:max-w-md lg:max-w-lg"
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
                      <td className="px-3 py-3 text-right">
                        <MedianCell value={post.reach == null ? null : Number(post.reach)} median={reachMedian} tone="signal" format={fmt.num} />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <MedianCell value={post.views == null ? null : Number(post.views)} median={viewsMedian} tone="muted" format={fmt.num} />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <MedianCell value={igInteractions(post)} median={interactionsMedian} tone="muted" format={fmt.num} />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <MedianCell value={post.saved == null ? null : Number(post.saved)} median={savedMedian} tone="muted" format={fmt.num} />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <MedianCell value={post.shares == null ? null : Number(post.shares)} median={sharesMedian} tone="muted" format={fmt.num} />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <MedianCell value={igEr(post)} median={erMedian} tone="muted" format={(v) => `${v.toFixed(2)}%`} />
                      </td>
                      <td className="px-3 py-3 pr-4 text-right text-xs tabular-nums text-muted-foreground sm:pr-5">
                        {post.timestamp ? fmt.date(post.timestamp) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ),
      )}

      {secondaryBlock}
      {detail}
      {dialog}
    </div>
  );
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
  const label =
    classifyIgFormat(post) === 'reels'
      ? 'Reels'
      : classifyIgFormat(post) === 'carousel'
        ? 'Карусель'
        : classifyIgFormat(post) === 'video'
          ? 'Видео'
          : MEDIA_TYPE_LABEL[post.media_type ?? ''] ?? 'Фото';
  return (
    <span
      data-ig-content-format
      className="inline-flex rounded-full border border-border bg-background px-1.5 py-0.5 text-2xs leading-none text-muted-foreground"
    >
      {label}
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
