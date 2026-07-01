import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { demoFixture } from '@/lib/demoFixtures';
import {
  ChannelsResponseSchema,
  CollectorStatusResponseSchema,
  GraphsSchema,
  HistorySchema,
  KeySchema,
  MentionsSchema,
  PostStatsSchema,
  StatsSchema,
  TgFullSchema,
  VelocitySchema,
} from '@/api/schemas';

const KeysResponseSchema = z.object({ keys: z.array(KeySchema) }).passthrough();

// Every covered demo path must parse cleanly through the exact schema the API client validates it
// with — otherwise a panel would blank out in demo mode.
const CASES: Array<[string, z.ZodTypeAny]> = [
  ['/api/channels', ChannelsResponseSchema],
  ['/api/tg/full?limit=40', TgFullSchema],
  ['/api/history/channel?days=730', HistorySchema],
  ['/api/history/mentions', MentionsSchema],
  ['/api/tg/mtproto/mentions', MentionsSchema],
  ['/api/tg/mtproto/stats', StatsSchema],
  ['/api/tg/mtproto/graphs', GraphsSchema],
  ['/api/tg/mtproto/velocity', VelocitySchema],
  ['/api/tg/mtproto/post_stats/2001', PostStatsSchema],
  ['/api/channels/0/collector-status', CollectorStatusResponseSchema],
  ['/api/channels/0/keys', KeysResponseSchema],
];

describe('demo fixtures', () => {
  it.each(CASES)('fixture for %s parses through its schema', (path, schema) => {
    const fixture = demoFixture(path);
    expect(fixture).toBeDefined();
    expect(() => schema.parse(fixture)).not.toThrow();
  });

  it('lets uncovered paths (Instagram, auth) fall through to the server', () => {
    expect(demoFixture('/api/ig/profile')).toBeUndefined();
    expect(demoFixture('/api/auth/me')).toBeUndefined();
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
    expect(history.rows.length).toBe(90);
    // subscribers should be monotonic-ish upward (a believable growth story)
    const first = Number(history.rows[0].subscribers);
    const last = Number(history.rows[history.rows.length - 1].subscribers);
    expect(last).toBeGreaterThan(first);
  });
});
