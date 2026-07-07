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
      {/* «Лучшие публикации» LEAD the section — the hero of the content view. The niche
          «Отметки на фото» moved to the tail (аудит: на реальном аккаунте без отметок первый
          экран раздела занимала пустая заглушка). */}
      <Section
        title="Лучшие публикации"
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
      </Section>

      <Section title="Reels: удержание и просмотры">
        <ReelsBlock posts={ig.postsInWindow} />
      </Section>

      {/* Свой ChartSection-виджет (карусель типов, pie, expand) — без двойного заголовка. */}
      <FormatsBlock items={ig.formatItems} />

      <Section title="Эффективность хэштегов">
        <HashtagsBlock posts={ig.postsInWindow} />
      </Section>

      <Section title="Сравнение публикаций">
        <CompareBlock posts={ig.postsInWindow} />
      </Section>

      <Section title="Stories за 24 часа">
        <StoriesBlock stories={ig.stories} />
      </Section>

      <Section title="Отметки на фото">
        <TagsBlock tags={tags.data?.data ?? []} mock={tags.data?.mock} />
      </Section>
    </div>
  );
}
