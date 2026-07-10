import type { IgData } from '@/lib/useIgData';
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
import { exportIgPosts } from '@/lib/igExport';

/** IG Контент — everything publication-level: top posts, Reels, formats, hashtags, compare, stories. */
export function IgContent({ ig }: { ig: IgData }) {
  const tags = useIgTags();
  return (
    <div className="space-y-10">
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
              onClick={() => exportIgPosts(ig.postsInWindow)}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              Экспорт постов
            </button>
          }
        >
          <TopPostsBlock posts={ig.postsInWindow} />
        </ChartSection>
      </WidgetGroup>

      <Section title="Reels: удержание и просмотры">
        <ReelsBlock posts={ig.postsInWindow} />
      </Section>

      {/* Свой ChartSection-виджет (карусель типов, pie, expand) — без двойного заголовка. */}
      <FormatsBlock items={ig.formatItems} />

      <WidgetGroup id="ig-content-insights" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection id="ig-hashtags" title="Эффективность хэштегов" defaultSize="full" noExpand>
          <HashtagsBlock posts={ig.postsInWindow} />
        </ChartSection>
        <ChartSection id="ig-post-compare" title="Сравнение публикаций" defaultSize="full" noExpand>
          <CompareBlock posts={ig.postsInWindow} />
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
    </div>
  );
}
