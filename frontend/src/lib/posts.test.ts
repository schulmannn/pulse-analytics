import { describe, expect, it } from 'vitest';
import { normalizeTgPosts } from '@/lib/posts';

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
});
