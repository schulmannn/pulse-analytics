import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCampaignPosts, useChannels, useRemoveCampaignPosts, useTgFull } from '@/api/queries';
import type { CampaignPostInput } from '@/api/schemas';
import { normalizeTgPosts, type NormalizedPost } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { markdownToPlainText } from '@/lib/markdown';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/ErrorState';
import { Icon } from '@/components/nav-icons';
import { calendarWindowForPeriod, usePagePeriod, widgetPeriodValue } from '@/lib/period';
import { downloadCsv } from '@/lib/csv';
import { tgContentRows } from '@/lib/contentExport';
import { exportFilename } from '@/lib/analyticsExport';
import { Skeleton } from '@/components/ui/skeleton';
import { RichText } from '@/components/RichText';
import { PostDetailModal } from '@/components/PostDetailModal';
import { MEDIAN_MIN_SAMPLE, compareToMedian, medianDeltaLabel, periodMedian } from '@/lib/postMedian';
import { useSelectedChannel } from '@/lib/channel-context';
import { membershipKey, useCampaignFilter, useMembershipSet } from '@/lib/campaignFilter';
import { AddToCampaignDialog } from '@/components/campaigns/AddToCampaignDialog';
import { CampaignFilterControl } from '@/components/campaigns/CampaignFilterControl';
import { PillSelect } from '@/components/PillSelect';
import { lazyWithReload } from '@/lib/lazyWithReload';
import {
  CONTENT_SORT_COLUMNS,
  applyContentFilters,
  filterPosts,
  parseContentFilters,
  serializeContentPeriod,
  sortPosts,
  type ContentFilters,
  type ContentFormat,
} from '@/lib/contentFilters';

// Список кампаний (таблица + create-диалог) грузится лениво: вкладка «Кампании» — не первый
// экран «Контента», а entry-чанк упирается в bundle-size гейт.
const CampaignsView = lazy(
  lazyWithReload(() => import('@/components/campaigns/CampaignsView').then((m) => ({ default: m.CampaignsView }))),
);

const FORMAT_OPTIONS: { value: ContentFormat; label: string }[] = [
  { value: 'all', label: 'Все форматы' },
  { value: 'text', label: 'Текст' },
  { value: 'photo', label: 'Фото' },
  { value: 'video', label: 'Видео' },
  { value: 'album', label: 'Альбом' },
];

export function Posts() {
  // ?view=campaigns — вторая вкладка раздела «Контент» (идиома ?tab= из AnalyticsTabs:
  // дефолт держит URL чистым). Вкладки видны всегда, независимо от загрузки постов.
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'campaigns' ? 'campaigns' : 'posts';
  const setView = (next: 'posts' | 'campaigns') =>
    setParams(
      (prev) => {
        const merged = new URLSearchParams(prev);
        if (next === 'posts') merged.delete('view');
        else merged.set('view', next);
        return merged;
      },
      { replace: true },
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Раздел контента">
        {([['posts', 'Публикации'], ['campaigns', 'Кампании']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={cn(
              'btn-pill px-3 py-1 text-xs font-medium transition-colors',
              view === key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'campaigns' ? (
        <Suspense fallback={<div className="py-8"><Skeleton className="h-40 w-full" /></div>}>
          <CampaignsView />
        </Suspense>
      ) : (
        <PostsContent />
      )}
    </div>
  );
}

function PostsContent() {
  // ONE wide fetch (limit 0 = server cap 100); the table below windows/filters it. The
  // fetch/skeleton/error stay here; the filtered view is the child.
  const { data, isPending, isError, error } = useTgFull(0);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();

  if (isPending) return <PostsSkeletons />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить публикации" reason={error instanceof Error ? error.message : 'ошибка сервера'} />;
  }

  const proxyThumbs = channelsData?.channels.find((channel) => channel.id === channelId)?.source === 'central';
  const allPosts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}, { proxyThumbs });
  if (allPosts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Постов пока нет
        </CardContent>
      </Card>
    );
  }

  return <PostsTable allPosts={allPosts} loadedCount={data?.posts?.length ?? allPosts.length} />;
}

/**
 * The dense, reproducible Content work surface (Steep-flavoured): a compact toolbar + a full-width
 * table rendered directly on the section's FeedBlock — no nested decorative card. The window is the
 * authoritative page period (the header's TgPagePeriodControl), and text search / media format /
 * sort column+direction all live in the URL (lib/contentFilters), so the whole view is a shareable,
 * reload-stable link that composes with the pre-existing `?campaign=`/`?view=` params.
 */
function PostsTable({ allPosts, loadedCount }: { allPosts: NormalizedPost[]; loadedCount: number }) {
  const [params, setParams] = useSearchParams();
  const pp = usePagePeriod();
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();

  // The four non-period Content filters read straight from the URL (single source of truth); the
  // period is owned by the page-period context (header chips) and mirrored below.
  const filters = useMemo(() => parseContentFilters(params), [params]);
  const pageDays = pp?.days ?? filters.period;
  const pageRange = pp?.range ?? null;
  const period = useMemo(() => widgetPeriodValue(pageDays, pageRange), [pageDays, pageRange]);
  const rawUrlPeriod = params.get('period');
  const periodSyncReady = useRef(false);
  const lastUrlPeriod = useRef<string | null>(rawUrlPeriod);

  // Two-way period sync. An explicit URL value wins on mount/navigation; otherwise the page
  // provider wins so Обзор → Контент keeps the selected window. The raw-param ref distinguishes a
  // Back/Forward URL change from a header-chip change and prevents either side from overwriting it.
  useEffect(() => {
    const writePeriod = (days: ContentFilters['period']) => {
      const next = new URLSearchParams(params);
      const serialized = serializeContentPeriod(days);
      if (serialized == null) next.delete('period');
      else next.set('period', serialized);
      lastUrlPeriod.current = serialized;
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    };

    if (!periodSyncReady.current) {
      periodSyncReady.current = true;
      lastUrlPeriod.current = rawUrlPeriod;
      if (rawUrlPeriod != null) {
        if (pp && pp.days !== filters.period) pp.setDays(filters.period);
        if (rawUrlPeriod !== serializeContentPeriod(filters.period)) writePeriod(filters.period);
      } else if (pageDays !== filters.period) {
        writePeriod(pageDays);
      }
      return;
    }

    if (rawUrlPeriod !== lastUrlPeriod.current) {
      lastUrlPeriod.current = rawUrlPeriod;
      if (pp && pp.days !== filters.period) pp.setDays(filters.period);
      if (rawUrlPeriod !== serializeContentPeriod(filters.period)) writePeriod(filters.period);
      return;
    }

    if (pageDays !== filters.period) writePeriod(pageDays);
  }, [filters.period, pageDays, params, pp, rawUrlPeriod, setParams]);

  const update = (patch: Partial<ContentFilters>) =>
    setParams(applyContentFilters(params, { ...filters, period: pageDays, ...patch }), { replace: true });
  const toggleSort = (key: ContentFilters['sort']) =>
    update(
      key === filters.sort
        ? { order: filters.order === 'desc' ? 'asc' : 'desc' }
        : { sort: key, order: 'desc' },
    );

  const [openId, setOpenId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Снимок выбора на момент открытия диалога: onDone чистит selection, а диалог обязан дожить до
  // экрана результата (added/skipped) — иначе он размонтируется под пользователем.
  const [addItems, setAddItems] = useState<CampaignPostInput[] | null>(null);

  // Канонический фильтр кампании (?campaign=): membership читается ТОЛЬКО из /api/campaigns/:id/posts.
  const { campaignId } = useCampaignFilter();
  const campaignPostsQ = useCampaignPosts(campaignId);
  const memberSet = useMembershipSet(campaignPostsQ.data?.posts);
  const removeMut = useRemoveCampaignPosts();

  // Reset selection when the source/campaign/window changes (primitive deps — `period` is a fresh
  // object each render, so depending on it would wipe the selection on every keystroke).
  useEffect(() => {
    setSelected(new Set());
    setAddItems(null);
  }, [channelId, campaignId, pageDays, pageRange, filters.q, filters.format]);

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const inPeriod = allPosts.filter((post) => period.inRange(post.date));
  // Comparable-period scope: the source's posts in this window (campaign-scoped when a campaign is
  // selected). Medians + the campaign count are measured over THIS set, not the search subset.
  const scope =
    campaignId != null && channelId != null
      ? inPeriod.filter((p) => p.id != null && memberSet.has(membershipKey('tg', channelId, String(p.id))))
      : inPeriod;
  const visible = filterPosts(scope, { q: filters.q, format: filters.format });
  const rows = sortPosts(visible, filters.sort, filters.order);
  // Content export = exactly the displayed rows (this source, window, campaign, search, format, sort);
  // only the currently loaded rows, never a full historical archive. Window bounds name the file.
  const channel = channelsData?.channels.find((c) => c.id === channelId);
  const exportWindow = calendarWindowForPeriod({ days: pageDays, range: pageRange });
  const onExport = () =>
    downloadCsv(
      exportFilename({
        network: 'telegram',
        section: 'content',
        source: channel?.title ?? channel?.username ?? '',
        from: exportWindow?.from,
        to: exportWindow?.to,
      }),
      tgContentRows(rows),
    );
  // Preserve the pre-redesign mobile list contract: reach-desc, top 25, unaffected by desktop-only
  // search/format/sort controls. Mobile layout and controls remain outside this task.
  const mobileRows = sortPosts(scope, 'reach', 'desc').slice(0, 25);

  const selectedItems: CampaignPostInput[] =
    channelId == null
      ? []
      : rows
          .filter((post) => post.id != null && selected.has(post.id))
          .map((post) => ({ network: 'tg', channel_id: channelId, post_ref: String(post.id) }));

  // Comparable-period medians (honesty-gated by MEDIAN_MIN_SAMPLE — below it periodMedian returns
  // null and the per-row context is withheld rather than faked).
  const reachMedian = periodMedian(scope.map((p) => p.reach));
  const likesMedian = periodMedian(scope.map((p) => p.likes));
  const sharesMedian = periodMedian(scope.map((p) => p.shares ?? 0));
  const ervMedian = periodMedian(scope.map((p) => p.erv).filter((v): v is number => v != null));

  const selectedPost = scope.find((p) => p.id === openId);
  const selectedReachComparison = selectedPost
    ? compareToMedian(selectedPost.reach, reachMedian)
    : null;
  const hasContentFilters = filters.q.trim() !== '' || filters.format !== 'all';

  // «Выбрать все» относится к ВИДИМЫМ строкам (текущий фильтр/сортировка) — честная семантика.
  const visibleIds = rows.map((p) => p.id).filter((id): id is number => id != null);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });

  const onRemoveFromCampaign = () => {
    if (campaignId == null || selectedItems.length === 0) return;
    removeMut.mutate(
      { campaignId, items: selectedItems },
      { onSuccess: () => setSelected(new Set()) },
    );
  };

  const toolbar = (
    <div className="space-y-3 border-b border-border pb-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <CampaignFilterControl />
          {/* Desktop-only filters: text search + media format (mobile keeps the untouched list). */}
          <label className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
            <span className="sr-only">Поиск по публикациям</span>
            <input
              type="search"
              value={filters.q}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="Поиск по тексту и хэштегам"
              aria-label="Поиск по публикациям"
              className="w-56 rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
            />
          </label>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
            <span className="shrink-0">Формат</span>
            <PillSelect<ContentFormat>
              value={filters.format}
              onValueChange={(v) => update({ format: v })}
              ariaLabel="Формат публикаций"
              testId="format-filter"
              options={FORMAT_OPTIONS}
            />
          </div>
          {/* Desktop-only content export — exactly the rows shown below. */}
          <button
            type="button"
            onClick={onExport}
            disabled={rows.length === 0}
            aria-label="Экспорт показанных публикаций в CSV"
            title={rows.length === 0 ? 'Нет публикаций для экспорта' : `CSV: ${rows.length} показанных публикаций`}
            className="hidden btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 md:inline-flex"
          >
            Экспорт таблицы
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <span className="tabular-nums" data-testid="content-result-count">{fmt.num(rows.length)} публ.</span>
          {hasContentFilters && (
            <button
              type="button"
              onClick={() => update({ q: '', format: 'all' })}
              className="text-2xs font-medium text-primary hover:underline"
            >
              Сбросить фильтры
            </button>
          )}
          {campaignId != null && campaignPostsQ.data && (
            <span className="tabular-nums">
              {fmt.num(scope.length)} из {fmt.num(campaignPostsQ.data.posts.length)} публ. кампании — из этого источника
            </span>
          )}
          {loadedCount >= 100 && <span>загружены последние 100</span>}
          {scope.length > 0 && reachMedian == null && (
            <span>сравнение появится от {MEDIAN_MIN_SAMPLE} публикаций</span>
          )}
        </div>
      </div>
      {/* Bulk actions (desktop table only). */}
      <div className="hidden items-center gap-2 md:flex">
        {selectedItems.length > 0 ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">Выбрано: {fmt.num(selectedItems.length)}</span>
            <button
              type="button"
              onClick={() => setAddItems(selectedItems)}
              className="btn-pill bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="add-to-campaign"
            >
              Добавить в кампанию
            </button>
            {campaignId != null && (
              <button
                type="button"
                onClick={onRemoveFromCampaign}
                disabled={removeMut.isPending}
                className="btn-pill border border-border px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                data-testid="remove-from-campaign"
              >
                {removeMut.isPending ? 'Убираю…' : 'Убрать из кампании'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="btn-pill px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
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
        {removeMut.isError && (
          <span role="alert" className="text-2xs text-destructive">Не удалось убрать из кампании.</span>
        )}
      </div>
    </div>
  );

  if (campaignId != null && campaignPostsQ.isPending) {
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="space-y-2 py-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (campaignId != null && campaignPostsQ.isError) {
    return (
      <div className="space-y-3">
        {toolbar}
        <p className="py-6 text-center text-sm text-muted-foreground">Не удалось загрузить публикации кампании.</p>
      </div>
    );
  }
  const noDesktopFilterMatches = scope.length > 0 && rows.length === 0;
  if (rows.length === 0 && !noDesktopFilterMatches) {
    const message =
      campaignId != null && scope.length === 0
        ? 'В этой кампании нет публикаций из текущего источника за выбранный период.'
        : scope.length > 0
          ? 'Ничего не найдено по выбранным фильтрам.'
          : 'За выбранный период публикаций нет.';
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="py-8 text-center text-sm text-muted-foreground">{message}</div>
        {addItems && addItems.length > 0 && (
          <AddToCampaignDialog items={addItems} onClose={() => setAddItems(null)} onDone={() => setSelected(new Set())} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}
      {noDesktopFilterMatches && (
        <div className="hidden py-8 text-center text-sm text-muted-foreground md:block">
          Ничего не найдено по выбранным фильтрам.
        </div>
      )}
      <div className={cn('hidden overflow-x-auto md:block', noDesktopFilterMatches && 'md:hidden')}>
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
              <th className="w-10 py-2.5 pl-0 pr-2">
                <input
                  type="checkbox"
                  aria-label="Выбрать все видимые публикации"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  className="size-4 accent-primary"
                />
              </th>
              <th className="w-12 py-2.5 pl-0 pr-3 text-center"></th>
              <th className="min-w-[240px] px-3 py-2.5">Пост</th>
              {CONTENT_SORT_COLUMNS.filter((c) => c.key !== 'date').map((c) => {
                const active = c.key === filters.sort;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
                    className="w-[104px] px-3 py-2.5 text-right last:pr-0"
                  >
                    <SortButton
                      label={c.label}
                      active={active}
                      order={filters.order}
                      onClick={() => toggleSort(c.key)}
                    />
                  </th>
                );
              })}
              <th
                aria-sort={filters.sort === 'date' ? (filters.order === 'desc' ? 'descending' : 'ascending') : undefined}
                className="w-[96px] px-3 py-2.5 pr-0 text-right"
              >
                <SortButton
                  label="Дата"
                  active={filters.sort === 'date'}
                  order={filters.order}
                  onClick={() => toggleSort('date')}
                />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((post, idx) => {
              const isClickable = post.id != null;
              return (
                <tr
                  key={post.id ?? idx}
                  onClick={isClickable ? () => setOpenId(post.id) : undefined}
                  className={`group transition-colors hover:bg-hover-row ${isClickable ? 'cursor-pointer' : ''}`}
                >
                  {/* Чекбокс не должен открывать модалку — гасим всплытие на ячейке. */}
                  <td className="py-2.5 pl-0 pr-2" onClick={(e) => e.stopPropagation()}>
                    {post.id != null && (
                      <input
                        type="checkbox"
                        aria-label="Выбрать публикацию"
                        checked={selected.has(post.id)}
                        onChange={() => toggleSelect(post.id!)}
                        className="size-4 accent-primary"
                        data-testid="post-select"
                      />
                    )}
                  </td>
                  <td className="py-2.5 pl-0 pr-3 text-center">
                    <PostThumb thumb={post.thumb} mediaType={post.mediaType} albumSize={post.albumSize} icon />
                  </td>
                  <td className="px-3 py-2.5">
                    {isClickable ? (
                      // A real, focusable control in the row — the tr onClick alone is mouse-only,
                      // leaving keyboard users no desktop path to the post details.
                      <button
                        type="button"
                        onClick={() => setOpenId(post.id)}
                        className="block w-full max-w-sm space-y-1 text-left md:max-w-md lg:max-w-lg"
                      >
                        <span className={cn('line-clamp-1 font-medium', post.caption ? 'text-foreground' : 'italic text-muted-foreground')}>
                          {post.caption ? markdownToPlainText(post.caption) : 'Без подписи'}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <FormatTag post={post} />
                          {post.albumSize > 1 && <span>{post.albumSize} фото</span>}
                        </span>
                      </button>
                    ) : (
                      <div className="max-w-sm space-y-1 md:max-w-md lg:max-w-lg">
                        <div className="line-clamp-1 font-medium text-foreground">
                          {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <FormatTag post={post} />
                          {post.albumSize > 1 && <span>{post.albumSize} фото</span>}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right last:pr-0">
                    <MedianCell value={post.reach} median={reachMedian} tone="signal" format={fmt.num} />
                  </td>
                  <td className="px-3 py-2.5 text-right last:pr-0">
                    <MedianCell value={post.likes} median={likesMedian} tone="muted" format={fmt.num} />
                  </td>
                  <td className="px-3 py-2.5 text-right last:pr-0">
                    <MedianCell value={post.shares} median={sharesMedian} tone="muted" format={fmt.num} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-muted-foreground last:pr-0">
                    {post.virality != null ? `${post.virality.toFixed(1)}%` : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right last:pr-0">
                    <MedianCell value={post.erv} median={ervMedian} tone="muted" format={(v) => `${v.toFixed(1)}%`} />
                  </td>
                  <td className="px-3 py-2.5 pr-0 text-right font-medium tabular-nums text-muted-foreground">
                    {post.er != null ? `${post.er.toFixed(1)}%` : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-2.5 pr-0 text-right text-xs tabular-nums text-muted-foreground">
                    {post.date ? <TwoLineDate iso={post.date} /> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* mobile: card list (no horizontal scroll) — unchanged reach-desc top-25 behavior */}
      <div className="divide-y divide-border md:hidden">
        {mobileRows.map((post, idx) => {
          const isClickable = post.id != null;
          const title = post.caption ? markdownToPlainText(post.caption) : null;
          const reachVsMedian = compareToMedian(post.reach, reachMedian);
          return (
            <button
              key={post.id ?? idx}
              type="button"
              onClick={isClickable ? () => setOpenId(post.id) : undefined}
              className={cn('flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-hover-row', isClickable && 'cursor-pointer')}
            >
              <PostThumb thumb={post.thumb} mediaType={post.mediaType} albumSize={post.albumSize} />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm', title ? 'text-foreground' : 'italic text-muted-foreground')}>
                  {title ?? 'Без подписи'}
                </span>
                <span className="mt-0.5 block truncate text-2xs text-ink2">
                  {fmt.num(post.reach)} просмотров{reachVsMedian ? ` · ${medianDeltaLabel(reachVsMedian)}` : ''} · {fmt.num(post.likes)} · ER {post.er != null ? `${post.er.toFixed(1)}%` : '—'}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Общая модалка поста (D6.2): без №-бейджа — порядок таблицы зависит от текущей сортировки. */}
      {openId !== null && selectedPost && (
        <PostDetailModal
          post={selectedPost}
          reason={selectedReachComparison ? medianDeltaLabel(selectedReachComparison) : null}
          reasonTone={
            selectedReachComparison?.dir === 'above'
              ? 'positive'
              : selectedReachComparison?.dir === 'below'
                ? 'negative'
                : 'neutral'
          }
          benchmarkUnavailable={reachMedian == null}
          onAddToCampaign={
            selectedPost.id != null && channelId != null
              ? () => {
                  const item: CampaignPostInput = { network: 'tg', channel_id: channelId, post_ref: String(selectedPost.id) };
                  setOpenId(null);
                  setAddItems([item]);
                }
              : undefined
          }
          onClose={() => setOpenId(null)}
        />
      )}

      {addItems && addItems.length > 0 && (
        <AddToCampaignDialog
          items={addItems}
          onClose={() => setAddItems(null)}
          onDone={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

/** Sortable column header button (aria-sort lives on the <th>). */
function SortButton({
  label,
  active,
  order,
  onClick,
}: {
  label: string;
  active: boolean;
  order: 'asc' | 'desc';
  onClick: () => void;
}) {
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

/** Дата максимум в две строки («20 июн.» / «06:01»): узкая колонка не должна ломать дату на три. */
function TwoLineDate({ iso }: { iso: string }) {
  const [day, time] = fmt.date(iso).split(', ');
  return (
    <span className="inline-flex flex-col items-end">
      <span className="whitespace-nowrap">{day}</span>
      {time && <span className="whitespace-nowrap">{time}</span>}
    </span>
  );
}

/** Media-format word for the post-caption subline — replaces the ad-hoc date there (date is now its
    own sortable column), so the format bucket the search/filter uses is also legible in the row. */
function FormatTag({ post }: { post: NormalizedPost }) {
  const label =
    post.albumSize > 1 ? 'Альбом' : post.mediaType === 'video' ? 'Видео' : post.mediaType === 'photo' ? 'Фото' : 'Текст';
  return <span>{label}</span>;
}

/**
 * A metric cell with explicit comparable-period median context. The value is always shown; the
 * delta appears only when periodMedian cleared the min-sample gate (never a faked benchmark). In
 * the dense table the delta is SHORT («+28%», full wording in the title tooltip) — repeating
 * «к медиане» in every cell is noise. One colour rule for every metric column (`dir` → green/red);
 * `tone` only picks the value ink (primary signal column vs muted secondary).
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
  const deltaColor = cmp
    ? cmp.dir === 'above'
      ? 'text-verdant'
      : cmp.dir === 'below'
        ? 'text-ember'
        : 'text-muted-foreground'
    : 'text-muted-foreground';
  const deltaShort = cmp
    ? cmp.dir === 'at' ? '±0%' : `${cmp.pct > 0 ? '+' : '−'}${Math.abs(Math.round(cmp.pct))}%`
    : null;
  return (
    <>
      <span className={cn('block font-medium tabular-nums', tone === 'signal' ? 'text-foreground' : 'text-muted-foreground')}>
        {format(value)}
      </span>
      {cmp && (
        <span className={cn('block text-2xs tabular-nums', deltaColor)} title="к медиане за период">
          {deltaShort}
        </span>
      )}
    </>
  );
}

/**
 * Превью поста с честным фолбэком: битый/недоступный thumb — больше не молчаливый серый квадрат
 * (дизайн-проход №3). В desktop-таблице (`icon`) фолбэк — line-art иконка типа медиа (словом тип
 * уже дублирует FormatTag в колонке «Пост»); мобильный список сохраняет прежний словесный фолбэк.
 */
function PostThumb({
  thumb,
  mediaType,
  albumSize,
  icon = false,
}: {
  thumb: string | null;
  mediaType: string | null;
  albumSize: number;
  icon?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const label =
    mediaType === 'video' ? 'Видео' : mediaType === 'photo' ? (albumSize > 1 ? `${albumSize} фото` : 'Фото') : 'Текст';
  return (
    <div
      title={icon && (!thumb || broken) ? label : undefined}
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border/40 bg-muted"
    >
      {thumb && !broken ? (
        <img
          loading="lazy"
          src={thumb}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : icon ? (
        <Icon
          name={mediaType === 'video' ? 'playCircle' : mediaType === 'photo' ? 'image' : 'posts'}
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
      ) : (
        <span className="px-0.5 text-center text-2xs font-medium leading-tight text-muted-foreground">{label}</span>
      )}
    </div>
  );
}

function PostsSkeletons() {
  // Mirrors the loaded layout: a toolbar strip + table rows on the bare section surface (no nested
  // card — the ChartSection wrapper is gone).
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="mt-2 space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-10 w-10" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}
