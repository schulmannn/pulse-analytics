import { z } from 'zod';

// Server payloads are loose and vary by source (Bot API / MTProto / collector snapshot),
// so schemas are intentionally permissive: optional + nullable + .passthrough(). Zod here
// SHAPES types and coerces a few fields — it must never throw on real production data and
// block a panel from rendering.

export const TgChannelSchema = z
  .object({
    title: z.string().optional(),
    username: z.string().optional(),
    description: z.string().optional(),
    memberCount: z.coerce.number().optional(),
    members: z.coerce.number().optional(),
    source: z.string().optional(),
  })
  .passthrough();

export const ViewsSummarySchema = z
  .object({
    total_views: z.coerce.number().optional(),
    total_reactions: z.coerce.number().optional(),
    total_forwards: z.coerce.number().optional(),
    total_replies: z.coerce.number().optional(),
    avg_views: z.coerce.number().optional(),
    posts_analyzed: z.coerce.number().optional(),
    views_by_day: z.record(z.string(), z.coerce.number()).optional(),
    avg_views_by_type: z.record(z.string(), z.coerce.number()).optional().nullable(),
  })
  .passthrough();

export const PostSchema = z
  .object({
    id: z.coerce.number().optional().nullable(),
    text: z.string().optional().nullable(),
    caption: z.string().optional().nullable(),
    date: z.string().optional().nullable(),
    views: z.coerce.number().optional().nullable(),
    view_count: z.coerce.number().optional().nullable(),
    reactions: z.coerce.number().optional().nullable(),
    reactions_count: z.coerce.number().optional().nullable(),
    replies: z.coerce.number().optional().nullable(),
    comments_count: z.coerce.number().optional().nullable(),
    forwards: z.coerce.number().optional().nullable(),
    media_type: z.string().optional().nullable(),
    thumb: z.string().optional().nullable(),
    reactions_detail: z
      .array(
        z
          .object({
            emoji: z.string().optional().nullable(),
            count: z.coerce.number().optional().nullable(),
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
    hashtags: z.array(z.string()).optional().nullable(),
    album_size: z.coerce.number().optional().nullable(),
    pinned: z.boolean().optional().nullable(),
  })
  .passthrough();
export type TgPost = z.infer<typeof PostSchema>;

export const TgFullSchema = z
  .object({
    channel: TgChannelSchema.optional().default({}),
    views_summary: ViewsSummarySchema.nullable().optional(),
    posts: z.array(PostSchema).optional().default([]),
    mtproto_available: z.boolean().optional().default(false),
    source: z.string().optional(),
  })
  .passthrough();
export type TgFull = z.infer<typeof TgFullSchema>;

export const MeSchema = z
  .object({
    uid: z.coerce.number().optional().nullable(),
    email: z.string().optional().nullable(), // tolerant: parsing must not crash if the server ever omits/nulls it
    role: z.string().optional(),
    avatar: z.string().optional().nullable(), // base64 data URL profile photo
  })
  .passthrough();
export type Me = z.infer<typeof MeSchema>;

export const LoginResponseSchema = z
  .object({
    token: z.string(),
    expiresAt: z.string().optional().nullable(),
    user: z
      .object({
        email: z.string().optional().nullable(),
        role: z.string().optional().nullable(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const AuthMessageSchema = z
  .object({
    ok: z.boolean().optional(),
    status: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const AuthOkSchema = z.object({ ok: z.boolean() }).passthrough();

export const MentionsSchema = z
  .object({
    available: z.boolean().optional(),
    error: z.string().optional().nullable(),
    quota: z
      .object({
        remains: z.coerce.number().optional().nullable(),
        total: z.coerce.number().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    skipped: z.array(z.string()).optional().nullable(),
    total: z.coerce.number().optional().nullable(),
    unique_channels: z.coerce.number().optional().nullable(),
    total_views: z.coerce.number().optional().nullable(),
    by_day: z.record(z.string(), z.coerce.number()).optional().nullable(),
    top_channels: z
      .array(
        z
          .object({
            username: z.string().optional().nullable(),
            title: z.string().optional().nullable(),
            count: z.coerce.number(),
            views: z.coerce.number().optional().nullable(),
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
    recent: z
      .array(
        z
          .object({
            date: z.string().optional().nullable(),
            username: z.string().optional().nullable(),
            title: z.string().optional().nullable(),
            link: z.string().optional().nullable(),
            views: z.coerce.number().optional().nullable(),
            snippet: z.string().optional().nullable(),
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
  })
  .passthrough();
export type Mentions = z.infer<typeof MentionsSchema>;

export const HistoryRowSchema = z
  .object({
    day: z.string(),
    subscribers: z.coerce.number().optional().nullable(),
    joins: z.coerce.number().optional().nullable(),
    leaves: z.coerce.number().optional().nullable(),
    views: z.coerce.number().optional().nullable(),
    forwards: z.coerce.number().optional().nullable(),
    reactions: z.coerce.number().optional().nullable(),
  })
  .passthrough();

export const HistorySchema = z
  .object({
    enabled: z.boolean().optional(),
    error: z.string().optional().nullable(),
    rows: z.array(HistoryRowSchema).optional().default([]),
  })
  .passthrough();
export type HistoryData = z.infer<typeof HistorySchema>;

// Persisted IG daily series (GET /api/ig/history → Postgres ig_daily). Same tolerant shape as
// HistoryRowSchema: every metric optional+nullable so a partial cron capture never blocks the chart.
export const IgHistoryRowSchema = z
  .object({
    day: z.string(),
    followers: z.coerce.number().optional().nullable(),
    reach: z.coerce.number().optional().nullable(),
    views: z.coerce.number().optional().nullable(),
    profile_views: z.coerce.number().optional().nullable(),
    accounts_engaged: z.coerce.number().optional().nullable(),
    total_interactions: z.coerce.number().optional().nullable(),
    likes: z.coerce.number().optional().nullable(),
    comments: z.coerce.number().optional().nullable(),
    saves: z.coerce.number().optional().nullable(),
    shares: z.coerce.number().optional().nullable(),
    follows: z.coerce.number().optional().nullable(),
    unfollows: z.coerce.number().optional().nullable(),
  })
  .passthrough();

export const IgHistorySchema = z
  .object({
    enabled: z.boolean().optional(),
    error: z.string().optional().nullable(),
    rows: z.array(IgHistoryRowSchema).optional().default([]),
  })
  .passthrough();
export type IgHistoryRow = z.infer<typeof IgHistoryRowSchema>;
export type IgHistoryData = z.infer<typeof IgHistorySchema>;

export const VelocityDaySchema = z
  .object({
    day: z.coerce.number(),
    cum: z.coerce.number(),
    share: z.coerce.number(),
  })
  .passthrough();

export const VelocitySchema = z
  .object({
    available: z.boolean().optional(),
    by_day: z.array(VelocityDaySchema).optional().default([]),
    day1_share: z.coerce.number().optional().nullable(),
    t80_days: z.coerce.number().optional().nullable(),
    posts_used: z.coerce.number().optional().nullable(),
    source: z.string().optional().nullable(),
  })
  .passthrough();
export type VelocityData = z.infer<typeof VelocitySchema>;

export const PostStatsSchema = z
  .object({
    available: z.boolean().optional(),
    views_graph: z
      .object({
        x: z.array(z.coerce.number()).optional().default([]),
        series: z
          .array(
            z
              .object({
                name: z.string().optional().nullable(),
                values: z.array(z.coerce.number()).optional().default([]),
              })
              .passthrough(),
          )
          .optional()
          .default([]),
      })
      .optional()
      .nullable(),
    reactions: z
      .array(z.object({ label: z.string(), value: z.coerce.number() }).passthrough())
      .optional()
      .nullable(),
  })
  .passthrough();
export type PostStats = z.infer<typeof PostStatsSchema>;

// ── TG analytics: stats + the big nested graphs payload ──────────────
export const StatsSchema = z
  .object({
    views_per_post: z.object({ current: z.coerce.number().optional().nullable() }).passthrough().optional().nullable(),
    shares_per_post: z.object({ current: z.coerce.number().optional().nullable() }).passthrough().optional().nullable(),
    reactions_per_post: z.object({ current: z.coerce.number().optional().nullable() }).passthrough().optional().nullable(),
    enabled_notifications: z
      .object({ part: z.coerce.number().optional().nullable(), total: z.coerce.number().optional().nullable() })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();
export type TgStats = z.infer<typeof StatsSchema>;

const Series = z
  .object({ name: z.string().optional().nullable(), values: z.array(z.coerce.number()).optional().default([]) })
  .passthrough();
const SeriesGroup = z
  .object({ series: z.array(Series).optional().default([]), x: z.array(z.coerce.number()).optional().default([]) })
  .passthrough();
const LabelVal = z
  .object({ label: z.string().optional().nullable(), value: z.coerce.number().optional().nullable() })
  .passthrough();

export const GraphsSchema = z
  .object({
    growth: SeriesGroup.optional().nullable(),
    interactions: SeriesGroup.optional().nullable(),
    followers: SeriesGroup.optional().nullable(),
    top_hours: z
      .object({ values: z.array(z.coerce.number()).optional().default([]), hours: z.array(z.coerce.number()).optional().default([]) })
      .passthrough()
      .optional()
      .nullable(),
    views_by_source: z.array(LabelVal).optional().nullable(),
    new_followers_by_source: z.array(LabelVal).optional().nullable(),
    languages: z.array(LabelVal).optional().nullable(),
    reactions_sentiment: z.array(LabelVal).optional().nullable(),
  })
  .passthrough();
export type TgGraphs = z.infer<typeof GraphsSchema>;

// ── Account cluster: channels, API keys, admin users, bug tracker ────
export const ChannelSchema = z
  .object({
    id: z.coerce.number(),
    username: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    tg_channel_id: z.unknown().optional(),
    owner_uid: z.coerce.number().optional().nullable(),
    memberCount: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export const ChannelsResponseSchema = z
  .object({
    enabled: z.boolean().optional(),
    channels: z.array(ChannelSchema).optional().default([]),
    selected: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelsResponse = z.infer<typeof ChannelsResponseSchema>;

export const KeySchema = z
  .object({
    id: z.coerce.number(),
    key_prefix: z.string().optional().nullable(),
    label: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    last_used_at: z.string().optional().nullable(),
    revoked: z.boolean().optional(),
  })
  .passthrough();
export const CreateKeyResponseSchema = KeySchema.extend({ key: z.string().optional() }).passthrough();
export type ApiKey = z.infer<typeof KeySchema>;
export type CreateKeyResponse = z.infer<typeof CreateKeyResponseSchema>;

// Collector health for a channel (GET /api/channels/:id/collector-status). `stale` and
// `stale_after_hours` are computed by the server; the rest come from the collector_status row.
export const CollectorStatusSchema = z
  .object({
    collector_version: z.string().optional().nullable(),
    last_attempt_at: z.string().optional().nullable(),
    last_success_at: z.string().optional().nullable(),
    last_error: z.string().optional().nullable(),
    stale: z.boolean().optional(),
    stale_after_hours: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export const CollectorStatusResponseSchema = z
  .object({ status: CollectorStatusSchema.nullable().optional() })
  .passthrough();
export type CollectorStatus = z.infer<typeof CollectorStatusSchema>;

export const AdminUserSchema = z
  .object({
    id: z.coerce.number(),
    email: z.string().optional().nullable(),
    role: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
  })
  .passthrough();
export const AdminUsersResponseSchema = z
  .object({
    users: z.array(AdminUserSchema).optional().default([]),
    roles: z.array(z.string()).optional().default([]),
    statuses: z.array(z.string()).optional().default([]),
    me: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminUsersResponse = z.infer<typeof AdminUsersResponseSchema>;

export const BugSchema = z
  .object({
    id: z.coerce.number(),
    created_at: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    severity: z.string().optional().nullable(),
    kind: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
    context: z.string().optional().nullable(),
    attachments: z
      .array(z.object({ id: z.coerce.number(), mime: z.string() }).passthrough())
      .optional()
      .default([]),
  })
  .passthrough();
export const BugsResponseSchema = z
  .object({
    enabled: z.boolean().optional(),
    statuses: z.array(z.string()).optional().default([]),
    kinds: z.array(z.string()).optional().default([]),
    bugs: z.array(BugSchema).optional().default([]),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type Bug = z.infer<typeof BugSchema>;
export type BugsResponse = z.infer<typeof BugsResponseSchema>;

// ── Instagram (Graph API shapes; mock-backed until a real account is connected) ──
export const IgProfileSchema = z
  .object({
    mock: z.boolean().optional(),
    username: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    followers_count: z.coerce.number().optional().nullable(),
    follows_count: z.coerce.number().optional().nullable(),
    media_count: z.coerce.number().optional().nullable(),
    biography: z.string().optional().nullable(),
    website: z.string().optional().nullable(),
    profile_picture_url: z.string().optional().nullable(),
    synced_at: z.coerce.number().optional().nullable(), // real last-sync time (ms) from the server
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgProfile = z.infer<typeof IgProfileSchema>;

// total_value + breakdowns envelope (modern Graph v22+ for demographics / format splits).
export const IgBreakdownResultSchema = z
  .object({
    dimension_values: z.array(z.string()).optional().default([]),
    value: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export const IgBreakdownSchema = z
  .object({
    dimension_keys: z.array(z.string()).optional().default([]),
    results: z.array(IgBreakdownResultSchema).optional().default([]),
  })
  .passthrough();
export const IgTotalValueSchema = z
  .object({
    value: z.coerce.number().optional().nullable(),
    breakdowns: z.array(IgBreakdownSchema).optional().default([]),
  })
  .passthrough();

export const IgInsightValueSchema = z
  .object({
    value: z.coerce.number().optional().nullable(),
    end_time: z.string().optional().nullable(),
  })
  .passthrough();
export const IgInsightMetricSchema = z
  .object({
    name: z.string(),
    period: z.string().optional().nullable(),
    values: z.array(IgInsightValueSchema).optional().default([]),
    total_value: IgTotalValueSchema.optional().nullable(),
  })
  .passthrough();
export const IgInsightsSchema = z
  .object({
    mock: z.boolean().optional(),
    data: z.array(IgInsightMetricSchema).optional().default([]),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgInsights = z.infer<typeof IgInsightsSchema>;

// Breakdowns endpoint reuses the metric envelope (each entry carries a total_value).
export const IgBreakdownsSchema = z
  .object({
    mock: z.boolean().optional(),
    timeframe: z.string().optional().nullable(),
    data: z.array(IgInsightMetricSchema).optional().default([]),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgBreakdowns = z.infer<typeof IgBreakdownsSchema>;

// online_followers — each value is an hour→count map ({ "0": n, … "23": n }).
export const IgOnlineValueSchema = z
  .object({
    value: z.record(z.string(), z.coerce.number()).optional().nullable(),
    end_time: z.string().optional().nullable(),
  })
  .passthrough();
export const IgOnlineMetricSchema = z
  .object({
    name: z.string().optional(),
    period: z.string().optional().nullable(),
    values: z.array(IgOnlineValueSchema).optional().default([]),
  })
  .passthrough();
export const IgOnlineSchema = z
  .object({
    mock: z.boolean().optional(),
    data: z.array(IgOnlineMetricSchema).optional().default([]),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgOnline = z.infer<typeof IgOnlineSchema>;

export const IgPostSchema = z
  .object({
    id: z.string().optional(),
    caption: z.string().optional().nullable(),
    media_type: z.string().optional().nullable(),
    media_product_type: z.string().optional().nullable(),
    media_url: z.string().optional().nullable(),
    thumbnail_url: z.string().optional().nullable(),
    permalink: z.string().optional().nullable(),
    timestamp: z.string().optional().nullable(),
    like_count: z.coerce.number().optional().nullable(),
    comments_count: z.coerce.number().optional().nullable(),
    reach: z.coerce.number().optional().nullable(),
    views: z.coerce.number().optional().nullable(),
    impressions: z.coerce.number().optional().nullable(),
    shares: z.coerce.number().optional().nullable(),
    saved: z.coerce.number().optional().nullable(),
    total_interactions: z.coerce.number().optional().nullable(),
    ig_reels_avg_watch_time: z.coerce.number().optional().nullable(),
    ig_reels_video_view_total_time: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export const IgPostsSchema = z
  .object({
    mock: z.boolean().optional(),
    data: z.array(IgPostSchema).optional().default([]),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgPost = z.infer<typeof IgPostSchema>;
export type IgPosts = z.infer<typeof IgPostsSchema>;

export const IgStorySchema = z
  .object({
    id: z.string().optional(),
    media_type: z.string().optional().nullable(),
    timestamp: z.string().optional().nullable(),
    expires_at: z.string().optional().nullable(),
    permalink: z.string().optional().nullable(),
    thumbnail_url: z.string().optional().nullable(),
    reach: z.coerce.number().optional().nullable(),
    views: z.coerce.number().optional().nullable(),
    replies: z.coerce.number().optional().nullable(),
    shares: z.coerce.number().optional().nullable(),
    follows: z.coerce.number().optional().nullable(),
    profile_visits: z.coerce.number().optional().nullable(),
    total_interactions: z.coerce.number().optional().nullable(),
    navigation_total: z.coerce.number().optional().nullable(),
    navigation: z.record(z.string(), z.coerce.number()).optional().nullable(),
  })
  .passthrough();
export const IgStoriesSchema = z
  .object({
    mock: z.boolean().optional(),
    data: z.array(IgStorySchema).optional().default([]),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgStory = z.infer<typeof IgStorySchema>;
export type IgStories = z.infer<typeof IgStoriesSchema>;

// Tags — media where the account is @-tagged (the brand-mentions surface). Archived in `ig_tags`.
export const IgTagSchema = z
  .object({
    id: z.string().optional(),
    username: z.string().optional().nullable(),
    caption: z.string().optional().nullable(),
    permalink: z.string().optional().nullable(),
    media_type: z.string().optional().nullable(),
    like_count: z.coerce.number().optional().nullable(),
    comments_count: z.coerce.number().optional().nullable(),
    timestamp: z.string().optional().nullable(),
    first_seen: z.string().optional().nullable(),
  })
  .passthrough();
export const IgTagsSchema = z
  .object({
    mock: z.boolean().optional(),
    data: z.array(IgTagSchema).optional().default([]),
    live_count: z.coerce.number().optional().nullable(),
    error: z.string().optional().nullable(),
  })
  .passthrough();
export type IgTag = z.infer<typeof IgTagSchema>;
export type IgTags = z.infer<typeof IgTagsSchema>;

// ── Reports (saved multi-report documents; per-user, JSONB config round-trips) ──
// config.blocks = ordered block keys of the composed document (see panels/ReportPage registry);
// config.periodDays = the persisted period preset (7|30|90|0). `blocks` has NO default on purpose:
// a missing list (legacy row) falls back to the full default set client-side, while an explicitly
// emptied report ([]) stays empty.
export const ReportConfigSchema = z
  .object({
    blocks: z.array(z.string()).optional(),
    periodDays: z.coerce.number().optional().nullable(),
  })
  .passthrough();
export type ReportConfig = z.infer<typeof ReportConfigSchema>;

export const ReportListItemSchema = z
  .object({
    id: z.coerce.number(),
    name: z.string(),
    schedule: z.string().optional().default('none'),
    created_at: z.string().optional().nullable(),
    updated_at: z.string().optional().nullable(),
  })
  .passthrough();
export type ReportListItem = z.infer<typeof ReportListItemSchema>;

export const ReportSchema = ReportListItemSchema.extend({
  config: ReportConfigSchema.optional().default({}),
}).passthrough();
export type Report = z.infer<typeof ReportSchema>;

export const ReportsResponseSchema = z
  .object({ reports: z.array(ReportListItemSchema).optional().default([]) })
  .passthrough();
export const ReportResponseSchema = z.object({ report: ReportSchema }).passthrough();
export type ReportResponse = z.infer<typeof ReportResponseSchema>;
