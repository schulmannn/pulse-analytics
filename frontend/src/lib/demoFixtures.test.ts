import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { demoFixture } from '@/lib/demoFixtures';
import {
  ChannelsResponseSchema,
  CollectorStatusResponseSchema,
  GraphsSchema,
  HistorySchema,
  IgBreakdownsSchema,
  IgHistorySchema,
  IgInsightsSchema,
  IgOnlineSchema,
  IgPostsSchema,
  IgProfileSchema,
  IgStoriesSchema,
  IgTagsSchema,
  KeySchema,
  MentionSettingsSchema,
  MentionsSchema,
  PostStatsSchema,
  StatsSchema,
  TgFullSchema,
  VelocitySchema,
} from '@/api/schemas';

const KeysResponseSchema = z.object({ keys: z.array(KeySchema) }).passthrough();
// Локальное зеркало IgOauthStatusSchema (в api/queries.ts она не экспортирована — тянуть её сюда
// значит тянуть React Query в юнит-тест фикстур).
const IgOauthStatusMirror = z
  .object({
    server_ready: z.boolean(),
    env_fallback: z.boolean(),
    connected: z.boolean(),
    channel_id: z.number().nullable(),
    username: z.string().nullable(),
    ig_user_id: z.string().nullable(),
    connected_at: z.string().nullable(),
    token_expires_at: z.string().nullable(),
  })
  .passthrough();

// Every covered demo path must parse cleanly through the exact schema the API client validates it
// with — otherwise a panel would blank out in demo mode.
const CASES: Array<[string, z.ZodTypeAny]> = [
  ['/api/channels', ChannelsResponseSchema],
  ['/api/tg/full?limit=40', TgFullSchema],
  ['/api/history/channel?days=730', HistorySchema],
  ['/api/history/mentions', MentionsSchema],
  ['/api/tg/mtproto/mentions', MentionsSchema],
  ['/api/tg/mention-settings', MentionSettingsSchema],
  ['/api/tg/mtproto/stats', StatsSchema],
  ['/api/tg/mtproto/graphs', GraphsSchema],
  ['/api/tg/mtproto/velocity', VelocitySchema],
  ['/api/tg/mtproto/post_stats/2001', PostStatsSchema],
  ['/api/channels/0/collector-status', CollectorStatusResponseSchema],
  ['/api/channels/0/keys', KeysResponseSchema],
  // Instagram: у публичного демо нет серверной сессии, серверный ig_mock за requireAuth
  // недостижим — весь IG-неймспейс обязан резолвиться клиентски (см. demoIgFixtures.ts).
  ['/api/ig/profile', IgProfileSchema],
  ['/api/ig/insights?days=30', IgInsightsSchema],
  ['/api/ig/posts?limit=24', IgPostsSchema],
  ['/api/ig/breakdowns?timeframe=last_30_days', IgBreakdownsSchema],
  ['/api/ig/online', IgOnlineSchema],
  ['/api/ig/stories', IgStoriesSchema],
  ['/api/ig/tags', IgTagsSchema],
  ['/api/ig/history?days=400', IgHistorySchema],
  ['/api/ig/oauth/status', IgOauthStatusMirror],
];

describe('demo fixtures', () => {
  // await: IG-ветка demoFixture отвечает промисом (ленивый чанк), TG-пути — синхронно; await
  // прозрачен для обоих — ровно как в apiGet.
  it.each(CASES)('fixture for %s parses through its schema', async (path, schema) => {
    const fixture = await demoFixture(path);
    expect(fixture).toBeDefined();
    expect(() => schema.parse(fixture)).not.toThrow();
  });

  it('lets uncovered paths (auth, media proxy) fall through to the server', async () => {
    expect(demoFixture('/api/auth/me')).toBeUndefined();
    // Подписанный превью-прокси грузится через <img>, а не apiGet — фикстура ему не нужна.
    expect(await demoFixture('/api/ig/thumb?t=token')).toBeUndefined();
  });

  it('serves an Instagram cluster the IG shell can render without a server session', async () => {
    const insights = IgInsightsSchema.parse(await demoFixture('/api/ig/insights?days=30'));
    const names = insights.data.map((m) => m.name);
    for (const required of ['reach', 'views', 'follower_count', 'total_interactions', 'likes', 'saves']) {
      expect(names).toContain(required);
    }
    // Серия всегда 90-дневная (зеркало реального dailyCall): у окон 7д/30д есть полный
    // предыдущий период для дельт, независимо от параметра days.
    const reach = insights.data.find((m) => m.name === 'reach');
    expect(reach?.values).toHaveLength(90);

    const posts = IgPostsSchema.parse(await demoFixture('/api/ig/posts?limit=24'));
    expect(posts.data.length).toBeGreaterThan(5);
    // CSV-слаг экспорта и source-identity закреплены за демо-брендом воркспейса.
    const profile = IgProfileSchema.parse(await demoFixture('/api/ig/profile'));
    expect(profile.username).toBe('demo_channel');
    const breakdowns = IgBreakdownsSchema.parse(await demoFixture('/api/ig/breakdowns?timeframe=last_30_days'));
    expect(breakdowns.data.length).toBeGreaterThan(0);
  });

  it('serves a single demo channel so the dashboard has a workspace', () => {
    const parsed = ChannelsResponseSchema.parse(demoFixture('/api/channels'));
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0].title).toBe('Демо-канал');
  });

  it('provides posts and a subscriber history the overview can render', () => {
    const full = TgFullSchema.parse(demoFixture('/api/tg/full'));
    expect(full.posts.length).toBeGreaterThan(5);
    const history = HistorySchema.parse(demoFixture('/api/history/channel'));
    // Архив подписчиков глубже годового ряда просмотров (см. buildHistory): демо обязано
    // показывать честную пустоту графика постов там, где уровень подписчиков ещё известен.
    // Глубина с запасом: окно «13 месяцев назад, 5–15 число» отстоит от сегодня на 395…426 дней
    // (зависит от сегодняшнего числа), и ровно 420 переставало покрывать его в конце длинного
    // месяца — спек tg-top-posts падал по календарю, а не по правке.
    expect(history.rows.length).toBe(480);
    expect(history.rows.length, 'окно 13 месяцев назад обязано попадать в архив').toBeGreaterThan(430);
    // subscribers should be monotonic-ish upward (a believable growth story)
    const first = Number(history.rows[0].subscribers);
    const last = Number(history.rows[history.rows.length - 1].subscribers);
    expect(last).toBeGreaterThan(first);
  });
});
