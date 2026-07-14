import type { CampaignPost, CampaignSummary } from '@/api/schemas';

export interface CampaignSourceScope {
  network: 'tg' | 'ig';
  channelId: number;
}

export interface CampaignSourceOption {
  key: string;
  label: string;
  posts: number;
  source: CampaignSourceScope;
}

type SourceRow = CampaignSummary['by_source'][number];

export function campaignSourceKey(source: CampaignSourceScope): string {
  return `${source.network}:${source.channelId}`;
}

export function parseCampaignSourceKey(value: string | null): CampaignSourceScope | null {
  if (!value) return null;
  const match = /^(tg|ig):([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const channelId = Number(match[2]);
  if (!Number.isSafeInteger(channelId) || channelId > 999_999_999) return null;
  return { network: match[1] as 'tg' | 'ig', channelId };
}

export function campaignSourceOptions(rows: SourceRow[]): CampaignSourceOption[] {
  const seen = new Set<string>();
  const options: CampaignSourceOption[] = [];
  for (const row of rows) {
    const source = { network: row.network, channelId: row.channel_id } satisfies CampaignSourceScope;
    const key = campaignSourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    const rawName = row.username || row.title || `#${row.channel_id}`;
    const name = row.username && !rawName.startsWith('@') ? `@${rawName}` : rawName;
    options.push({
      key,
      source,
      posts: row.posts,
      label: `${row.network === 'tg' ? 'Telegram' : 'Instagram'} ${name}`,
    });
  }
  return options;
}

export function filterCampaignPosts(posts: CampaignPost[], source: CampaignSourceScope | null): CampaignPost[] {
  if (!source) return posts;
  return posts.filter((post) => post.network === source.network && post.channel_id === source.channelId);
}
