import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMentionSettings, useMentions, useMentionsArchive } from '@/api/queries';
import { usePagePeriod } from '@/lib/period';
import { serializeContentPeriod } from '@/lib/contentFilters';
import {
  applyMentionsFilters,
  buildMentionsTimeline,
  ddmmFromIso,
  filterMentionRows,
  mentionsDelta,
  mentionsInsights,
  parseMentionsFilters,
  sortMentionRows,
  type MentionDailyPoint,
  type MentionRow,
  type MentionSourceOption,
  type MentionsDelta,
  type MentionsFilters,
  type MentionsSort,
} from '@/lib/mentionsFilters';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BarChart } from '@/components/BarChart';
import { PillSelect } from '@/components/PillSelect';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Icon } from '@/components/nav-icons';
import { Skeleton } from '@/components/ui/skeleton';
import { MentionRulesDialog } from '@/components/mentions/MentionRulesDialog';

/**
 * DESKTOP «Упоминания» (md+): a Steep-flavoured PR-monitoring surface rendered directly inside the
 * section's FeedBlock (no second H1, no decorative page-card). The header's period chips are the
 * authoritative window for EVERY aggregate, the chart, the ranking and the table; text search /
 * mentioning-channel filter / sort all live in the URL (lib/mentionsFilters) so the whole view is a
 * reproducible, reload-stable link. The live search only refreshes the archive — it never replaces
 * the archive model, so the period/source stays authoritative.
 */
export function MentionsDesktop() {
  const [params, setParams] = useSearchParams();
  const pp = usePagePeriod();
  const [rulesOpen, setRulesOpen] = useState(false);

  const filters = useMemo(() => parseMentionsFilters(params), [params]);
  const pageDays = pp?.days ?? filters.period;

  // ── Two-way period sync (mirrors Posts): URL wins on mount/navigation, the page provider wins
  //    otherwise, so Обзор → Упоминания keeps the chosen window; direct ?period= + Back/Forward work.
  const rawUrlPeriod = params.get('period');
  const periodSyncReady = useRef(false);
  const lastUrlPeriod = useRef<string | null>(rawUrlPeriod);
  useEffect(() => {
    const writePeriod = (days: MentionsFilters['period']) => {
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

  const update = (patch: Partial<MentionsFilters>) =>
    setParams(applyMentionsFilters(params, { ...filters, period: pageDays, ...patch }), { replace: true });

  // Remove malformed/default query values without touching unrelated params. Use the URL-parsed
  // period here (not `pageDays`): on a direct deep link the URL must win before the provider syncs.
  useEffect(() => {
    const canonical = applyMentionsFilters(params, filters);
    if (canonical.toString() !== params.toString()) setParams(canonical, { replace: true });
  }, [filters, params, setParams]);

  // Archive is the AUTHORITY — scoped to the page window (preset OR the top-bar custom range) +
  // selected source, up to 100 rows. The custom range is server-filtered (never client-truncated).
  const hasRange = !!pp?.range;
  const archive = useMentionsArchive(pageDays, filters.source, 100, pp?.range ?? null);
  const live = useMentions();
  const mentionSettings = useMentionSettings();
  const settings = mentionSettings.data;

  // Live search only refreshes the archive; the desktop view is never rendered from live.data.
  const onRefresh = async () => {
    if (!settings?.configured) {
      if (settings) setRulesOpen(true);
      return;
    }
    if (!settings.can_edit) return;
    const res = await live.refetch();
    if (res.data && res.data.available !== false) await archive.refetch();
  };
  const refreshing = live.isFetching;
  const liveError = (() => {
    if (live.isFetched && live.data && live.data.available === false) {
      return /premium/i.test(live.data.error || '')
        ? 'Нужен аккаунт с Telegram Premium.'
        : live.data.error || 'Поиск недоступен.';
    }
    if (live.isError) return live.error instanceof Error ? live.error.message : 'Ошибка запроса';
    return null;
  })();
  const needsReconnect = liveError != null && /подключ|сесси/i.test(liveError);
  const settingsError = mentionSettings.isError
    ? mentionSettings.error instanceof Error ? mentionSettings.error.message : 'Ошибка запроса'
    : null;
  const rulesDialog = rulesOpen && settings ? (
    <MentionRulesDialog settings={settings} onClose={() => setRulesOpen(false)} />
  ) : null;

  const data = archive.data;
  const sourceOptions: MentionSourceOption[] = data?.source_options ?? [];
  const selectedSource = filters.source
    ? sourceOptions.find((option) => option.channel_id === filters.source) ?? null
    : null;

  // Drop a stale ?source= (not in the current period's options) so the filter can't wedge the view.
  useEffect(() => {
    if (!filters.source || !data) return;
    if (!sourceOptions.some((o) => o.channel_id === filters.source)) update({ source: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.source, data, sourceOptions]);

  // Derived view model — all hooks run unconditionally (before the loading/empty gates below).
  const total = data?.total ?? 0;
  const totalViews = data?.total_views ?? 0;
  const uniqueChannels = data?.unique_channels ?? 0;
  const avgViews = total > 0 ? Math.round(totalViews / total) : 0;
  const previous = data?.previous ?? null;
  const prevAvg = previous && previous.total > 0 ? previous.total_views / previous.total : null;
  const daily: MentionDailyPoint[] = data?.daily ?? [];
  const previousDaily: MentionDailyPoint[] = data?.previous_daily ?? [];
  // Server scope from/to (authoritative window that was actually queried) drives the range timeline —
  // avoids any client/server timezone split between the epoch-ms range and the ISO days the DB filtered.
  const scopeFrom = data?.scope?.from ?? null;
  const scopeTo = data?.scope?.to ?? null;
  const timeline = useMemo(
    () =>
      buildMentionsTimeline(
        daily,
        previousDaily,
        pageDays,
        data?.scope?.current_to ?? Date.now(),
        scopeFrom && scopeTo ? { from: scopeFrom, to: scopeTo } : null,
      ),
    [daily, previousDaily, pageDays, data?.scope?.current_to, scopeFrom, scopeTo],
  );
  const sourceSummary = data?.source_summary;
  const contextSources = selectedSource ? [selectedSource] : sourceOptions;
  const insights = useMemo(
    () => mentionsInsights(
      daily,
      contextSources,
      sourceSummary?.total ?? total,
      sourceSummary?.total_views ?? totalViews,
    ),
    [contextSources, daily, sourceSummary?.total, sourceSummary?.total_views, total, totalViews],
  );

  if (archive.isPending && !data) return <MentionsDesktopSkeleton />;
  if (archive.isError && !data) {
    return (
      <ErrorState
        title="Не удалось загрузить архив упоминаний"
        reason={archive.error instanceof Error ? archive.error.message : 'ошибка сервера'}
        onRetry={() => archive.refetch()}
        retrying={archive.isRefetching}
      />
    );
  }
  if (data?.available === false && data.error) {
    return (
      <ErrorState
        title="Архив упоминаний временно недоступен"
        reason={data.error}
        onRetry={() => archive.refetch()}
        retrying={archive.isRefetching}
      />
    );
  }

  const hasArchive = (data?.archive_total ?? 0) > 0 || (data?.total ?? 0) > 0;
  if (!hasArchive) {
    return (
      <>
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-background px-4 py-12 text-center">
          <h3 className="mb-1 text-base font-medium text-foreground">Аналитика упоминаний бренда</h3>
          <p className="mb-5 max-w-md text-sm text-muted-foreground">
            {settings?.configured
              ? 'В архиве пока нет упоминаний. Запустите поиск вручную, чтобы проверить новые публикации.'
              : settings
                ? 'Укажите варианты названия бренда и лишние совпадения, которые нужно отсеивать для этого канала.'
                : 'Загружаем правила поиска для выбранного канала.'}
          </p>
          {settingsError && (
            <p role="alert" className="mb-4 text-sm text-destructive">
              Не удалось загрузить правила: {settingsError}
            </p>
          )}
          {liveError && (
            <div className="mb-4 space-y-2 text-sm text-destructive">
              <p>{liveError}</p>
              {needsReconnect && (
                <Link className="inline-block text-primary underline underline-offset-4" to="/connect?source=telegram&tab=qr&action=reconnect">
                  Переподключить Telegram
                </Link>
              )}
            </div>
          )}
          {settings?.configured && settings.can_edit ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRulesOpen(true)}
                className="btn-pill border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-hover-row"
              >
                Правила поиска
              </button>
              <button
                type="button"
                onClick={() => void onRefresh()}
                disabled={refreshing}
                className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {refreshing ? 'Поиск…' : 'Найти упоминания'}
              </button>
            </div>
          ) : settings ? (
            <button
              type="button"
              onClick={() => setRulesOpen(true)}
              className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {settings.can_edit ? 'Настроить поиск' : 'Посмотреть правила'}
            </button>
          ) : (
            <button
              type="button"
              disabled={mentionSettings.isPending}
              onClick={() => void mentionSettings.refetch()}
              className="btn-pill border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-hover-row disabled:opacity-50"
            >
              {mentionSettings.isPending ? 'Загрузка правил…' : 'Повторить'}
            </button>
          )}
        </div>
        {rulesDialog}
      </>
    );
  }

  // Table rows come from the server-scoped archive; q is client-side, sort is URL-backed + stable.
  const recent: MentionRow[] = data?.recent ?? [];
  const visible = filterMentionRows(recent, filters.q);
  const rows = sortMentionRows(visible, filters.sort, filters.order);

  // A custom range is always comparable (server returns the previous equal-length window); only the
  // preset «Всё время» (no range) has no comparison base.
  const periodComparable = hasRange || pageDays !== 0;
  return (
    <div className="space-y-8">
      {/* 1. Operational row: archive freshness (left) + the quota-costing command (right). */}
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">Архив Telegram</p>
          <p className="text-xs text-muted-foreground">
            {fmt.num(data?.archive_total ?? 0)} упоминаний в архиве
            {data?.updated_at ? ` · обновлён ${fmt.date(data.updated_at)}` : ''}.
            {settings?.configured
              ? ` Ищем по ${fmt.num(settings.rules.include_terms.length)} ${settings.rules.include_terms.length === 1 ? 'термину' : 'терминам'}.`
              : settings
                ? ' Правила поиска ещё не настроены.'
                : ' Загружаем правила поиска.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            {settings && (
              <button
                type="button"
                onClick={() => setRulesOpen(true)}
                className="btn-pill inline-flex items-center gap-2 border border-border bg-background px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover-row"
              >
                <Icon name="gear" className="size-4 text-muted-foreground" />
                {settings.configured ? 'Правила поиска' : 'Настроить поиск'}
              </button>
            )}
            {settings?.configured && settings.can_edit && (
              <button
                type="button"
                onClick={() => void onRefresh()}
                disabled={refreshing}
                className="btn-pill border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover-row disabled:opacity-50"
              >
                {refreshing ? 'Обновление…' : 'Найти новые'}
              </button>
            )}
          </div>
          {settings?.configured && settings.can_edit && (
            <span className="text-2xs text-muted-foreground">Поиск запускается вручную и расходует ограниченную квоту Telegram.</span>
          )}
          {settings && !settings.can_edit && (
            <span className="text-2xs text-muted-foreground">Поиск может запускать владелец или администратор.</span>
          )}
          <span role="status" className="sr-only">{refreshing ? 'Обновление…' : ''}</span>
        </div>
      </div>

      {settingsError && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-muted-foreground">
          <span>Не удалось загрузить правила поиска: {settingsError}</span>
          <button type="button" onClick={() => void mentionSettings.refetch()} className="shrink-0 text-foreground underline underline-offset-4">
            Повторить
          </button>
        </div>
      )}

      {liveError && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-muted-foreground">
          <span>Не удалось обновить: {liveError} Показан сохранённый архив.</span>
          {needsReconnect && (
            <Link className="shrink-0 text-primary underline underline-offset-4" to="/connect?source=telegram&tab=qr&action=reconnect">
              Переподключить Telegram
            </Link>
          )}
        </div>
      )}

      {/* 2. KPI ledger (unframed) with previous-equal-period comparison (neutral deltas). */}
      <section className="space-y-2">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 lg:grid-cols-4">
          <Kpi label="Упоминания" value={fmt.num(total)} delta={periodComparable ? mentionsDelta(total, previous?.total) : null} />
          <Kpi
            label="Потенциальные просмотры"
            value={fmt.kpi(totalViews)}
            delta={periodComparable ? mentionsDelta(totalViews, previous?.total_views) : null}
          />
          <Kpi label="Каналы" value={fmt.num(uniqueChannels)} delta={periodComparable ? mentionsDelta(uniqueChannels, previous?.unique_channels) : null} />
          <Kpi
            label="Средние просмотры / упоминание"
            value={fmt.num(avgViews)}
            delta={periodComparable ? mentionsDelta(avgViews, prevAvg) : null}
          />
        </div>
        <p className="text-2xs text-muted-foreground">
          «Потенциальные просмотры» — сумма просмотров упомянувших постов без дедупликации аудитории,
          не охват. {periodComparable ? 'Сравнение — с предыдущим равным периодом.' : 'Сравнение с периодом недоступно для «Всё время».'}
        </p>
      </section>

      {/* 3. One full-width daily timeline (discrete events → bars); ghost = previous equal period. */}
      <section className="space-y-3">
        <WidgetGroup id="mentions-timeline-desktop" className="grid grid-cols-1 gap-6">
          <ChartSection
            id="mentions-timeline"
            title={!hasRange && pageDays === 0 ? 'Упоминания по дням · последние 365 дней' : 'Упоминания по дням'}
            fixedSize="full"
            expand={{
              renderExpandedBar: () => (
                <BarChart values={timeline.values} labels={timeline.labels} titles={timeline.titles} ghost={timeline.ghost} ghostLabel="Предыдущий период" />
              ),
              statsFor: () => timeline.values,
            }}
          >
            {timeline.values.length > 0 ? (
              <BarChart values={timeline.values} labels={timeline.labels} titles={timeline.titles} ghost={timeline.ghost} ghostLabel="Предыдущий период" />
            ) : (
              <EmptyState compact title="За выбранный период упоминаний нет." />
            )}
          </ChartSection>
        </WidgetGroup>
        {!hasRange && pageDays === 0 && (
          <p className="text-2xs text-muted-foreground">
            KPI охватывают весь архив; дневной график ограничен последними {fmt.num(data?.scope?.daily_days ?? 365)} днями.
          </p>
        )}
      </section>

      {/* 4. Who mentions (leaderboard) + period context, 50/50. */}
      <section className="space-y-3">
        <WidgetGroup id="mentions-drivers-desktop" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
          <ChartSection id="mentions-sources" title="Кто упоминает · за период" fixedSize="half" noExpand>
            <SourceLeaderboard
              options={sourceOptions}
              selected={filters.source}
              onSelect={(id) => update({ source: filters.source === id ? '' : id })}
            />
          </ChartSection>
          <ChartSection id="mentions-context" title="Контекст периода" fixedSize="half" noExpand>
            <PeriodContext insights={insights} total={total} sourceFiltered={filters.source !== ''} />
          </ChartSection>
        </WidgetGroup>
      </section>

      {/* 5. Full-width dense table directly on the surface. */}
      <MentionsTable
        rows={rows}
        totalInPeriod={recent.length}
        filters={filters}
        sourceOptions={sourceOptions}
        selectedSourceLabel={selectedSource}
        onUpdate={update}
        hasArchive={hasArchive}
        hasPeriodRows={total > 0}
      />
      {rulesDialog}
    </div>
  );
}

// ── KPI tile ─────────────────────────────────────────────────────────────────────────────────────
function Kpi({ label, value, delta }: { label: string; value: string; delta: MentionsDelta | null }) {
  return (
    <div>
      <div className="text-2xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-medium tabular-nums text-foreground">{value}</div>
      <DeltaLine delta={delta} />
    </div>
  );
}

/** Neutral (never green/red) comparison line — mention counts carry no sentiment. */
function DeltaLine({ delta }: { delta: MentionsDelta | null }) {
  if (!delta) return null;
  if (!delta.hasBase) return <div className="mt-0.5 text-2xs text-muted-foreground">нет базы</div>;
  const pct = delta.pct ?? 0;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return (
    <div className="mt-0.5 text-2xs text-muted-foreground">
      {sign}{Math.abs(pct).toFixed(0)}% к пред. периоду
    </div>
  );
}

// ── Leaderboard of mentioning channels (not fake reach) ─────────────────────────────────────────
function SourceLeaderboard({
  options,
  selected,
  onSelect,
}: {
  options: MentionSourceOption[];
  selected: string;
  onSelect: (channelId: string) => void;
}) {
  if (options.length === 0) return <EmptyState compact title="Нет упоминающих каналов за период." />;
  const max = Math.max(...options.map((o) => o.count), 1);
  const top = options.slice(0, 5);
  const selectedOption = selected ? options.find((option) => option.channel_id === selected) : null;
  const visible = selectedOption && !top.includes(selectedOption)
    ? [selectedOption, ...top.slice(0, 4)]
    : top;
  const hiddenCount = Math.max(0, options.length - visible.length);
  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      {visible.map((o) => {
        const id = o.channel_id ?? '';
        const label = o.username ? `@${o.username}` : o.title || 'Без названия';
        const active = !!id && id === selected;
        return (
          <button
            key={id || label}
            type="button"
            onClick={() => id && onSelect(id)}
            disabled={!id}
            aria-pressed={active}
            className={cn(
              'w-full border-t border-border pt-2 text-left first:border-t-0 first:pt-0 transition-colors',
              id && 'hover:text-foreground',
              active && 'text-foreground',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{fmt.num(o.count)} упом.</span>
              <span className="w-24 text-right text-xs font-medium tabular-nums text-foreground">
                {fmt.short(o.views)} просм.
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', active ? 'bg-primary' : 'bg-primary/50')}
                style={{ width: `${Math.max(3, Math.round((o.count / max) * 100))}%` }}
              />
            </div>
          </button>
        );
      })}
      {hiddenCount > 0 && (
        <p className="mt-auto text-2xs text-muted-foreground">
          Ещё {fmt.num(hiddenCount)} — доступны в фильтре таблицы.
        </p>
      )}
    </div>
  );
}

// ── Period context: honest derived insights (no sentiment / AI claims) ──────────────────────────
function PeriodContext({
  insights,
  total,
  sourceFiltered,
}: {
  insights: ReturnType<typeof mentionsInsights>;
  total: number;
  sourceFiltered: boolean;
}) {
  const items: { label: string; value: string }[] = [];
  if (insights.peak) items.push({
    label: sourceFiltered ? 'Пик выбранного канала' : 'Пик упоминаний',
    value: `${ddmmFromIso(insights.peak.day)} · ${fmt.num(insights.peak.mentions)}`,
  });
  if (insights.topSourceLabel && insights.topSourceMentionShare != null) {
    items.push({
      label: sourceFiltered ? 'Выбранный канал' : 'Главный канал периода',
      value: `${insights.topSourceLabel} · ${Math.round(insights.topSourceMentionShare * 100)}% упоминаний`,
    });
  }
  if (insights.topSourceViewShare != null && insights.topSourceLabel) {
    items.push({
      label: 'Доля потенц. просмотров',
      value: sourceFiltered
        ? `${Math.round(insights.topSourceViewShare * 100)}% у выбранного канала`
        : `${Math.round(insights.topSourceViewShare * 100)}% у главного источника`,
    });
  }
  if (total === 0 || items.length === 0) {
    return <EmptyState compact title="Недостаточно данных за период." />;
  }
  return (
    <div className="flex h-full flex-col gap-3">
      {items.map((it) => (
        <div key={it.label} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
          <div className="text-2xs font-medium text-muted-foreground">{it.label}</div>
          <div className="mt-0.5 text-sm text-foreground">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Dense table ─────────────────────────────────────────────────────────────────────────────────
function MentionsTable({
  rows,
  totalInPeriod,
  filters,
  sourceOptions,
  selectedSourceLabel,
  onUpdate,
  hasArchive,
  hasPeriodRows,
}: {
  rows: MentionRow[];
  totalInPeriod: number;
  filters: MentionsFilters;
  sourceOptions: MentionSourceOption[];
  selectedSourceLabel: MentionSourceOption | null;
  onUpdate: (patch: Partial<MentionsFilters>) => void;
  hasArchive: boolean;
  hasPeriodRows: boolean;
}) {
  const toggleSort = (key: MentionsSort) =>
    onUpdate(
      key === filters.sort
        ? { order: filters.order === 'desc' ? 'asc' : 'desc' }
        : { sort: key, order: key === 'source' ? 'asc' : 'desc' },
    );
  const hasFilters = filters.q.trim() !== '' || filters.source !== '';

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="sr-only">Поиск по упоминаниям</span>
          <input
            type="search"
            value={filters.q}
            onChange={(e) => onUpdate({ q: e.target.value })}
            placeholder="Поиск по каналу и тексту"
            aria-label="Поиск по упоминаниям"
            className="w-56 rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
          />
        </label>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Кто упомянул</span>
          <PillSelect
            value={filters.source}
            onValueChange={(v) => onUpdate({ source: v })}
            ariaLabel="Фильтр по упомянувшему каналу"
            testId="mentions-source-filter"
            className="max-w-56"
            options={[
              { value: '', label: 'Все каналы' },
              ...sourceOptions.map((o) => ({
                value: o.channel_id ?? '',
                label: `${o.username ? `@${o.username}` : o.title || 'Без названия'} · ${o.count}`,
              })),
            ]}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span className="tabular-nums" data-testid="mentions-result-count">{fmt.num(rows.length)} упом.</span>
        {selectedSourceLabel && (
          <span className="tabular-nums">
            фильтр: {selectedSourceLabel.username ? `@${selectedSourceLabel.username}` : selectedSourceLabel.title}
          </span>
        )}
        {hasFilters && (
          <button
            type="button"
            onClick={() => onUpdate({ q: '', source: '' })}
            className="text-2xs font-medium text-primary hover:underline"
          >
            Сбросить фильтры
          </button>
        )}
      </div>
    </div>
  );

  const empty = (() => {
    if (!hasArchive) return null;
    if (!hasPeriodRows) return 'За выбранный период упоминаний нет.';
    if (rows.length === 0) return 'Ничего не найдено по фильтрам.';
    return null;
  })();

  return (
    <div className="space-y-3">
      {toolbar}
      {empty ? (
        <div className="py-8 text-center text-sm text-muted-foreground">{empty}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                <th className="min-w-[180px] py-2.5 pl-0 pr-3">
                  <SortButton label="Источник" active={filters.sort === 'source'} order={filters.order} onClick={() => toggleSort('source')} align="left" />
                </th>
                <th className="min-w-[240px] px-3 py-2.5">Упоминание</th>
                <th className="w-[104px] px-3 py-2.5 text-right">
                  <SortButton label="Просмотры" active={filters.sort === 'views'} order={filters.order} onClick={() => toggleSort('views')} align="right" />
                </th>
                <th className="w-[96px] px-3 py-2.5 text-right">
                  <SortButton label="Дата" active={filters.sort === 'date'} order={filters.order} onClick={() => toggleSort('date')} align="right" />
                </th>
                <th className="w-10 py-2.5 pl-3 pr-0 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, idx) => (
                <tr key={`${r.channel_id ?? ''}-${r.msg_id ?? idx}`} className="group transition-colors hover:bg-hover-row">
                  <td className="py-2.5 pl-0 pr-3 align-top">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">{r.title || 'Канал'}</span>
                      {r.username && <span className="truncate font-mono text-2xs text-muted-foreground">@{r.username}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    {r.snippet ? (
                      <span className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{r.snippet}</span>
                    ) : (
                      <span className="text-sm italic text-muted-foreground/60">Без текста</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right align-top font-medium tabular-nums text-foreground">
                    {r.views != null ? fmt.num(r.views) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right align-top text-xs tabular-nums text-muted-foreground">
                    {r.date ? fmt.date(r.date) : '—'}
                  </td>
                  <td className="py-2.5 pl-3 pr-0 text-right align-top">
                    {r.link ? (
                      <a
                        href={r.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Открыть в Telegram"
                        className="inline-flex size-7 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/10"
                        aria-label="Открыть упоминание в Telegram"
                      >
                        <Icon name="external" className="size-4" />
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalInPeriod >= 100 && (
            <p className="mt-2 text-2xs text-muted-foreground">Показаны последние 100 упоминаний за период.</p>
          )}
        </div>
      )}
    </div>
  );
}

function SortButton({
  label,
  active,
  order,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  order: 'asc' | 'desc';
  onClick: () => void;
  align: 'left' | 'right';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 tabular-nums transition-colors',
        align === 'right' && 'ml-auto',
        active ? 'text-primary' : 'hover:text-foreground',
      )}
    >
      {label}
      <span aria-hidden="true" className={cn('text-2xs', !active && 'text-ink3/60')}>
        {active ? (order === 'desc' ? '↓' : '↑') : '↕'}
      </span>
    </button>
  );
}

function MentionsDesktopSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between border-b border-border pb-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-2 gap-6 border-t border-border pt-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
