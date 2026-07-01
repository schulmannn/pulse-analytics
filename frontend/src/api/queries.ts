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
  IgTagsSchema,
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

/** Set / remove the current user's profile photo (base64 data URL, resized client-side). */
export function useUpdateAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataUrl: string) => apiSend('POST', '/api/me/avatar', { dataUrl }, AuthOkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}
export function useRemoveAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('DELETE', '/api/me/avatar', undefined, AuthOkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
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

// ── Instagram (per-channel OAuth token, or the global env account, or mock) ──
// Every IG query is keyed by the selected channel: IG is now per-channel, so switching the
// active channel must refetch (a bare ['ig-*'] key would show the previous channel's cached data).
export function useIgProfile() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-profile', channelId],
    queryFn: () => apiGet('/api/ig/profile', IgProfileSchema),
  });
}

/** Fetch insights for the selected window. reach/follower come as a 90-day daily series (windowed
 *  client-side); the aggregate metrics (views/saves/…) are computed by the server for this exact
 *  window + the previous one (for deltas), since they have no daily series to slice. */
export function useIgInsights(days = 90) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-insights', channelId, days],
    queryFn: () => apiGet(`/api/ig/insights?days=${days}`, IgInsightsSchema),
  });
}

export function useIgPosts(limit = 20) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-posts', channelId, limit],
    queryFn: () => apiGet(`/api/ig/posts?limit=${limit}`, IgPostsSchema),
  });
}

/** Audience demographics + format/contact breakdowns (total_value envelope). */
export function useIgBreakdowns(timeframe = 'last_30_days') {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-breakdowns', channelId, timeframe],
    queryFn: () => apiGet(`/api/ig/breakdowns?timeframe=${timeframe}`, IgBreakdownsSchema),
  });
}

/** Online-followers hourly map (best-time heatmap). Degrades to empty gracefully. */
export function useIgOnline() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-online', channelId],
    queryFn: () => apiGet('/api/ig/online', IgOnlineSchema),
  });
}

/** Active stories (last 24h) + per-story insights. */
export function useIgStories() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-stories', channelId],
    queryFn: () => apiGet('/api/ig/stories', IgStoriesSchema),
  });
}

/** Tags — media where the account is @-tagged (live edge + DB archive). */
export function useIgTags() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-tags', channelId],
    queryFn: () => apiGet('/api/ig/tags', IgTagsSchema),
  });
}

// ── Instagram OAuth (per-channel connect) ──
const IgOauthStatusSchema = z
  .object({
    server_ready: z.boolean(),
    env_fallback: z.boolean(),
    connected: z.boolean(),
    channel_id: z.number().nullable(),
    username: z.string().nullable(),
    ig_user_id: z.string().nullable(),
    connected_at: z.string().nullable(),
    token_expires_at: z.string().nullable(),
  })
  .passthrough();
export type IgOauthStatus = z.infer<typeof IgOauthStatusSchema>;
const IgConnectStartSchema = z.object({ authorize_url: z.string().url() }).passthrough();

/** Connection state for the current channel (Settings + connect panel). No token is ever exposed. */
export function useIgOauthStatus() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    queryKey: ['ig-oauth-status', channelId],
    queryFn: () => apiGet('/api/ig/oauth/status', IgOauthStatusSchema),
  });
}

/** Begin the connect flow: ask the server for an authorize_url, then hand the browser to Instagram
 *  (a top-level navigation — the session header can't survive the OAuth redirect). */
export function useConnectIg() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiSend('POST', '/api/ig/oauth/start', undefined, IgConnectStartSchema);
      window.location.href = res.authorize_url;
      return res;
    },
  });
}

/** Disconnect the Instagram account from the current channel; refetch IG data + status. */
export function useDisconnectIg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('DELETE', '/api/ig/oauth', undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ig-') }),
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
