import { describe, expect, it } from 'vitest';
import type { CampaignPost } from '@/api/schemas';
import type { TimelineSeries } from '@/lib/campaignSummary';
import {
  applyCampaignPostTableState,
  applyTimelineMode,
  filterPostsByQuery,
  parseCampaignPostTableState,
  postInteractions,
  postPrimaryResult,
  resolveTimelineMode,
  scopeNote,
  sortPosts,
  sourceLeaderboard,
  timelineModes,
} from '@/lib/campaignPageModel';

type Row = Parameters<typeof sourceLeaderboard>[0][number];

const rows: Row[] = [
  { network: 'tg', channel_id: 1, title: 'Канал А', username: 'a', posts: 5, tg_views: 3000 },
  { network: 'tg', channel_id: 2, title: 'Канал Б', username: 'b', posts: 2, tg_views: 1000 },
  { network: 'ig', channel_id: 9, title: 'IG-акк', username: 'ig', posts: 3, ig_reach: 800 },
  { network: 'ig', channel_id: 8, title: null, username: null, posts: 1, ig_reach: null },
];

describe('sourceLeaderboard', () => {
  it('порядок по числу публикаций (сравнимо между сетями)', () => {
    const board = sourceLeaderboard(rows);
    expect(board.map((r) => r.posts)).toEqual([5, 3, 2, 1]);
  });

  it('доля считается ТОЛЬКО внутри своей платформы — метрики сетей не смешиваются', () => {
    const board = sourceLeaderboard(rows);
    const tgA = board.find((r) => r.key === 'tg:1')!;
    const tgB = board.find((r) => r.key === 'tg:2')!;
    const ig = board.find((r) => r.key === 'ig:9')!;
    // TG-доли нормированы на сумму TG (4000), а не на TG+IG.
    expect(tgA.share).toBeCloseTo(0.75, 5);
    expect(tgB.share).toBeCloseTo(0.25, 5);
    // Единственный IG-источник с метрикой держит 100% охвата IG.
    expect(ig.share).toBeCloseTo(1, 5);
  });

  it('источник без своей метрики → share=null и «—», но остаётся в списке', () => {
    const board = sourceLeaderboard(rows);
    const bare = board.find((r) => r.key === 'ig:8')!;
    expect(bare.metric).toBeNull();
    expect(bare.share).toBeNull();
    expect(bare.metricText).toBe('—');
  });

  it('подпись источника: title → @username → «Канал #id»', () => {
    const board = sourceLeaderboard([
      { network: 'tg', channel_id: 1, title: 'Имя', posts: 1 } as Row,
      { network: 'tg', channel_id: 2, username: 'user', posts: 1 } as Row,
      { network: 'ig', channel_id: 3, posts: 1 } as Row,
    ]);
    expect(board.map((r) => r.label)).toEqual(['Имя', '@user', 'Канал #3']);
  });
});

describe('scopeNote', () => {
  it('без фильтра — просто число публикаций', () => {
    expect(scopeNote({ posts_total: 12, undated_posts: 0, period: undefined }, 12, false)).toBe('12 публ.');
  });
  it('под фильтром — «N из M», плюс без даты и период', () => {
    const note = scopeNote(
      { posts_total: 4, undated_posts: 2, period: { from: '2026-06-10', to: '2026-06-12' } },
      12,
      true,
    );
    expect(note).toBe('4 из 12 публ. · без даты: 2 · период данных: 2026-06-10 — 2026-06-12');
  });
});

const emptySeries: TimelineSeries = {
  labels: [],
  titles: [],
  posts: [],
  tgViews: [],
  igReach: [],
  tgPresent: [],
  igPresent: [],
  hasTg: false,
  hasIg: false,
};
const mkSeries = (over: Partial<TimelineSeries>): TimelineSeries => ({
  ...emptySeries,
  labels: ['01.06', '02.06'],
  titles: ['a', 'b'],
  posts: [1, 2],
  tgPresent: [true, true],
  igPresent: [true, true],
  ...over,
});

describe('timelineModes', () => {
  it('пустой таймлайн → без режимов', () => {
    expect(timelineModes(emptySeries)).toEqual([]);
  });

  it('только TG → режимы tg_views + posts (без ig_reach)', () => {
    const modes = timelineModes(mkSeries({ hasTg: true, tgViews: [10, 20] }));
    expect(modes.map((m) => m.key)).toEqual(['tg_views', 'posts']);
  });

  it('только IG → режимы ig_reach + posts (без tg_views)', () => {
    const modes = timelineModes(mkSeries({ hasIg: true, igReach: [5, 6] }));
    expect(modes.map((m) => m.key)).toEqual(['ig_reach', 'posts']);
  });

  it('смешанный TG+IG → три режима, серии не совмещаются', () => {
    const modes = timelineModes(mkSeries({
      hasTg: true,
      hasIg: true,
      tgViews: [10, 0],
      igReach: [0, 6],
      tgPresent: [true, false],
      igPresent: [false, true],
    }));
    expect(modes.map((m) => m.key)).toEqual(['tg_views', 'ig_reach', 'posts']);
    expect(modes.find((m) => m.key === 'tg_views')!.labels).toEqual(['01.06']);
    expect(modes.find((m) => m.key === 'tg_views')!.values).toEqual([10]);
    expect(modes.find((m) => m.key === 'ig_reach')!.labels).toEqual(['02.06']);
    expect(modes.find((m) => m.key === 'ig_reach')!.values).toEqual([6]);
    expect(modes.find((m) => m.key === 'posts')!.kind).toBe('bar');
    expect(modes.find((m) => m.key === 'tg_views')!.titles.join(' ')).toContain('просмотров TG');
    expect(modes.find((m) => m.key === 'tg_views')!.titles.join(' ')).not.toContain('IG');
    expect(modes.find((m) => m.key === 'ig_reach')!.titles.join(' ')).toContain('охвата IG');
    expect(modes.find((m) => m.key === 'ig_reach')!.titles.join(' ')).not.toContain('TG');
  });

  it('URL-режим восстанавливается только если он доступен, дефолт не сериализуется', () => {
    const modes = timelineModes(mkSeries({ hasTg: true, hasIg: true, tgViews: [10, 20], igReach: [5, 6] }));
    expect(resolveTimelineMode('ig_reach', modes)).toBe('ig_reach');
    expect(resolveTimelineMode('missing', modes)).toBe('tg_views');
    expect(resolveTimelineMode(null, modes)).toBe('tg_views');

    const current = new URLSearchParams('source=ig%3A2&q=reels&sort=interactions&order=asc');
    const selected = applyTimelineMode(current, 'ig_reach', 'tg_views');
    expect(selected.get('metric')).toBe('ig_reach');
    expect(selected.get('source')).toBe('ig:2');
    expect(selected.get('q')).toBe('reels');
    expect(selected.get('sort')).toBe('interactions');
    expect(selected.get('order')).toBe('asc');
    expect(applyTimelineMode(selected, 'tg_views', 'tg_views').has('metric')).toBe(false);
  });
});

const post = (over: Partial<CampaignPost>): CampaignPost =>
  ({ network: 'tg', channel_id: 1, post_ref: 'x', accessible: true, ...over }) as CampaignPost;

describe('filterPostsByQuery / sortPosts', () => {
  const posts = [
    post({ post_ref: '1', caption: 'Запуск продукта', channel_title: 'Канал А', published_at: '2026-06-01', tg_views: 100, tg_reactions: 5, tg_forwards: 2, tg_replies: 1 }),
    post({ post_ref: '2', caption: 'Промо акция', channel_username: 'promo', published_at: '2026-06-03', tg_views: 300, tg_reactions: 9, tg_forwards: 1, tg_replies: 2 }),
    post({ network: 'ig', post_ref: '3', caption: 'Reels запуск', published_at: '2026-06-02', ig_reach: 200, ig_likes: 40, ig_comments: 3, ig_saved: 4, ig_shares: 8 }),
  ];

  it('поиск без регистра по подписи / источнику / @username', () => {
    expect(filterPostsByQuery(posts, 'запуск').map((p) => p.post_ref)).toEqual(['1', '3']);
    expect(filterPostsByQuery(posts, 'канал а').map((p) => p.post_ref)).toEqual(['1']);
    expect(filterPostsByQuery(posts, 'promo').map((p) => p.post_ref)).toEqual(['2']);
    expect(filterPostsByQuery(posts, '').length).toBe(3);
  });

  it('сортировка по основному результату (tg_views | ig_reach)', () => {
    expect(sortPosts(posts, 'result', 'desc').map((p) => p.post_ref)).toEqual(['2', '3', '1']);
    expect(sortPosts(posts, 'result', 'asc').map((p) => p.post_ref)).toEqual(['1', '3', '2']);
  });

  it('сортировка по дате и сумме взаимодействий', () => {
    expect(sortPosts(posts, 'date', 'desc').map((p) => p.post_ref)).toEqual(['2', '3', '1']);
    expect(sortPosts(posts, 'interactions', 'desc').map((p) => p.post_ref)).toEqual(['3', '2', '1']);
  });

  it('null-метрика всегда в конце независимо от направления', () => {
    const withNull = [...posts, post({ post_ref: '4', caption: 'без метрик', published_at: '2026-06-04' })];
    expect(sortPosts(withNull, 'result', 'asc').at(-1)!.post_ref).toBe('4');
    expect(sortPosts(withNull, 'result', 'desc').at(-1)!.post_ref).toBe('4');
  });
});

describe('метрики строки публикации', () => {
  it('основной результат хранит разную методологию TG и IG в подписи', () => {
    expect(postPrimaryResult(post({ tg_views: 123 }))).toEqual({ value: 123, label: 'TG просмотры' });
    expect(postPrimaryResult(post({ network: 'ig', ig_reach: 456 }))).toEqual({
      value: 456,
      label: 'IG сумма охватов',
    });
  });

  it('взаимодействия суммируют все доступные компоненты сети, включая нули', () => {
    expect(postInteractions(post({ tg_reactions: 5, tg_forwards: 2, tg_replies: 3 })).value).toBe(10);
    expect(postInteractions(post({ network: 'ig', ig_likes: 7, ig_comments: 4, ig_saved: 2, ig_shares: 1 })).value).toBe(14);
    expect(postInteractions(post({ tg_reactions: 0, tg_forwards: 0, tg_replies: 0 })).value).toBe(0);
    expect(postInteractions(post({})).value).toBeNull();
  });

  it('недоступная публикация не раскрывает метрики', () => {
    const hidden = post({ accessible: false, tg_views: 100, tg_reactions: 5 });
    expect(postPrimaryResult(hidden).value).toBeNull();
    expect(postInteractions(hidden).value).toBeNull();
  });
});

describe('URL-состояние таблицы', () => {
  it('парсит допустимые значения и нормализует неизвестные', () => {
    expect(parseCampaignPostTableState(new URLSearchParams('q=reels&sort=result&order=asc'))).toEqual({
      q: 'reels',
      sort: 'result',
      order: 'asc',
    });
    expect(parseCampaignPostTableState(new URLSearchParams('sort=reach&order=sideways'))).toEqual({
      q: '',
      sort: 'date',
      order: 'desc',
    });
  });

  it('обновляет только свои параметры, сохраняет источник, режим графика и чужие параметры', () => {
    const current = new URLSearchParams('source=tg%3A1&metric=posts&tab=detail');
    const next = applyCampaignPostTableState(current, { q: '  запуск  ', sort: 'interactions', order: 'asc' });
    expect(next.get('source')).toBe('tg:1');
    expect(next.get('metric')).toBe('posts');
    expect(next.get('tab')).toBe('detail');
    expect(next.get('q')).toBe('  запуск  ');
    expect(next.get('sort')).toBe('interactions');
    expect(next.get('order')).toBe('asc');

    const defaults = applyCampaignPostTableState(next, { q: ' ', sort: 'date', order: 'desc' });
    expect(defaults.has('q')).toBe(false);
    expect(defaults.has('sort')).toBe(false);
    expect(defaults.has('order')).toBe(false);
    expect(defaults.get('source')).toBe('tg:1');
    expect(defaults.get('metric')).toBe('posts');
  });
});
