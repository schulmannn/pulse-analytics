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
    queryFn: ({ signal }) => apiGet('/api/auth/me', MeSchema, { signal }),
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

const ConfigSchema = z.object({ google_client_id: z.string().nullable() }).passthrough();

/** Public runtime config — currently the Google client id (drives whether the Google button shows). */
export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => apiGet('/api/config', ConfigSchema, { signal }),
    staleTime: Infinity,
    retry: false,
  });
}

/** Sign in with Google — exchange the GSI ID token for our session (same response shape as login). */
export function useGoogleLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credential: string) => apiSend('POST', '/api/auth/google', { credential }, LoginResponseSchema),
    onSuccess: (data) => {
      setSessionToken(data.token, sessionTtl(data.expiresAt));
      return qc.invalidateQueries();
    },
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

/**
 * Aggregate channel snapshot: channel info + views summary + recent posts.
 *
 * Like every channel-scoped hook below, it (a) waits for the channel to be known
 * (`enabled: channelId != null` — no wasted null-channel fetch on bootstrap), and
 * (b) passes the render-time channelId + TanStack's abort signal into apiGet, so the
 * request provably matches the query key and cancelQueries() aborts it. NOTE: disabled
 * queries report `isPending` (not `isLoading`) — consumers gate skeletons on isPending.
 */
export function useTgFull(days: PeriodDays, opts?: { windowPair?: boolean }) {
  const { channelId } = useSelectedChannel();
  const { range } = usePeriod();
  // Comparison surfaces (metric pages / report / Сравнение) need the PREVIOUS equal-length
  // window too — the preset limit covers roughly one window, so «Сравнение» came back empty
  // on prod (60 posts don't reach the prior 30 days). Double it, server caps at 100.
  const limit = opts?.windowPair
    ? Math.min(100, effectiveLimit(days, range) * 2)
    : effectiveLimit(days, range);
  return useQuery({
    enabled: channelId != null,
    queryKey: ['tg-full', channelId, days, range?.from ?? 0, range?.to ?? 0, limit],
    queryFn: ({ signal }) => apiGet(`/api/tg/full?limit=${limit}`, TgFullSchema, { signal, channelId }),
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
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/mentions', MentionsSchema, { signal, channelId }),
  });
}

/**
 * Archived brand mentions (Postgres). Free — no MTProto quota — so it loads on mount;
 * the live search above only refreshes/extends it on demand. Same response shape.
 */
export function useMentionsArchive() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['mentions-archive', channelId],
    queryFn: ({ signal }) => apiGet('/api/history/mentions', MentionsSchema, { signal, channelId }),
  });
}

/** Subscriber history (Postgres channel_daily). Default 730 days. */
export function useHistory(days = 730) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['history-channel', channelId, days],
    queryFn: ({ signal }) => apiGet(`/api/history/channel?days=${days}`, HistorySchema, { signal, channelId }),
  });
}

/** View-velocity snapshot (how fast posts accumulate reach). */
export function useVelocity() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['velocity', channelId],
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/velocity', VelocitySchema, { signal, channelId }),
  });
}

// ── Instagram (per-channel OAuth token, or the global env account, or mock) ──
// Every IG query is keyed by the selected channel: IG is now per-channel, so switching the
// active channel must refetch (a bare ['ig-*'] key would show the previous channel's cached data).
export function useIgProfile() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-profile', channelId],
    queryFn: ({ signal }) => apiGet('/api/ig/profile', IgProfileSchema, { signal, channelId }),
  });
}

/** Fetch insights for the selected window. reach/follower come as a 90-day daily series (windowed
 *  client-side); the aggregate metrics (views/saves/…) are computed by the server for this exact
 *  window + the previous one (for deltas), since they have no daily series to slice. */
export function useIgInsights(days = 90) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-insights', channelId, days],
    queryFn: ({ signal }) => apiGet(`/api/ig/insights?days=${days}`, IgInsightsSchema, { signal, channelId }),
  });
}

export function useIgPosts(limit = 20) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-posts', channelId, limit],
    queryFn: ({ signal }) => apiGet(`/api/ig/posts?limit=${limit}`, IgPostsSchema, { signal, channelId }),
  });
}

/** Audience demographics + format/contact breakdowns (total_value envelope). */
export function useIgBreakdowns(timeframe = 'last_30_days') {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-breakdowns', channelId, timeframe],
    queryFn: ({ signal }) => apiGet(`/api/ig/breakdowns?timeframe=${timeframe}`, IgBreakdownsSchema, { signal, channelId }),
  });
}

/** Online-followers hourly map (best-time heatmap). Degrades to empty gracefully. */
export function useIgOnline() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-online', channelId],
    queryFn: ({ signal }) => apiGet('/api/ig/online', IgOnlineSchema, { signal, channelId }),
  });
}

/** Active stories (last 24h) + per-story insights. */
export function useIgStories() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-stories', channelId],
    queryFn: ({ signal }) => apiGet('/api/ig/stories', IgStoriesSchema, { signal, channelId }),
  });
}

/** Tags — media where the account is @-tagged (live edge + DB archive). */
export function useIgTags() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-tags', channelId],
    queryFn: ({ signal }) => apiGet('/api/ig/tags', IgTagsSchema, { signal, channelId }),
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
    enabled: channelId != null,
    queryKey: ['ig-oauth-status', channelId],
    queryFn: ({ signal }) => apiGet('/api/ig/oauth/status', IgOauthStatusSchema, { signal, channelId }),
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
    enabled: id != null && channelId != null,
    queryKey: ['post-stats', channelId, id],
    queryFn: ({ signal }) => apiGet(`/api/tg/mtproto/post_stats/${id}`, PostStatsSchema, { signal, channelId }),
  });
}

// ── TG analytics ──
export function useTgStats() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['tg-stats', channelId],
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/stats', StatsSchema, { signal, channelId }),
  });
}

export function useTgGraphs() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['tg-graphs', channelId],
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/graphs', GraphsSchema, { signal, channelId }),
  });
}

// ── Account cluster: channels / keys / admin / bugs ──
const OkSchema = z.object({ ok: z.boolean() }).passthrough();

export function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: ({ signal }) => apiGet('/api/channels', ChannelsResponseSchema, { signal }),
  });
}

export function useChannelKeys(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['channel-keys', id],
    queryFn: ({ signal }) =>
      apiGet(`/api/channels/${id}/keys`, z.object({ keys: z.array(KeySchema) }).passthrough(), { signal }),
  });
}

export function useCollectorStatus(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['collector-status', id],
    queryFn: ({ signal }) => apiGet(`/api/channels/${id}/collector-status`, CollectorStatusResponseSchema, { signal }),
  });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin-users'],
    queryFn: ({ signal }) => apiGet('/api/admin/users', AdminUsersResponseSchema, { signal }),
  });
}

export function useBugs() {
  return useQuery({
    queryKey: ['bugs'],
    queryFn: ({ signal }) => apiGet('/api/bugs', BugsResponseSchema, { signal }),
  });
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
