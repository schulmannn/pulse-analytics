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

export const TgFullSchema = z
  .object({
    channel: TgChannelSchema.optional().default({}),
    views_summary: ViewsSummarySchema.nullable().optional(),
    posts: z.array(z.unknown()).optional().default([]),
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
