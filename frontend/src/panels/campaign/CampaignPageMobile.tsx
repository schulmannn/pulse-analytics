import { useMemo } from 'react';
import { BarChart } from '@/components/BarChart';
import { ChartSection } from '@/components/ChartWidget';
import { EmptyState } from '@/components/EmptyState';
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
import { campaignSourceKey } from '@/lib/campaignSources';
import { fmt } from '@/lib/format';
import { markdownToPlainText } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { CampaignPostsTable } from '@/panels/campaign/CampaignPostsTable';
import type { CampaignViewProps } from '@/panels/campaign/campaignView';

/**
 * Мобильная страница кампании — прежний вертикальный стек (сохранён как есть, вне рамок
 * desktop-редизайна). Данные и мутации приходят из оркестратора; здесь только презентация.
 */
export function CampaignPageMobile(props: CampaignViewProps) {
  const {
    campaign,
    summary,
    baseSummary,
    posts,
    postsQ,
    canEdit,
    isArchived,
    sourceOptions,
    selectedSource,
    onSelectSource,
    onEdit,
    onToggleArchive,
    onDelete,
    onRemovePost,
    archivePending,
    deletePending,
    removePending,
  } = props;

  const kpis = useMemo(() => platformKpis(summary), [summary]);
  const series = useMemo(() => timelineSeries(summary.timeline), [summary.timeline]);
  const slices = useMemo(() => formatSlices(summary.by_format), [summary.by_format]);
  const cmpText = comparisonText(summary);
  const cmpMissing = comparisonUnavailableText(summary);
  const extremes = useMemo(() => campaignExtremes(summary), [summary]);

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
          <CampaignPostsTable
            posts={posts}
            postsQ={postsQ}
            canEdit={canEdit}
            onRemovePost={onRemovePost}
            removePending={removePending}
          />
        </>
      )}
    </div>
  );
}
