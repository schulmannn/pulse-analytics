import { describe, expect, it } from 'vitest';
import { CampaignPostsResponseSchema, CampaignSchema, CampaignsResponseSchema } from '@/api/schemas';
import { buildMembershipSet, isSourceMember, membershipKey, parseCampaignParam } from '@/lib/campaignFilter';

describe('parseCampaignParam', () => {
  it('валидный числовой id парсится', () => {
    expect(parseCampaignParam('5')).toBe(5);
    expect(parseCampaignParam('123456789')).toBe(123456789);
  });
  it('мусор/пусто/отрицательное/переполнение → null (безопасный сброс)', () => {
    expect(parseCampaignParam(null)).toBeNull();
    expect(parseCampaignParam('')).toBeNull();
    expect(parseCampaignParam('abc')).toBeNull();
    expect(parseCampaignParam('-5')).toBeNull();
    expect(parseCampaignParam('5.5')).toBeNull();
    expect(parseCampaignParam('0')).toBeNull();
    expect(parseCampaignParam('1234567890')).toBeNull(); // >9 цифр — за пределами int4-роутов
  });
});

describe('membership set', () => {
  it('ключ = network:channel:post_ref — та же тройка, что PK membership', () => {
    expect(membershipKey('tg', 7, '101')).toBe('tg:7:101');
    expect(membershipKey('ig', 3, 'media_abc')).toBe('ig:3:media_abc');
  });
  it('set строится из campaign-posts и различает сети/каналы', () => {
    const set = buildMembershipSet([
      { network: 'tg', channel_id: 7, post_ref: '101' },
      { network: 'ig', channel_id: 7, post_ref: '101' },
      { network: 'tg', channel_id: 8, post_ref: '101' },
    ]);
    expect(set.size).toBe(3);
    expect(set.has(membershipKey('tg', 7, '101'))).toBe(true);
    expect(set.has(membershipKey('tg', 9, '101'))).toBe(false);
  });
});

describe('isSourceMember — source-exact membership (tg analytics «Форматы»)', () => {
  const set = buildMembershipSet([
    { network: 'tg', channel_id: 7, post_ref: '101' },
    { network: 'tg', channel_id: 7, post_ref: '102' },
    { network: 'ig', channel_id: 7, post_ref: '101' },
    { network: 'tg', channel_id: 8, post_ref: '101' },
  ]);

  it('matches a post from the exact (tg, channel) source (number or string ref)', () => {
    expect(isSourceMember(set, 'tg', 7, 101)).toBe(true);
    expect(isSourceMember(set, 'tg', 7, '102')).toBe(true);
    expect(isSourceMember(set, 'tg', 8, 101)).toBe(true);
  });

  it('never mixes another channel or Instagram membership into a TG source', () => {
    // Same post_ref on a different channel — not a member of channel 7's source.
    expect(isSourceMember(set, 'tg', 9, 101)).toBe(false);
    // A ref only present as an IG membership must not satisfy a TG query.
    const igOnly = buildMembershipSet([{ network: 'ig', channel_id: 7, post_ref: '101' }]);
    expect(isSourceMember(igOnly, 'tg', 7, 101)).toBe(false);
    // A post not in the campaign at all.
    expect(isSourceMember(set, 'tg', 7, 999)).toBe(false);
  });

  it('a null channel or post id never matches (unresolved source)', () => {
    expect(isSourceMember(set, 'tg', null, 101)).toBe(false);
    expect(isSourceMember(set, 'tg', 7, null)).toBe(false);
    expect(isSourceMember(set, 'tg', 7, undefined)).toBe(false);
  });
});

describe('campaign zod-схемы (пример реального ответа сервера)', () => {
  it('CampaignsResponseSchema переваривает строку списка с my_role/post_count', () => {
    const parsed = CampaignsResponseSchema.parse({
      campaigns: [
        {
          id: '5',
          workspace_id: 2,
          name: 'Запуск',
          description: '',
          color: null,
          status: 'active',
          start_date: '2026-06-10',
          end_date: null,
          created_by: 11,
          created_at: '2026-06-10T10:00:00+00',
          updated_at: '2026-06-12T10:00:00+00',
          my_role: 'owner',
          post_count: '4',
        },
      ],
    });
    expect(parsed.campaigns[0]!.id).toBe(5);
    expect(parsed.campaigns[0]!.post_count).toBe(4);
  });

  it('CampaignPostsResponseSchema: обе платформы + заглушка недоступного источника', () => {
    const parsed = CampaignPostsResponseSchema.parse({
      posts: [
        {
          network: 'tg', channel_id: 7, post_ref: '101', published_at: '2026-06-10T10:00:00+00',
          media_type: 'photo', caption: 'x', added_at: null, channel_title: 'TG A',
          channel_username: 'tga', accessible: true, tg_views: '1000', tg_reactions: 10,
        },
        {
          network: 'ig', channel_id: 9, post_ref: 'm1', published_at: null, media_type: null,
          caption: null, channel_title: null, accessible: false,
        },
      ],
    });
    expect(parsed.posts[0]!.tg_views).toBe(1000);
    expect(parsed.posts[1]!.accessible).toBe(false);
  });

  it('CampaignSchema: неизвестные поля проходят (passthrough — прод-данные не роняют парс)', () => {
    const c = CampaignSchema.parse({ id: 1, workspace_id: 2, name: 'x', status: 'active', future_field: 42 });
    expect((c as Record<string, unknown>).future_field).toBe(42);
  });
});
