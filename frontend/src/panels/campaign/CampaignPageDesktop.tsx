import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BarChart } from '@/components/BarChart';
import { ChartSection } from '@/components/ChartWidget';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/nav-icons';
import { LineChart } from '@/components/LineChart';
import { PieChart } from '@/components/PieChart';
import {
  CampaignColorDot,
  CampaignStatusChip,
  NetworkBadge,
  campaignPeriodLabel,
} from '@/components/campaigns/shared';
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
  applyTimelineMode,
  resolveTimelineMode,
  scopeNote,
  sourceLeaderboard,
  type SourceLeaderRow,
  timelineModes,
} from '@/lib/campaignPageModel';
import { campaignSourceKey } from '@/lib/campaignSources';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { CampaignPostsTable } from '@/panels/campaign/CampaignPostsTable';
import type { CampaignViewProps } from '@/panels/campaign/campaignView';

/**
 * Desktop-страница кампании (md+): Steep-подобная рабочая поверхность, читающаяся сверху вниз
 * тремя вопросами — «Итоги» (что достигли), «Как развивалось» (ОДИН full-width таймлайн-эксплорер
 * с сегментным переключателем режима), «Что дало результат» (источники и форматы 50/50 + крайние
 * посты строкой). Методологии платформ разведены: просмотры TG и сумма охватов IG — это разные
 * РЕЖИМЫ одного графика, никогда не одна серия. Источник — on-page select (?source=). Мобильная
 * верстка — отдельная ветка оркестратора.
 */
export function CampaignPageDesktop(props: CampaignViewProps) {
  const { summary, baseSummary, posts, postsQ, canEdit, selectedSource, onRemovePost, onRemovePosts, removePending } =
    props;

  const kpis = useMemo(() => platformKpis(summary), [summary]);
  const series = useMemo(() => timelineSeries(summary.timeline), [summary.timeline]);
  const slices = useMemo(() => formatSlices(summary.by_format), [summary.by_format]);
  const extremes = useMemo(() => campaignExtremes(summary), [summary]);
  const leaders = useMemo(() => sourceLeaderboard(summary.by_source), [summary.by_source]);
  const cmpText = comparisonText(summary);
  const cmpMissing = comparisonUnavailableText(summary);

  return (
    <div className="space-y-8">
      <CampaignHeader {...props} note={scopeNote(summary, baseSummary?.posts_total ?? summary.posts_total, !!selectedSource)} />

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
          {/* ── Q1. Итоги: что кампания достигла (платформы раздельно, методологии подписаны) ── */}
          {(kpis.tg.length > 0 || kpis.ig.length > 0) && (
            <section className="space-y-4">
              <SectionLabel>Итоги кампании</SectionLabel>
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
                          <div className="text-2xs font-medium text-muted-foreground">{t.label}</div>
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
            </section>
          )}

          {/* ── Q2. Как развивалось: ОДИН full-width таймлайн-эксплорер. Режимы (TG-просмотры / ── */}
          {/* ── IG-охват / публикации) переключаются сегментными кнопками — серии несовместимых ── */}
          {/* ── методологий никогда не рисуются вместе. ── */}
          <section className="space-y-3">
            <SectionLabel>Как развивалось</SectionLabel>
            <TimelineExplorer series={series} />
          </section>

          {/* ── Q3. Что дало результат: источники и форматы — 50/50, затем крайние посты строкой ── */}
          <section className="space-y-3">
            <SectionLabel>Что дало результат</SectionLabel>
            <WidgetGroup id="campaign-drivers-desktop" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
              <ChartSection id="campaign-sources" title="Источники · вклад внутри своей платформы" fixedSize="half" noExpand>
                <SourceLeaderboard leaders={leaders} />
              </ChartSection>
              <ChartSection id="campaign-formats" title="Форматы · по числу публикаций" fixedSize="half" noExpand>
                {slices.values.length > 0 ? (
                  <PieChart values={slices.values} labels={slices.labels} titles={slices.titles} />
                ) : (
                  <EmptyState compact title="Нет данных о форматах." />
                )}
              </ChartSection>
            </WidgetGroup>
            <ExtremesStrip extremes={extremes} />
          </section>

          {/* ── Детальный дрилл: интерактивная таблица (поиск/сортировка/выбор/групповое удаление) ── */}
          <CampaignPostsTable
            posts={posts}
            postsQ={postsQ}
            canEdit={canEdit}
            onRemovePost={onRemovePost}
            onRemovePosts={onRemovePosts}
            removePending={removePending}
            interactive
          />
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium text-foreground">{children}</h3>;
}

/**
 * Один full-width график динамики с компактным сегментным переключателем режима. Доступны только
 * режимы, у которых есть данные (TG-просмотры / IG-охват), плюс «Публикации» всегда. Переключение
 * подменяет серию — TG и IG никогда не совмещаются в одной серии.
 */
function TimelineExplorer({ series }: { series: ReturnType<typeof timelineSeries> }) {
  const modes = useMemo(() => timelineModes(series), [series]);
  const [searchParams, setSearchParams] = useSearchParams();
  const rawMode = searchParams.get('metric');
  const defaultMode = modes[0]?.key ?? null;
  const activeKey = resolveTimelineMode(rawMode, modes);
  const active = modes.find((mode) => mode.key === activeKey);

  useEffect(() => {
    if (!rawMode) return;
    if (rawMode === activeKey) return;
    setSearchParams(applyTimelineMode(searchParams, activeKey, defaultMode), { replace: true });
  }, [activeKey, defaultMode, rawMode, searchParams, setSearchParams]);

  if (!active) {
    return (
      <WidgetGroup id="campaign-timeline-desktop" className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection id="campaign-timeline" title="Динамика кампании" fixedSize="full" noExpand>
          <EmptyState compact title="Нет данных для графика динамики." />
        </ChartSection>
      </WidgetGroup>
    );
  }

  const segmented =
    modes.length > 1 ? (
      <div className="inline-flex items-center gap-1 rounded-full border border-border p-0.5" role="group" aria-label="Режим графика">
        {modes.map((m) => {
          const on = m.key === active.key;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setSearchParams(applyTimelineMode(searchParams, m.key, defaultMode), { replace: true });
              }}
              data-testid={`campaign-timeline-mode-${m.key}`}
              className={cn(
                'rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
                on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m.label}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <WidgetGroup id="campaign-timeline-desktop" className="grid grid-cols-1 gap-6">
      <ChartSection id="campaign-timeline" title={active.title} action={segmented} fixedSize="full" noExpand>
        {active.kind === 'line' ? (
          <LineChart values={active.values} labels={active.labels} titles={active.titles} showPoints fullAxes />
        ) : (
          <BarChart values={active.values} labels={active.labels} titles={active.titles} />
        )}
      </ChartSection>
    </WidgetGroup>
  );
}

/** Шапка: компактный возврат к списку, имя/статус/период, описание и on-page фильтр источника. */
function CampaignHeader({
  campaign,
  summary,
  canEdit,
  isArchived,
  sourceOptions,
  selectedSource,
  onSelectSource,
  onEdit,
  onToggleArchive,
  onDelete,
  archivePending,
  deletePending,
  note,
}: CampaignViewProps & { note: string }) {
  return (
    <div className="space-y-3">
      <Link
        to="/posts?view=campaigns"
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="chevron" className="size-3.5 rotate-90" />
        Кампании
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        {campaign.color ? <CampaignColorDot color={campaign.color} className="size-3" /> : null}
        <h2 className="text-2xl font-medium text-foreground" data-testid="campaign-name">
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
              onClick={onEdit}
              className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Изменить
            </button>
            <button
              type="button"
              onClick={onToggleArchive}
              disabled={archivePending}
              className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              data-testid="campaign-archive-toggle"
            >
              {archivePending ? '…' : isArchived ? 'Вернуть из архива' : 'В архив'}
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deletePending}
              className="btn-pill px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              {deletePending ? 'Удаление…' : 'Удалить'}
            </button>
          </div>
        )}
      </div>
      {campaign.description ? <p className="max-w-2xl text-sm text-muted-foreground">{campaign.description}</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {sourceOptions.length > 0 && (
          <label className="inline-flex w-fit items-center gap-2 text-xs text-muted-foreground">
            <span>Источник</span>
            <select
              value={selectedSource ? campaignSourceKey(selectedSource) : ''}
              onChange={(event) => onSelectSource(event.target.value)}
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
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      {summary.inaccessible_posts > 0 && (
        <p className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {fmt.num(summary.inaccessible_posts)} публ. из источников, недоступных вам, — они не входят в метрики ниже.
        </p>
      )}
    </div>
  );
}

/** Ранжированный список источников: порядок по публикациям, полоска — доля внутри своей платформы. */
function SourceLeaderboard({ leaders }: { leaders: SourceLeaderRow[] }) {
  if (leaders.length === 0) return <EmptyState compact title="Нет источников." />;
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {leaders.map((s) => (
        <div key={s.key} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
          <div className="flex items-center gap-2">
            <NetworkBadge network={s.network} />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{s.label}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{fmt.num(s.posts)} публ.</span>
            <span className="w-16 text-right text-xs font-medium tabular-nums text-foreground">{s.metricText}</span>
          </div>
          {s.share != null && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/60"
                  style={{ width: `${Math.max(2, Math.round(s.share * 100))}%` }}
                />
              </div>
              <span className="w-9 text-right text-2xs tabular-nums text-muted-foreground">
                {Math.round(s.share * 100)}%
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Крайние посты — по коэффициенту к медиане СВОЕЙ платформы (не сырому значению). Не карточка-виджет,
 * а лёгкая строка под драйверами: две колонки лучший/худший, разделённые тонкой линией.
 */
function ExtremesStrip({ extremes }: { extremes: ReturnType<typeof campaignExtremes> }) {
  if (!extremes.best && !extremes.worst) return null;
  return (
    <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2" data-testid="campaign-extremes">
      {([
        ['Лучший пост', extremes.best, 'text-verdant'] as const,
        ['Слабейший пост', extremes.worst, 'text-ember'] as const,
      ]).map(([label, post, tone]) =>
        post ? (
          <div key={label} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-2xs font-medium text-muted-foreground">{label}</div>
              <div className="mt-0.5 flex items-center gap-2">
                <NetworkBadge network={post.network ?? 'tg'} />
                <span className="min-w-0 truncate text-sm text-foreground">
                  {post.caption ? markdownToPlainText(post.caption) : `Публикация ${post.post_ref}`}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium tabular-nums text-foreground">{fmt.short(Number(post.value ?? 0))}</div>
              <div className={cn('text-2xs', tone)}>{ratioLabel(post.ratio) ?? ''}</div>
            </div>
          </div>
        ) : (
          <div key={label} />
        ),
      )}
    </div>
  );
}
