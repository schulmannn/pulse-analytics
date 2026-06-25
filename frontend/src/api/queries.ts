import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import {
  HistorySchema,
  MentionsSchema,
  MeSchema,
  PostStatsSchema,
  TgFullSchema,
  VelocitySchema,
} from '@/api/schemas';

/** Current session. retry:false so a 401 surfaces immediately (→ login gate). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet('/api/auth/me', MeSchema),
    retry: false,
  });
}

/** Aggregate channel snapshot: channel info + views summary + recent posts. */
export function useTgFull(limit = 30) {
  return useQuery({
    queryKey: ['tg-full', limit],
    queryFn: () => apiGet(`/api/tg/full?limit=${Math.min(100, limit)}`, TgFullSchema),
  });
}

/**
 * Brand mentions. enabled:false + manual refetch() — fetching costs searchPosts quota
 * (~10/day), so it only runs on an explicit "load/refresh" press, never on mount.
 */
export function useMentions() {
  return useQuery({
    enabled: false,
    queryKey: ['mentions'],
    queryFn: () => apiGet('/api/tg/mtproto/mentions', MentionsSchema),
  });
}

/** Subscriber history (Postgres channel_daily). Default 730 days. */
export function useHistory(days = 730) {
  return useQuery({
    queryKey: ['history-channel', days],
    queryFn: () => apiGet(`/api/history/channel?days=${days}`, HistorySchema),
  });
}

/** View-velocity snapshot (how fast posts accumulate reach). */
export function useVelocity() {
  return useQuery({
    queryKey: ['velocity'],
    queryFn: () => apiGet('/api/tg/mtproto/velocity', VelocitySchema),
  });
}

/** Per-post drill-down (views-over-time + reactions). Runs only when a post is open. */
export function usePostStats(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['post-stats', id],
    queryFn: () => apiGet(`/api/tg/mtproto/post_stats/${id}`, PostStatsSchema),
  });
}
