import type { IgData } from '@/lib/useIgData';
import { useIgTags } from '@/api/queries';
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
      <Section title="Отметки на фото">
        <TagsBlock tags={tags.data?.data ?? []} mock={tags.data?.mock} />
      </Section>

      <Section
        title="Лучшие публикации"
        action={
          <button
            type="button"
            onClick={() => exportIgPosts(ig.posts)}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Экспорт постов
          </button>
        }
      >
        <TopPostsBlock posts={ig.posts} />
      </Section>

      <Section title="Reels: удержание и просмотры">
        <ReelsBlock posts={ig.posts} />
      </Section>

      <Section title="Вовлечённость по форматам">
        <FormatsBlock items={ig.formatItems} />
      </Section>

      <Section title="Эффективность хэштегов">
        <HashtagsBlock posts={ig.posts} />
      </Section>

      <Section title="Сравнение публикаций">
        <CompareBlock posts={ig.posts} />
      </Section>

      <Section title="Stories за 24 часа">
        <StoriesBlock stories={ig.stories} />
      </Section>
    </div>
  );
}
