import { useEffect, useState, type ReactNode } from 'react';
import type { IgData } from '@/lib/useIgData';
import type { CampaignPostInput } from '@/api/schemas';
import { useIgTags } from '@/api/queries';
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
import { exportIgPosts } from '@/lib/igExport';
import { fmt } from '@/lib/format';
import { useIgScopedPosts, toCampaignItems } from '@/panels/instagram/igContentScope';

// ─────────────────────────────────────────────────────────────────────────────
// Mobile — the pre-redesign stacked block layout, preserved (task 6: no rewrite)
// ─────────────────────────────────────────────────────────────────────────────

export function IgContentMobile({ ig, tabs }: { ig: IgData; tabs: ReactNode }) {
  const tags = useIgTags();
  const { channelId, campaignId, campaignPostsQ, posts, formatItems } = useIgScopedPosts(ig);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addItems, setAddItems] = useState<CampaignPostInput[] | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setAddItems(null);
  }, [channelId, campaignId, ig.window.since, ig.window.until]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedItems = toCampaignItems(posts, channelId, selected);

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
        <AddToCampaignDialog items={addItems} onClose={() => setAddItems(null)} onDone={() => setSelected(new Set())} />
      )}
    </div>
  );
}
