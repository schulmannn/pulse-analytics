import { describe, expect, it } from 'vitest';
import { normalizeTgPosts, stripTgMarkdown } from '@/lib/posts';

describe('normalizeTgPosts', () => {
  it('calculates engagement formulas and media links', () => {
    const [post] = normalizeTgPosts(
      [
        {
          id: 42,
          text: 'Primary caption',
          date: '2026-06-25T12:00:00.000Z',
          views: 200,
          reactions: 20,
          replies: 5,
          forwards: 10,
          media_type: 'photo',
          reactions_detail: [
            { emoji: '👍', count: 7 },
            { emoji: null, count: 99 },
          ],
          hashtags: ['Pulse'],
          album_size: 2,
          pinned: true,
        },
      ],
      { username: 'pulse', memberCount: 1_000 },
      { proxyThumbs: true },
    );

    expect(post).toMatchObject({
      id: 42,
      caption: 'Primary caption',
      reach: 200,
      likes: 20,
      comments: 5,
      shares: 10,
      eng: 35,
      thumb: '/api/tg/mtproto/thumb/42',
      permalink: 'https://t.me/pulse/42',
      hashtags: ['Pulse'],
      albumSize: 2,
      pinned: true,
    });
    expect(post?.erv).toBeCloseTo(17.5);
    expect(post?.virality).toBeCloseTo(5);
    expect(post?.er).toBeCloseTo(3.5);
    expect(post?.reactionsDetail).toEqual([{ emoji: '👍', count: 7 }]);
  });

  it('uses fallback fields for metrics, caption, channel and thumbnail', () => {
    const [post] = normalizeTgPosts(
      [
        {
          id: 7,
          caption: 'Fallback caption',
          view_count: 80,
          reactions_count: 8,
          comments_count: 4,
          forwards: 2,
          media_type: 'document',
          thumb: '/fallback.jpg',
        },
      ],
      { channel_username: 'fallback_channel', subscribers: 200 },
    );

    expect(post).toMatchObject({
      caption: 'Fallback caption',
      reach: 80,
      likes: 8,
      comments: 4,
      shares: 2,
      eng: 14,
      thumb: '/fallback.jpg',
      permalink: 'https://t.me/fallback_channel/7',
    });
    expect(post?.erv).toBeCloseTo(17.5);
    expect(post?.virality).toBeCloseTo(2.5);
    expect(post?.er).toBeCloseTo(7);
  });

  it('returns null reach-based ratios when reach is zero', () => {
    const [post] = normalizeTgPosts(
      [{ id: 1, views: 0, reactions: 3, forwards: 1 }],
      { members: 100 },
    );

    expect(post?.reach).toBe(0);
    expect(post?.eng).toBe(4);
    expect(post?.erv).toBeNull();
    expect(post?.virality).toBeNull();
    expect(post?.er).toBeCloseTo(4);
  });

  it('synthesizes the central proxy thumb only by explicit opt-in, but never overrides a raw thumb', () => {
    const [photo] = normalizeTgPosts(
      [{ id: 42, media_type: 'photo' }],
      {},
      { proxyThumbs: true },
    );
    expect(photo?.thumb).toBe('/api/tg/mtproto/thumb/42');
    // An explicit thumb always wins over the proxy — «prefer an explicit post thumb».
    const [withThumb] = normalizeTgPosts([{ id: 42, media_type: 'photo', thumb: '/real.jpg' }], {});
    expect(withThumb?.thumb).toBe('/real.jpg');
  });

  it('withholds the central-only proxy thumb when proxyThumbs=false (non-central source)', () => {
    // Non-central sources must NEVER get a possibly-wrong proxy cover — placeholder (null) instead.
    const [photo] = normalizeTgPosts([{ id: 42, media_type: 'photo' }], {}, { proxyThumbs: false });
    expect(photo?.thumb).toBeNull();
    const [video] = normalizeTgPosts([{ id: 7, media_type: 'video' }], {}, { proxyThumbs: false });
    expect(video?.thumb).toBeNull();
    // An explicit thumb still shows even with proxies off.
    const [explicit] = normalizeTgPosts(
      [{ id: 9, media_type: 'photo', thumb: '/real.jpg' }],
      {},
      { proxyThumbs: false },
    );
    expect(explicit?.thumb).toBe('/real.jpg');
  });

  it('defaults to no synthesized thumb when the caller has not established a central source', () => {
    const [photo] = normalizeTgPosts([{ id: 42, media_type: 'photo' }], {});
    expect(photo?.thumb).toBeNull();
  });

  it('strips raw Telegram markdown from the display caption', () => {
    const [post] = normalizeTgPosts(
      [{ id: 9, text: '[Хлопок и шалфей](https://notem.ru/products/1) — **новинка** уже __в магазине__' }],
      {},
    );
    expect(post?.caption).toBe('Хлопок и шалфей — новинка уже в магазине');
  });
});

describe('stripTgMarkdown', () => {
  it('unwraps links, keeping the text and dropping the url', () => {
    expect(stripTgMarkdown('[Хлопок и шалфей](https://notem.ru/x?utm=1)')).toBe('Хлопок и шалфей');
  });

  it('removes bold, underline and backtick markers but keeps the content', () => {
    expect(stripTgMarkdown('**Сегодня** __важно__ `код`')).toBe('Сегодня важно код');
  });

  it('drops orphan ** from unclosed markup and collapses doubled spaces', () => {
    expect(stripTgMarkdown('**Сегодня празднуем')).toBe('Сегодня празднуем');
    expect(stripTgMarkdown('a ** b  c')).toBe('a b c');
  });

  it('leaves single underscores/asterisks and newlines alone', () => {
    expect(stripTgMarkdown('media_product_type и *звёздочка')).toBe('media_product_type и *звёздочка');
    expect(stripTgMarkdown('строка один\nстрока два')).toBe('строка один\nстрока два');
  });

  it('handles empty input', () => {
    expect(stripTgMarkdown('')).toBe('');
  });
});
