import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import { useCampaignPosts, useIgTags } from '@/api/queries';
import type { CampaignPostInput } from '@/api/schemas';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { Section } from '@/components/instagram/shared';
import {
  TopPostsBlock,
  ReelsBlock,
  FormatsBlock,
  HashtagsBlock,
  CompareBlock,
  StoriesBlock,
  TagsBlock,
} from '@/components/instagram/content';
import { AddToCampaignDialog } from '@/components/campaigns/AddToCampaignDialog';
import { CampaignFilterControl } from '@/components/campaigns/CampaignFilterControl';
import { CampaignsView } from '@/components/campaigns/CampaignsView';
import { exportIgPosts } from '@/lib/igExport';
import { membershipKey, useCampaignFilter, useMembershipSet } from '@/lib/campaignFilter';
import { useSelectedChannel } from '@/lib/channel-context';
import { fmt } from '@/lib/format';
import { postInteractionsByFormat } from '@/lib/igMetrics';
import { cn } from '@/lib/utils';

/** IG Контент — everything publication-level: top posts, Reels, formats, hashtags, compare, stories.
    Плюс вкладка «Кампании» (?view=campaigns — общий per-user список, как в TG «Контенте») и
    канонический фильтр кампании (?campaign=), применяемый к публикационным блокам. */
export function IgContent({ ig }: { ig: IgData }) {
  const tags = useIgTags();
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

  const { channelId } = useSelectedChannel();
  const { campaignId } = useCampaignFilter();
  const campaignPostsQ = useCampaignPosts(campaignId);
  const memberSet = useMembershipSet(campaignPostsQ.data?.posts);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Снимок выбора при открытии диалога: onDone чистит selection, а диалог должен дожить
  // до экрана результата (см. одноимённый паттерн в Posts.tsx).
  const [addItems, setAddItems] = useState<CampaignPostInput[] | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setAddItems(null);
  }, [channelId, campaignId, ig.window.since, ig.window.until]);

  const tabs = (
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
  );

  if (view === 'campaigns') {
    return (
      <div className="space-y-6">
        {tabs}
        <CampaignsView />
      </div>
    );
  }

  // Фильтр кампании применяется к публикационным блокам (список постов и его производные);
  // Stories/Отметки — не пост-список и остаются на окне периода.
  const posts =
    campaignId != null && channelId != null
      ? ig.postsInWindow.filter((p) => p.id && memberSet.has(membershipKey('ig', channelId, p.id)))
      : ig.postsInWindow;

  const formatItems = campaignId == null ? ig.formatItems : postInteractionsByFormat(posts);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ig-метаданные (дата/формат/подпись) едут в membership с клиента: в БД их нет,
  // live Graph-листинг — единственный их источник (сервер клампит и валидирует).
  const selectedItems: CampaignPostInput[] =
    channelId == null
      ? []
      : posts
          .filter((p) => p.id && selected.has(p.id))
          .map((p) => ({
            network: 'ig' as const,
            channel_id: channelId,
            post_ref: p.id!,
            published_at: p.timestamp ?? undefined,
            media_type: (p.media_product_type === 'REELS' ? 'REELS' : p.media_type) ?? undefined,
            caption: p.caption ? p.caption.slice(0, 300) : undefined,
          }));

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {tabs}
        <div className="flex flex-wrap items-center gap-3">
          <CampaignFilterControl />
          {campaignId != null && campaignPostsQ.data && (
            <span className="text-2xs text-muted-foreground">
              {fmt.num(posts.length)} из {fmt.num(campaignPostsQ.data.posts.length)} публ. кампании — из этого источника
            </span>
          )}
          {selected.size > 0 && (
            <>
              <span className="text-xs tabular-nums text-muted-foreground">Выбрано: {fmt.num(selected.size)}</span>
              <button
                type="button"
                onClick={() => setAddItems(selectedItems)}
                className="btn-pill bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                data-testid="add-to-campaign"
              >
                Добавить в кампанию
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="btn-pill px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Снять выбор
              </button>
            </>
          )}
        </div>
      </div>

      {/* «Лучшие публикации» LEAD the section — the hero of the content view. The niche
          «Отметки на фото» moved to the tail (аудит: на реальном аккаунте без отметок первый
          экран раздела занимала пустая заглушка). */}
      <WidgetGroup id="ig-content-top" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection
          id="ig-top-posts-full"
          title="Лучшие публикации"
          defaultSize="full"
          noExpand
          action={
            <button
              type="button"
              onClick={() => exportIgPosts(posts)}
              className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Экспорт постов
            </button>
          }
        >
          <TopPostsBlock posts={posts} selection={{ selected, onToggle: toggleSelect }} />
        </ChartSection>
      </WidgetGroup>

      <Section title="Reels: удержание и просмотры">
        <ReelsBlock posts={posts} />
      </Section>

      {/* Свой ChartSection-виджет (карусель типов, pie, expand) — без двойного заголовка. */}
      <FormatsBlock items={formatItems} />

      <WidgetGroup id="ig-content-insights" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection id="ig-hashtags" title="Эффективность хэштегов" defaultSize="full" noExpand>
          <HashtagsBlock posts={posts} />
        </ChartSection>
        <ChartSection id="ig-post-compare" title="Сравнение публикаций" defaultSize="full" noExpand>
          <CompareBlock posts={posts} />
        </ChartSection>
      </WidgetGroup>

      <Section title="Stories за 24 часа">
        <StoriesBlock stories={ig.stories} />
      </Section>

      <WidgetGroup id="ig-content-tags" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection id="ig-tags" title="Отметки на фото" defaultSize="full" noExpand>
          <TagsBlock tags={tags.data?.data ?? []} mock={tags.data?.mock} />
        </ChartSection>
      </WidgetGroup>

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
