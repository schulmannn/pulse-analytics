import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import {
  AdminUserSchema,
  AdminUsersResponseSchema,
  BugSchema,
  BugsResponseSchema,
  ChannelSchema,
  ChannelsResponseSchema,
  CreateKeyResponseSchema,
  GraphsSchema,
  HistorySchema,
  KeySchema,
  MentionsSchema,
  MeSchema,
  PostStatsSchema,
  StatsSchema,
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

// ── TG analytics ──
export function useTgStats() {
  return useQuery({ queryKey: ['tg-stats'], queryFn: () => apiGet('/api/tg/mtproto/stats', StatsSchema) });
}

export function useTgGraphs() {
  return useQuery({ queryKey: ['tg-graphs'], queryFn: () => apiGet('/api/tg/mtproto/graphs', GraphsSchema) });
}

// ── Account cluster: channels / keys / admin / bugs ──
const OkSchema = z.object({ ok: z.boolean() }).passthrough();

export function useChannels() {
  return useQuery({ queryKey: ['channels'], queryFn: () => apiGet('/api/channels', ChannelsResponseSchema) });
}

export function useChannelKeys(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['channel-keys', id],
    queryFn: () => apiGet(`/api/channels/${id}/keys`, z.object({ keys: z.array(KeySchema) }).passthrough()),
  });
}

export function useAdminUsers() {
  return useQuery({ queryKey: ['admin-users'], queryFn: () => apiGet('/api/admin/users', AdminUsersResponseSchema) });
}

export function useBugs() {
  return useQuery({ queryKey: ['bugs'], queryFn: () => apiGet('/api/bugs', BugsResponseSchema) });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string }) => apiSend('POST', '/api/channels', body, ChannelSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/channels/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

export function useCreateKey(channelId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label: string }) => apiSend('POST', `/api/channels/${channelId}/key`, body, CreateKeyResponseSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channel-keys', channelId] }),
  });
}

export function useRevokeKey(channelId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => apiSend('DELETE', `/api/channels/${channelId}/key/${keyId}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channel-keys', channelId] }),
  });
}

export function useUpdateUser(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { role?: string; status?: string }) => apiSend('PATCH', `/api/admin/users/${id}`, body, AdminUserSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

export function useCreateBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string; severity: string; context: string; kind: string }) =>
      apiSend('POST', '/api/bugs', body, BugSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bugs'] }),
  });
}

export function useUpdateBugStatus(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: string }) => apiSend('PATCH', `/api/bugs/${id}`, body, BugSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bugs'] }),
  });
}

export function useDeleteBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/bugs/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bugs'] }),
  });
}
