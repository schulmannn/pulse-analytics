import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import { MentionsSchema, MeSchema, TgFullSchema } from '@/api/schemas';

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
