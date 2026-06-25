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
    email: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();
export type Me = z.infer<typeof MeSchema>;

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
