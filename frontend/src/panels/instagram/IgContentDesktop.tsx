import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
// Astryx runtime primitives (scoped design-system rollout) — subpath imports for tree-shaking.
import { Token } from '@astryxdesign/core/Token';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text as AxText } from '@astryxdesign/core/Text';
import { Button as AxButton } from '@astryxdesign/core/Button';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { WorkspaceInspector, WorkspaceSurface } from '@/components/data-workspace';
import type { IgData } from '@/lib/useIgData';
import type { IgPost, CampaignPostInput } from '@/api/schemas';
import { useIgTags, useRemoveCampaignPosts } from '@/api/queries';
import { ChartSection } from '@/components/ChartWidget';
import { PillSelect } from '@/components/PillSelect';
import { SearchField } from '@/components/SearchField';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
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
  IG_CONTENT_SORT_NONE,
  type IgContentFilters,
  type IgContentFormat,
  type IgContentSort,
  type IgSecondaryView,
} from '@/lib/igContentFilters';
import { cn } from '@/lib/utils';
import { useIgScopedPosts, toCampaignItems } from '@/panels/instagram/igContentScope';

// ─────────────────────────────────────────────────────────────────────────────
// Desktop — shadcn-style Publications table with a scoped Astryx inspector and active-filter
// tokens. Column visibility stays local to the table; row density is intentionally fixed.
// The surface remains wrapped in a scoped <Theme> for the Astryx primitives only;
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
const COLUMN_VISIBILITY_KEY = 'pulse_ig_content_columns';

/** One page of the publications table; a footer appears only past this (task: pagination for large sets). */
const PAGE_SIZE = 25;

/**
 * Monochrome selection: the checked box is a white/foreground chip with a black/background tick —
 * never the primary-blue fill from the shared Checkbox primitive. Unchecked stays the quiet
 * translucent field the sticky-header/e2e geometry expects.
 */
const IG_SELECT_CHECKBOX_CLASS =
  'border-muted-foreground/35 bg-muted/20 shadow-none focus-visible:ring-foreground/40 ' +
  'data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background';

function readVisibleColumns(): string[] {
  if (typeof window === 'undefined') return ALL_COLUMN_KEYS;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? 'null');
    if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== 'string')) return ALL_COLUMN_KEYS;
    const saved = new Set(parsed);
    return ALL_COLUMN_KEYS.filter((key) => saved.has(key));
  } catch {
    return ALL_COLUMN_KEYS;
  }
}

function persistVisibleColumns(columns: string[]): void {
  try {
    window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(columns));
  } catch {
    // Storage may be unavailable; the table still works with this session's in-memory state.
  }
}

interface StickyHeaderGeometry {
  top: number;
  left: number;
  width: number;
  tableWidth: number;
  scrollLeft: number;
}

interface TableViewportGeometry {
  centerX: number;
  maxWidth: number;
}

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
  // Table view state is intentionally not URL-backed, but survives a reload on this browser.
  const [visibleCols, setVisibleCols] = useState<string[]>(readVisibleColumns);
  // Current 1-based page — only material once the result set exceeds one page (see PAGE_SIZE).
  const [page, setPage] = useState(1);
  const tableShellRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const tableHeaderRef = useRef<HTMLTableSectionElement>(null);
  const [stickyHeader, setStickyHeader] = useState<StickyHeaderGeometry | null>(null);
  const [tableViewport, setTableViewport] = useState<TableViewportGeometry | null>(null);

  // Сброс выбора/инспектора при смене источника/кампании/окна/фильтров (примитивные deps — window.* стабильны).
  useEffect(() => {
    setSelected(new Set());
    setAddItems(null);
    setOpenId(null);
    setDetailId(null);
  }, [channelId, campaignId, ig.window.since, ig.window.until, filters.q, filters.format]);

  // Filtering / sorting / scope / period changes send the reader back to the first page (selection
  // deliberately survives — it is kept separate from the reset above). Over-scroll past the last page
  // is clamped below, so a shrinking result set can never strand the reader on an empty page.
  useEffect(() => {
    setPage(1);
  }, [channelId, campaignId, ig.window.since, ig.window.until, filters.q, filters.format, filters.sort, filters.order]);

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
  // Three-state cycle for a column: inactive → desc → asc → no sort. Clicking a different (inactive)
  // column always restarts at desc. The no-sort third state resets order to the default so the URL
  // never carries a meaningless `order`, and it preserves the filtered input order (see sortIgPosts).
  const toggleSort = (key: IgContentSort) => {
    const current = parseIgContentFilters(paramsRef.current);
    if (current.sort !== key) update({ sort: key, order: 'desc' });
    else if (current.order === 'desc') update({ order: 'asc' });
    else update({ sort: IG_CONTENT_SORT_NONE, order: 'desc' });
  };
  const setSecondary = (next: IgSecondaryView) =>
    commitParams(applyIgSecondaryView(paramsRef.current, next));

  // Comparable-period scope = the windowed (campaign-scoped) set; medians measured over THIS set,
  // not the search subset, so a search never shifts the benchmark.
  const scope = posts;
  const visible = filterIgPosts(scope, { q: filters.q, format: filters.format });
  const rows = sortIgPosts(visible, filters.sort, filters.order);

  // Pagination is conditional: ≤ PAGE_SIZE rows render whole with no footer. Past that, slice a page
  // and clamp the current page so filter/scope changes that shrink the set never leave an empty view.
  // CSV export, the result count and the total selection all keep working off the FULL `rows` set.
  const totalRows = rows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const paginated = totalRows > PAGE_SIZE;
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pagedRows = paginated ? rows.slice(pageStart, pageStart + PAGE_SIZE) : rows;

  // A background refetch can shrink the result set without changing any URL/scope dependency from
  // the reset effect above. Persist the derived clamp back into state so the navigation callbacks
  // never need several clicks to recover from a now-nonexistent page.
  useEffect(() => {
    setPage((previous) => Math.min(Math.max(1, previous), pageCount));
  }, [pageCount]);

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

  // The table needs horizontal overflow, which makes native CSS sticky bind to that shell instead
  // of the dashboard's vertical scroller. Mirror only the header into a fixed portal while the
  // original header is above the sticky page title; horizontal scroll and column widths stay tied
  // to the real table, and the dashboard remains the sole vertical scroller.
  useLayoutEffect(() => {
    const shell = tableShellRef.current;
    const table = tableRef.current;
    const header = tableHeaderRef.current;
    if (!shell || !table || !header) {
      setStickyHeader(null);
      setTableViewport(null);
      return;
    }

    const dashboardScroller = shell.closest('main')?.parentElement;
    const feedHeader = shell.closest('[data-feed-block]')?.querySelector<HTMLElement>('[data-feed-page-header]');
    if (!dashboardScroller || !feedHeader) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const shellRect = shell.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const stickyTop = feedHeader.getBoundingClientRect().bottom;
      const shouldStick = headerRect.top < stickyTop && tableRect.bottom > stickyTop + headerRect.height;
      const nextViewport = {
        centerX: Math.round(shellRect.left + shellRect.width / 2),
        maxWidth: Math.max(0, Math.round(shellRect.width - 32)),
      };
      setTableViewport((current) =>
        current?.centerX === nextViewport.centerX && current.maxWidth === nextViewport.maxWidth
          ? current
          : nextViewport,
      );

      if (!shouldStick) {
        setStickyHeader((current) => (current == null ? current : null));
        return;
      }

      const next: StickyHeaderGeometry = {
        // Floor instead of round: a fractional page-header bottom (common at browser zoom / DPR)
        // must never leave a sub-pixel slit where the scrolling thumbnails can flash through.
        top: Math.floor(stickyTop),
        left: Math.round(shellRect.left + shell.clientLeft),
        width: Math.round(shell.clientWidth),
        tableWidth: Math.round(tableRect.width),
        scrollLeft: Math.round(shell.scrollLeft),
      };
      setStickyHeader((current) =>
        current != null &&
        current.top === next.top &&
        current.left === next.left &&
        current.width === next.width &&
        current.tableWidth === next.tableWidth &&
        current.scrollLeft === next.scrollLeft
          ? current
          : next,
      );
    };
    const scheduleMeasure = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    dashboardScroller.addEventListener('scroll', scheduleMeasure, { passive: true });
    shell.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(shell);
    resizeObserver.observe(table);
    resizeObserver.observe(feedHeader);

    return () => {
      dashboardScroller.removeEventListener('scroll', scheduleMeasure);
      shell.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      resizeObserver.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [rows.length, currentPage, visibleCols]);

  const updateVisibleColumns = (next: string[]) => {
    setVisibleCols(next);
    persistVisibleColumns(next);
    // Hiding the actively-sorted metric column must leave a valid state → fall back to the
    // always-present date column. The no-sort state and the date column are already valid.
    if (filters.sort !== 'date' && filters.sort !== IG_CONTENT_SORT_NONE && !next.includes(filters.sort)) {
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
  // «Select all visible» = the rows actually on screen: the current page once pagination exists,
  // otherwise the whole set (pagedRows === rows when unpaginated). Selection still spans pages.
  const visibleIds = pagedRows.map((p) => p.id).filter((id): id is string => !!id);
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
            className="w-64 [&_input]:h-8 [&_input]:rounded-[10px]"
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
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-2xs text-muted-foreground">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Колонки"
                className="h-9 gap-2 bg-background/70"
              >
                Колонки
                <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {COLUMN_OPTIONS.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={visibleCols.includes(option.value)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? ALL_COLUMN_KEYS.filter(
                          (key) => key === option.value || visibleCols.includes(key),
                        )
                      : visibleCols.filter((key) => key !== option.value);
                    updateVisibleColumns(next);
                  }}
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
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

  const renderTableHeader = (floating = false) => (
    <thead
      ref={floating ? undefined : tableHeaderRef}
      aria-hidden={!floating && stickyHeader != null ? true : undefined}
    >
      <tr className="text-2xs font-semibold tracking-wide text-foreground">
        <th className="w-10 pl-4 pr-2 sm:pl-5">
          <Checkbox
            aria-label="Выбрать все видимые публикации"
            checked={allVisibleSelected}
            onCheckedChange={toggleAllVisible}
            className={IG_SELECT_CHECKBOX_CLASS}
          />
        </th>
        <th className="w-12 pl-0 pr-3 text-center"></th>
        <th className="min-w-[240px] px-3">Публикация</th>
        {shownMetricCols.map((c) => {
          const active = c.key === filters.sort;
          return (
            <th
              key={c.key}
              aria-sort={active ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
              className="w-[104px] px-3 text-right"
            >
              <SortButton label={c.label} active={active} order={filters.order} onClick={() => toggleSort(c.key)} />
            </th>
          );
        })}
        <th
          aria-sort={filters.sort === 'date' ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
          className="w-[96px] px-3 pr-4 text-right sm:pr-5"
        >
          <SortButton label="Дата" active={filters.sort === 'date'} order={filters.order} onClick={() => toggleSort('date')} />
        </th>
        <th aria-hidden="true" className="sticky right-0 z-[2] w-10 bg-background px-2"></th>
      </tr>
    </thead>
  );

  const floatingTableHeader = stickyHeader != null && typeof document !== 'undefined'
    ? createPortal(
        <div
          data-ig-content-sticky-header
          className="fixed z-sticky overflow-hidden border-b border-border/75 bg-background shadow-sm"
          style={{ top: stickyHeader.top, left: stickyHeader.left, width: stickyHeader.width }}
        >
          <table
            aria-label="Закреплённые заголовки таблицы публикаций"
            className="data-table ig-content-table text-left text-sm"
            style={{
              width: stickyHeader.tableWidth,
              transform: `translateX(-${stickyHeader.scrollLeft}px)`,
            }}
          >
            {renderTableHeader(true)}
          </table>
        </div>,
        document.body,
      )
    : null;

  const floatingBulkActions = selectedItems.length > 0 && tableViewport != null && typeof document !== 'undefined'
    ? createPortal(
        <div
          role="toolbar"
          aria-label="Действия с выбранными публикациями"
          data-testid="ig-content-bulk-bar"
          className="fixed bottom-6 z-popover flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-white/20 bg-background p-2 pl-3 text-foreground shadow-[0_-1px_0_rgba(255,255,255,0.07),0_14px_36px_rgba(0,0,0,0.72)] motion-safe:animate-in motion-safe:fade-in-0"
          style={{ left: tableViewport.centerX, maxWidth: tableViewport.maxWidth }}
        >
          <span className="shrink-0 pr-1 text-xs tabular-nums text-muted-foreground" aria-live="polite">
            Выбрано: {fmt.num(selectedItems.length)}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => setAddItems(selectedItems)}
            data-testid="add-to-campaign"
            className="bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-foreground/35"
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
          {removeMut.isError && <span role="alert" className="text-2xs text-destructive">Не удалось убрать из кампании.</span>}
        </div>,
        document.body,
      )
    : null;

  // Self-contained shadcn card shell: a quiet background and a separately bordered table keep the
  // controls and rows visually distinct without introducing a large grey workspace surface.
  const publicationsCard = (body: ReactNode) => (
    <section
      data-ig-content-publications
      className="overflow-hidden rounded-2xl border border-border/75 bg-background shadow-xs"
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">{toolbar}</div>
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
    cardBody = <IgContentTableSkeleton metricCount={shownMetricCols.length} />;
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
      <>
      <div
        ref={tableShellRef}
        className={cn(
          'mx-4 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-xl border border-border/75 bg-background [contain:paint] sm:mx-5',
          paginated ? 'mb-3 sm:mb-3.5' : 'mb-4 sm:mb-5',
        )}
        data-ig-content-table
      >
        <table ref={tableRef} className="data-table ig-content-table text-left text-sm">
          {renderTableHeader()}
          <tbody>
            {pagedRows.map((post, idx) => {
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
                    'group',
                    clickable && 'cursor-pointer',
                    isOpen
                      ? 'bg-primary/10'
                      : isSelected
                        ? 'bg-foreground/[0.04] hover:bg-foreground/[0.07]'
                        : 'hover:bg-muted/40',
                  )}
                >
                  <td className="pl-4 pr-2 sm:pl-5" onClick={(e) => e.stopPropagation()}>
                    {post.id != null && (
                      <Checkbox
                        aria-label="Выбрать публикацию"
                        checked={selected.has(post.id)}
                        onCheckedChange={() => toggleSelect(post.id!)}
                        data-testid="ig-post-select"
                        className={IG_SELECT_CHECKBOX_CLASS}
                      />
                    )}
                  </td>
                  <td className="pl-0 pr-3 text-center">
                    <IgPostThumb post={post} />
                  </td>
                  <td className="px-3">
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
                      <td key={c.key} className="px-3 text-right">
                        <MedianCell value={c.get(post)} median={medians[c.key]} tone={c.tone} format={c.format} />
                      </td>
                    );
                  })}
                  <td className="px-3 pr-4 text-right text-xs tabular-nums text-muted-foreground sm:pr-5">
                    {post.timestamp ? fmt.date(post.timestamp) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="sticky right-0 z-[1] w-10 border-l border-border/0 bg-inherit px-2 text-center transition-colors group-hover:border-border/40">
                    {clickable && (
                      <ChevronRight
                        aria-hidden="true"
                        data-testid="ig-content-open-indicator"
                        className={cn(
                          'mx-auto size-4 transition-[opacity,transform,color] duration-200',
                          isOpen
                            ? 'text-primary opacity-100'
                            : 'translate-x-1 text-muted-foreground opacity-0 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100',
                        )}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {paginated && (
        <IgContentPaginationFooter
          page={currentPage}
          pageCount={pageCount}
          pageSize={PAGE_SIZE}
          total={totalRows}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(pageCount, p + 1))}
        />
      )}
      </>
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
      {floatingTableHeader}
      {floatingBulkActions}
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
      className="group ml-auto inline-flex items-center gap-1 font-semibold tabular-nums text-foreground transition-colors hover:text-foreground/80"
    >
      {label}
      <span
        aria-hidden="true"
        className={cn(
          'text-2xs transition-opacity',
          active
            ? 'text-foreground'
            : 'text-ink3/60 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      >
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
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const isVideo = post.media_type === 'VIDEO' || post.media_product_type === 'REELS';
  const originalCover = post.thumbnail_url || (!isVideo ? post.media_url : null) || null;
  const proxyFailed = post.table_thumbnail_url != null && brokenSrc === post.table_thumbnail_url;
  const cover = proxyFailed ? originalCover : post.table_thumbnail_url || originalCover;
  const broken = cover != null && brokenSrc === cover;
  const loaded = cover != null && loadedSrc === cover;
  const label = classifyIgFormat(post) === 'reels' ? 'Reels' : classifyIgFormat(post) === 'video' ? 'Видео' : classifyIgFormat(post) === 'carousel' ? 'Альбом' : 'Фото';

  return (
    <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-muted">
      {(!cover || broken || !loaded) && (
        <span className="px-0.5 text-center text-2xs font-medium leading-tight text-muted-foreground">{label}</span>
      )}
      {cover && !broken ? (
        <img
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          width={40}
          height={40}
          draggable={false}
          src={cover}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSrc(cover)}
          onError={() => setBrokenSrc(cover)}
          className={cn('absolute inset-0 h-full w-full object-cover', loaded ? 'opacity-100' : 'opacity-0')}
        />
      ) : null}
    </div>
  );
}

/**
 * Compact shadcn-style pagination footer — rendered only for result sets larger than one page. It
 * reports the on-screen window as «X–Y из N» and moves with outline Назад/Вперёд buttons that
 * disable at the boundaries. Lives inside the publications card, directly below the table.
 */
function IgContentPaginationFooter({
  page,
  pageCount,
  pageSize,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav
      aria-label="Постраничная навигация публикаций"
      data-testid="ig-content-pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3 sm:px-5"
    >
      <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="ig-content-pagination-range">
        {fmt.num(from)}–{fmt.num(to)} из {fmt.num(total)}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={page <= 1}
          aria-label="Предыдущая страница"
        >
          Назад
        </Button>
        <span className="px-1 text-xs tabular-nums text-muted-foreground">
          {fmt.num(page)} / {fmt.num(pageCount)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={page >= pageCount}
          aria-label="Следующая страница"
        >
          Вперёд
        </Button>
      </div>
    </nav>
  );
}

/**
 * Table-shaped loading for the publications table — the real card/table shell, header hairline and
 * column widths are preserved while ~6 non-interactive row skeletons stand in for the rows. Reused
 * by campaign-scoped pending loads (inside the card) and by the initial-load page skeleton.
 * Accessible: one busy status region; the mirrored table is aria-hidden and never focusable.
 */
export function IgContentTableSkeleton({ metricCount = METRIC_COLS.length }: { metricCount?: number }) {
  const metrics = Array.from({ length: Math.max(0, metricCount) });
  const skeletonRows = Array.from({ length: 6 });
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Загрузка публикаций"
      data-testid="ig-content-table-skeleton"
      className="mx-4 mb-4 overflow-hidden rounded-xl border border-border/75 bg-background sm:mx-5 sm:mb-5"
    >
      <table aria-hidden="true" className="data-table ig-content-table text-left text-sm">
        <thead>
          <tr className="text-2xs font-semibold tracking-wide text-foreground">
            <th className="w-10 pl-4 pr-2 sm:pl-5"><Skeleton className="h-4 w-4 rounded" /></th>
            <th className="w-12 pl-0 pr-3" />
            <th className="min-w-[240px] px-3"><Skeleton className="h-3 w-24" /></th>
            {metrics.map((_, i) => (
              <th key={i} className="w-[104px] px-3"><Skeleton className="ml-auto h-3 w-12" /></th>
            ))}
            <th className="w-[96px] px-3 pr-4 sm:pr-5"><Skeleton className="ml-auto h-3 w-10" /></th>
            <th className="w-10 px-2" />
          </tr>
        </thead>
        <tbody>
          {skeletonRows.map((_, r) => (
            <tr key={r}>
              <td className="pl-4 pr-2 sm:pl-5"><Skeleton className="h-4 w-4 rounded" /></td>
              <td className="pl-0 pr-3"><Skeleton className="h-10 w-10 rounded-lg" /></td>
              <td className="px-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-40 max-w-full" />
                  <Skeleton className="h-3 w-16 rounded-full" />
                </div>
              </td>
              {metrics.map((_, i) => (
                <td key={i} className="px-3"><Skeleton className="ml-auto h-3.5 w-12" /></td>
              ))}
              <td className="px-3 pr-4 sm:pr-5"><Skeleton className="ml-auto h-3 w-10" /></td>
              <td className="w-10 px-2" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Initial-load skeleton for /instagram/content — the publications card shell (a toolbar band over
 * the table-shaped skeleton) so a cold load reads as THIS page rather than the generic dashboard
 * card skeleton. The table skeleton owns the busy status; the toolbar band is decorative.
 */
export function IgContentPageSkeleton() {
  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-2xl border border-border/75 bg-background shadow-xs">
        <div className="space-y-3 px-4 py-4 sm:px-5" aria-hidden="true">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-7 w-40 rounded-full" />
            <Skeleton className="h-8 w-32 rounded-lg" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-8 w-28 rounded-lg" />
            <Skeleton className="h-8 w-64 rounded-lg" />
            <Skeleton className="h-8 w-40 rounded-lg" />
          </div>
        </div>
        <IgContentTableSkeleton />
      </section>
    </div>
  );
}
