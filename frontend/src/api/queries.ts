import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import {
  AdminUserSchema,
  AdminUsersResponseSchema,
  AuthMessageSchema,
  AuthOkSchema,
  BugSchema,
  BugsResponseSchema,
  ChannelSchema,
  ChannelsResponseSchema,
  CollectorStatusResponseSchema,
  CreateKeyResponseSchema,
  GraphsSchema,
  HistorySchema,
  IgBreakdownsSchema,
  IgInsightsSchema,
  IgOnlineSchema,
  IgPostsSchema,
  IgProfileSchema,
  IgStoriesSchema,
  KeySchema,
  LoginResponseSchema,
  MentionsSchema,
  MeSchema,
  PostStatsSchema,
  StatsSchema,
  TgFullSchema,
  VelocitySchema,
} from '@/api/schemas';
import { clearSessionToken, setSessionToken } from '@/lib/session';
import { useSelectedChannel } from '@/lib/channel-context';
import { effectiveLimit, usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';

/** Current session. retry:false so a 401 surfaces immediately (→ login gate). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiGet('/api/auth/me', MeSchema),
    retry: false,
  });
}

function sessionTtl(expiresAt?: string | null): number | undefined {
  if (!expiresAt) return undefined;
  const ttlMs = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : undefined;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiSend('POST', '/api/auth/login', body, LoginResponseSchema),
    onSuccess: (data) => {
      setSessionToken(data.token, sessionTtl(data.expiresAt));
      return qc.invalidateQueries();
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiSend('POST', '/api/auth/register', body, AuthMessageSchema),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string }) => apiSend('POST', '/api/auth/verify', body, AuthOkSchema),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useForgot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string }) => apiSend('POST', '/api/auth/forgot', body, AuthMessageSchema),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      apiSend('POST', '/api/auth/reset', body, AuthMessageSchema),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  const { setChannelId } = useSelectedChannel();
  const clearLocalSession = () => {
    clearSessionToken();
    setChannelId(null);
  };
  return useMutation({
    mutationFn: () => apiSend('POST', '/api/auth/logout', undefined, AuthOkSchema),
    onSuccess: () => {
      clearLocalSession();
      return qc.invalidateQueries();
    },
    onError: clearLocalSession,
    onSettled: () => qc.clear(),
  });
}

/** Aggregate channel snapshot: channel info + views summary + recent posts. */
export function useTgFull(days: PeriodDays) {
  const { channelId } = useSelectedChannel();
  const { range } = usePeriod();
  const limit = effectiveLimit(days, range);
  return useQuery({
    queryKey: ['tg-full', channelId, days, range?.from ?? 0, range?.to ?? 0],
    queryFn: () => apiGet(`/api/tg/full?limit=${limit}`, TgFullSchema),
  });
}

/**
 * Live brand mentions. enabled:false + manual refetch() — fetching costs searchPosts
 * quota (~10/day), so it only runs on an explicit "refresh" press, never on mount.
 */
export function useMentions() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: false,
    queryKey: ['mentions', channelId],
    queryFn: () => apiGet('/api/tg/mtproto/mentions', MentionsSchema),
  });
}

/**
 * Archived brand mentions (Postgres). Free — no MTProto quota — so it loads on mount;
 * the live search above only refreshes/extends it on demand. Same response shape.
 */
export function useMentionsArchive() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['mentions-archive', channelId],
    queryFn: () => apiGet('/api/history/mentions', MentionsSchema),
  });
}

/** Subscriber history (Postgres channel_daily). Default 730 days. */
export function useHistory(days = 730) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['history-channel', channelId, days],
    queryFn: () => apiGet(`/api/history/channel?days=${days}`, HistorySchema),
  });
}

/** View-velocity snapshot (how fast posts accumulate reach). */
export function useVelocity() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['velocity', channelId],
    queryFn: () => apiGet('/api/tg/mtproto/velocity', VelocitySchema),
  });
}

// ── Instagram (single account from env; mock-backed until real credentials are set) ──
export function useIgProfile() {
  return useQuery({
    queryKey: ['ig-profile'],
    queryFn: () => apiGet('/api/ig/profile', IgProfileSchema),
  });
}

/** Always fetch the full 90-day window (the server cap); the panel slices to the active
 *  period client-side and uses the extra history as the previous window for deltas. */
export function useIgInsights() {
  return useQuery({
    queryKey: ['ig-insights', 90],
    queryFn: () => apiGet('/api/ig/insights?days=90', IgInsightsSchema),
  });
}

export function useIgPosts(limit = 20) {
  return useQuery({
    queryKey: ['ig-posts', limit],
    queryFn: () => apiGet(`/api/ig/posts?limit=${limit}`, IgPostsSchema),
  });
}

/** Audience demographics + format/contact breakdowns (total_value envelope). */
export function useIgBreakdowns(timeframe = 'last_30_days') {
  return useQuery({
    queryKey: ['ig-breakdowns', timeframe],
    queryFn: () => apiGet(`/api/ig/breakdowns?timeframe=${timeframe}`, IgBreakdownsSchema),
  });
}

/** Online-followers hourly map (best-time heatmap). Degrades to empty gracefully. */
export function useIgOnline() {
  return useQuery({
    queryKey: ['ig-online'],
    queryFn: () => apiGet('/api/ig/online', IgOnlineSchema),
  });
}

/** Active stories (last 24h) + per-story insights. */
export function useIgStories() {
  return useQuery({
    queryKey: ['ig-stories'],
    queryFn: () => apiGet('/api/ig/stories', IgStoriesSchema),
  });
}

/** Per-post drill-down (views-over-time + reactions). Runs only when a post is open. */
export function usePostStats(id: number | null) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: id != null,
    queryKey: ['post-stats', channelId, id],
    queryFn: () => apiGet(`/api/tg/mtproto/post_stats/${id}`, PostStatsSchema),
  });
}

// ── TG analytics ──
export function useTgStats() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['tg-stats', channelId],
    queryFn: () => apiGet('/api/tg/mtproto/stats', StatsSchema),
  });
}

export function useTgGraphs() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['tg-graphs', channelId],
    queryFn: () => apiGet('/api/tg/mtproto/graphs', GraphsSchema),
  });
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

export function useCollectorStatus(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['collector-status', id],
    queryFn: () => apiGet(`/api/channels/${id}/collector-status`, CollectorStatusResponseSchema),
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
