import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
// ── Клиентские staleTime-ярусы (арх-аудит: API-fanout) ────────────────────────────────────────
// Переключение источника/канала и каждый маунт карточек давали burst одинаковых запросов:
// staleTime по умолчанию 0 → рефетч на всё. Сервер и так кэширует ответы ~10 мин, свежесть
// виджетам сообщает бейдж «обновлено N мин назад», а канон обновления — ручной (кнопка/retry:
// refetch() ВСЕГДА идёт в сеть, staleTime глушит только автоматические remount-рефетчи).
const STALE_LIVE = 5 * 60 * 1000;      // живые агрегаты (tg-full, ig-insights, посты, графы)
const STALE_ARCHIVE = 30 * 60 * 1000;  // дневные архивы Postgres (history, ig_daily, velocity)
const STALE_STATUS = 60 * 1000;        // свежесть-статусы (collector-status кормит бейдж)

import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import { msPeriodKey, msPeriodQuery, type MsPeriod } from '@/lib/msPeriod';
import type { CampaignSourceScope } from '@/lib/campaignSources';
import {
  AdminUserSchema,
  AdminUsersResponseSchema,
  AuthMessageSchema,
  AuthOkSchema,
  BugSchema,
  BugsResponseSchema,
  CampaignAddResultSchema,
  CampaignPostsResponseSchema,
  CampaignRemoveResultSchema,
  CampaignResponseSchema,
  CampaignSummaryResponseSchema,
  CampaignsResponseSchema,
  ChannelSchema,
  ChannelsResponseSchema,
  CollectorStatusResponseSchema,
  CreateKeyResponseSchema,
  GraphsSchema,
  HistorySchema,
  IgBreakdownsSchema,
  type IgBreakdowns,
  IgHistorySchema,
  IgInsightsSchema,
  type IgInsights,
  IgOnlineSchema,
  IgPostsSchema,
  IgProfileSchema,
  IgStoriesSchema,
  IgTagsSchema,
  KeySchema,
  LoginResponseSchema,
  MentionSettingsSchema,
  MentionsSchema,
  MeSchema,
  PostStatsSchema,
  ReportResponseSchema,
  ReportsResponseSchema,
  StatsSchema,
  TgFullSchema,
  TgQrStatusSchema,
  VelocitySchema,
} from '@/api/schemas';
import type { CampaignPostInput, CampaignStatus, MentionRules, ReportConfig, TgFull } from '@/api/schemas';
import { clearSessionToken, setSessionToken } from '@/lib/session';
import { isDemoMode } from '@/lib/demo';
import { useSelectedChannel } from '@/lib/channel-context';
import { effectiveLimit, usePeriod } from '@/lib/period';
import type { DateRange, PeriodDays } from '@/lib/period';

/** Current session. retry:false so a 401 surfaces immediately (→ login gate). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    staleTime: STALE_LIVE,
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

/**
 * Change the signed-in user's password (POST /api/auth/change-password, requireAuth).
 * Server verifies `current` and enforces `next` ≥ 8 chars; surfaces 403 «Текущий пароль неверен»
 * / 400 «Новый пароль минимум 8 символов» / 503 «БД не подключена» as ApiError messages.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { current: string; next: string }) =>
      apiSend('POST', '/api/auth/change-password', body, AuthOkSchema),
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
export function useTgFull(days: PeriodDays, opts?: { windowPair?: boolean; enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  const { range } = usePeriod();
  // The global custom range only applies to the comparison surfaces (metric pages / report /
  // Сравнение) that opt into windowPair. Plain feed widgets ignore it — otherwise a lingering
  // global range (left by a metric/report page) would re-key the SHARED feed fetch on navigation,
  // spawning a redundant query. So fold `range` into the key + limit only when windowPair is set.
  const effRange = opts?.windowPair ? range : null;
  // Comparison surfaces need the PREVIOUS equal-length window too — the preset limit covers roughly
  // one window, so «Сравнение» came back empty on prod (60 posts don't reach the prior 30 days).
  // Double it, server caps at 100.
  const limit = opts?.windowPair
    ? Math.min(100, effectiveLimit(days, effRange) * 2)
    : effectiveLimit(days, effRange);
  return useQuery<TgFull>({
    // opts.enabled — внешний гейт ПОВЕРХ канального (прогрессивная загрузка Главной: офскрин-
    // карточка держит query disabled, см. lib/widgetViewport). queryKey не меняется.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['tg-full', channelId, days, effRange?.from ?? 0, effRange?.to ?? 0, limit],
    staleTime: STALE_LIVE,
    // Comparison surfaces (metric pages / report / «Сравнение» — windowPair) keep the previous
    // window's data mounted while a new period for the SAME channel loads: without it MetricPage
    // flashed a full-page skeleton on every period change, destroying the old SVG geometry before
    // MorphingSeries could interpolate it into the new shape (no morph). Scoped to windowPair so
    // plain feed widgets keep their skeleton-on-refetch behavior. Never carry data across a channel
    // switch — that would flash another source's metrics (source-invariant, see CLAUDE.md).
    placeholderData: (previous, previousQuery) =>
      opts?.windowPair && previousQuery?.queryKey[1] === channelId ? previous : undefined,
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

/** Per-selected-channel Telegram mention rules. Reading is viewer-safe; writes are owner/admin. */
export function useMentionSettings() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['mention-settings', channelId],
    staleTime: STALE_STATUS,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet('/api/tg/mention-settings', MentionSettingsSchema, { signal, channelId }),
  });
}

/** Save rules under the channel captured by this render, then retire its cached live result. */
export function useSaveMentionSettings() {
  const { channelId } = useSelectedChannel();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MentionRules) => {
      if (channelId == null) return Promise.reject(new Error('Сначала выберите канал'));
      return apiSend('PUT', '/api/tg/mention-settings', body, MentionSettingsSchema, { channelId });
    },
    onSuccess: (data) => {
      qc.setQueryData(['mention-settings', channelId], data);
      return qc.invalidateQueries({ queryKey: ['mentions', channelId] });
    },
  });
}

/**
 * Archived brand mentions (Postgres). Free — no MTProto quota — so it loads on mount; the live
 * search above only refreshes/extends it on demand. Same response shape.
 *
 * `days` (0|7|30|90) is the authoritative desktop period — the server scopes totals/chart/ranking/
 * table to that calendar window and adds `previous`/`daily`/`source_options`. `range` (inclusive
 * from/to) is the custom window; when set it takes precedence over `days` and the SERVER filters by
 * it (no client-side filtering of a truncated response). `source` narrows every aggregate to one
 * mentioning channel (server-authoritative). No args (Home / mobile) = the legacy all-time archive,
 * byte-identical to before.
 */
/** Epoch-ms → local YYYY-MM-DD (matches the DateRangePicker's calendar-day semantics). */
function localIsoDay(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function useMentionsArchive(
  days: PeriodDays = 0,
  source?: string | null,
  limit?: number,
  range?: DateRange | null,
  opts?: { enabled?: boolean },
) {
  const { channelId } = useSelectedChannel();
  const d = days === 7 || days === 30 || days === 90 ? days : 0;
  const src = source && /^\d+$/.test(source) ? source : null;
  const lim = limit != null && Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : null;
  const rng =
    range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.from <= range.to
      ? { from: localIsoDay(range.from), to: localIsoDay(range.to) }
      : null;
  const search = new URLSearchParams();
  if (rng) {
    // Свой диапазон побеждает пресет — days не шлём, чтобы сервер выбрал оконный путь по from/to.
    search.set('from', rng.from);
    search.set('to', rng.to);
  } else if (d) {
    search.set('days', String(d));
  }
  if (src) search.set('source', src);
  if (lim) search.set('limit', String(lim));
  const qs = search.toString();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['mentions-archive', channelId, d, src, lim, rng?.from ?? null, rng?.to ?? null],
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) =>
      apiGet(`/api/history/mentions${qs ? `?${qs}` : ''}`, MentionsSchema, { signal, channelId }),
  });
}

/** Subscriber history (Postgres channel_daily). Default 730 days. */
export function useHistory(days = 730, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['history-channel', channelId, days],
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet(`/api/history/channel?days=${days}`, HistorySchema, { signal, channelId }),
  });
}

/** View-velocity snapshot (how fast posts accumulate reach). */
export function useVelocity(opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['velocity', channelId],
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/velocity', VelocitySchema, { signal, channelId }),
  });
}

// ── Instagram (per-channel OAuth token, or the global env account, or mock) ──
// Every IG query is keyed by the selected channel: IG is now per-channel, so switching the
// active channel must refetch (a bare ['ig-*'] key would show the previous channel's cached data).
export function useIgProfile(enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: ['ig-profile', channelId],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/profile', IgProfileSchema, { signal, channelId }),
  });
}

/** Fetch insights for the selected window. reach/follower come as a 90-day daily series (windowed
 *  client-side); the aggregate metrics (views/saves/…) are computed by the server for this exact
 *  window + the previous one (for deltas), since they have no daily series to slice. */
export function useIgInsights(days = 90, enabled = true) {
  const { channelId } = useSelectedChannel();
  // Explicit TData (useTgFull-style): the placeholderData callback otherwise degrades inference
  // for every `insightsQ.data` consumer.
  return useQuery<IgInsights>({
    enabled: enabled && channelId != null,
    queryKey: ['ig-insights', channelId, days],
    staleTime: STALE_LIVE,
    // A period change re-keys `days`; keep the previous window's data mounted while the new one
    // loads (same contract as useTgFull windowPair). Without it ig.loading flips to true and the
    // IG shell/metric page swaps the WHOLE view for a skeleton — the chart unmounts and the
    // MorphingSeries period morph never runs (owner report: «переход не как в shadcn»). The old
    // series re-windows client-side instantly, then the fresh response retargets the morph.
    // Never carry data across a channel switch — that would flash another source's metrics.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === channelId ? previous : undefined,
    queryFn: ({ signal }) => apiGet(`/api/ig/insights?days=${days}`, IgInsightsSchema, { signal, channelId }),
  });
}

export function useIgPosts(limit = 20, enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: ['ig-posts', channelId, limit],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/ig/posts?limit=${limit}`, IgPostsSchema, { signal, channelId }),
  });
}

/** Audience demographics + format/contact breakdowns (total_value envelope). */
export function useIgBreakdowns(timeframe = 'last_30_days', enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery<IgBreakdowns>({
    // enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: enabled && channelId != null,
    queryKey: ['ig-breakdowns', channelId, timeframe],
    staleTime: STALE_ARCHIVE,
    // Period switches re-key `timeframe` — hold the previous breakdowns for the same channel so
    // the Аудитория sections don't collapse to empty mid-switch (mirrors useIgInsights above).
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === channelId ? previous : undefined,
    queryFn: ({ signal }) => apiGet(`/api/ig/breakdowns?timeframe=${timeframe}`, IgBreakdownsSchema, { signal, channelId }),
  });
}

/** Online-followers hourly map (best-time heatmap). Degrades to empty gracefully. */
export function useIgOnline(enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: enabled && channelId != null,
    queryKey: ['ig-online', channelId],
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/online', IgOnlineSchema, { signal, channelId }),
  });
}

/** Active stories (last 24h) + per-story insights. */
export function useIgStories() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-stories', channelId],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/stories', IgStoriesSchema, { signal, channelId }),
  });
}

/** Tags — media where the account is @-tagged (live edge + DB archive). */
export function useIgTags() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ig-tags', channelId],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/tags', IgTagsSchema, { signal, channelId }),
  });
}

/** Persisted IG daily series (Postgres ig_daily) — the DB-first history the cron accumulates past
 *  the tiny live window. Disabled in demo mode (no DB, no fixture) so panels keep their live series. */
export function useIgHistory(days = 400, enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null && !isDemoMode(),
    queryKey: ['ig-history', channelId, days],
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet(`/api/ig/history?days=${days}`, IgHistorySchema, { signal, channelId }),
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
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/oauth/status', IgOauthStatusSchema, { signal, channelId }),
  });
}

/** Begin the connect flow: ask the server for an authorize_url, then hand the browser to Instagram
 *  (a top-level navigation — the session header can't survive the OAuth redirect).
 *  `mutate({ newSource: true })` connects the account as its OWN standalone source (a fresh
 *  channels row, source='ig') instead of attaching it to the selected channel. */
export function useConnectIg() {
  return useMutation({
    mutationFn: async (opts: { newSource?: boolean } | void) => {
      const path = opts && opts.newSource ? '/api/ig/oauth/start?new_source=1' : '/api/ig/oauth/start';
      const res = await apiSend('POST', path, undefined, IgConnectStartSchema);
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
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/tg/mtproto/post_stats/${id}`, PostStatsSchema, { signal, channelId }),
  });
}

// ── TG analytics ──
export function useTgStats() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['tg-stats', channelId],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/stats', StatsSchema, { signal, channelId }),
  });
}

export function useTgGraphs(opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['tg-graphs', channelId],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/graphs', GraphsSchema, { signal, channelId }),
  });
}

/**
 * Managed Telegram QR session health (GET /api/tg/qr/status). Per-USER, not per-channel (the server
 * scopes it to req.user.uid), so the key is bare ['tg-qr-status'] and it is SHARED: /connect owns the
 * live view, the Overview banner reads the same cache. On reconnect/disconnect /connect invalidates
 * this key so the Overview cannot keep showing a stale `reauth_required`. `enabled` lets the Overview
 * skip the fetch entirely for non-QR sources while its hook call stays unconditional. STALE_STATUS
 * (the freshness-status tier) matches the other health polls (collector-status).
 */
export function useTgQrStatus(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['tg-qr-status'],
    staleTime: STALE_STATUS,
    queryFn: ({ signal }) => apiGet('/api/tg/qr/status', TgQrStatusSchema, { signal }),
  });
}

// ── Account cluster: channels / keys / admin / bugs ──
const OkSchema = z.object({ ok: z.boolean() }).passthrough();

export function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/channels', ChannelsResponseSchema, { signal }),
  });
}

// ── «МойСклад» (source='ms'): сервер-агрегированные отчёты, все суммы уже в РУБЛЯХ ──────────
const MsRevenuePointSchema = z.object({ day: z.string(), value: z.number() }).passthrough();
const MsOrdersPointSchema = z.object({ day: z.string(), sum: z.number(), count: z.number() }).passthrough();
const MsSummarySchema = z
  .object({
    revenue: z.object({ total: z.number(), series: z.array(MsRevenuePointSchema) }).passthrough(),
    orders: z.object({ totalSum: z.number(), totalCount: z.number(), series: z.array(MsOrdersPointSchema) }).passthrough(),
  })
  .passthrough();
// Additive-сводка концентрации: считается сервером по ПОЛНОМУ raw-отчёту до limit. null =
// отчёт усечён/неполон (честно недоступна). Доли/маржа = null при неположительном знаменателе.
const MsTopSummarySchema = z
  .object({
    complete: z.boolean(),
    product_count: z.number(),
    top_n: z.number(),
    revenue_positive_total: z.number(),
    profit_positive_total: z.number(),
    revenue_top10_share_pct: z.number().nullable(),
    profit_top10_share_pct: z.number().nullable(),
    net_margin_pct: z.number().nullable(),
    loss_making_count: z.number(),
    loss_making_amount: z.number(),
  })
  .passthrough();
export type MsTopSummary = z.infer<typeof MsTopSummarySchema>;

// Сравнение ассортимента с предыдущим равным окном (opt-in compare=prev). Все величины уже в
// натуральной единице метрики: rub — рубли (сервер конвертировал копейки на границе), count — штуки.
// deltaPct честно null, когда предыдущая база <= 0 (ноль не даёт конечного процента, отрицательная
// прибыль не имеет однозначной процентной интерпретации). Сопоставление и вывод
// предыдущего окна — на сервере; фронт только рендерит.
const MsMoverSchema = z
  .object({
    name: z.string(),
    current: z.number(),
    previous: z.number(),
    delta: z.number(),
    deltaPct: z.number().nullable(),
  })
  .passthrough();
const MsMetricComparisonSchema = z
  .object({
    unit: z.enum(['rub', 'count']),
    gainers: z.array(MsMoverSchema),
    losers: z.array(MsMoverSchema),
    appeared: z.array(MsMoverSchema),
    disappeared: z.array(MsMoverSchema),
  })
  .passthrough();
export type MsMetricComparison = z.infer<typeof MsMetricComparisonSchema>;
const MsAssortmentComparisonSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }).passthrough(),
  z
    .object({
      available: z.literal(true),
      partial: z.boolean(),
      identity_fallback_count: z.number(),
      current: z.object({ from: z.string(), to: z.string() }).passthrough(),
      previous: z.object({ from: z.string(), to: z.string() }).passthrough(),
      counts: z.object({ current_only: z.number(), previous_only: z.number(), both: z.number() }).passthrough(),
      metrics: z.object({
        revenue: MsMetricComparisonSchema,
        profit: MsMetricComparisonSchema,
        units: MsMetricComparisonSchema,
      }),
      limit: z.number(),
    })
    .passthrough(),
]);
export type MsAssortmentComparison = z.infer<typeof MsAssortmentComparisonSchema>;

const MsTopProductsSchema = z
  .object({
    rows: z.array(
      z
        .object({
          name: z.string(),
          quantity: z.number(),
          revenue: z.number(),
          profit: z.number(),
          margin: z.number().nullable(),
        })
        .passthrough(),
    ),
    total: z.number().optional(),
    truncated: z.boolean().optional(),
    summary: MsTopSummarySchema.nullable().optional(),
    comparison: MsAssortmentComparisonSchema.optional(),
  })
  .passthrough();

const MsStatusSchema = z.object({ connected: z.boolean(), org_name: z.string().nullable().optional() }).passthrough();

export function useMsStatus() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-status', channelId],
    staleTime: STALE_STATUS,
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/ms/status', MsStatusSchema, { signal, channelId }),
  });
}

// ── «Яндекс.Метрика» (source='ym'): сервер-агрегированные дневные отчёты счётчика ────────────
const YmSeriesBlockSchema = z
  .object({ total: z.number(), series: z.array(z.object({ day: z.string(), value: z.number() }).passthrough()) })
  .passthrough();
const YmSummarySchema = z
  .object({ visits: YmSeriesBlockSchema, users: YmSeriesBlockSchema, pageviews: YmSeriesBlockSchema })
  .passthrough();
const YmSourcesSchema = z
  .object({
    visits_total: z.number(),
    users_total: z.number(),
    rows: z.array(
      z
        .object({ id: z.string().nullable(), name: z.string().nullable(), visits: z.number(), users: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();
const YmStatusSchema = z
  .object({
    connected: z.boolean(),
    counter_name: z.string().nullable().optional(),
    counter_id: z.string().nullable().optional(),
    site: z.string().nullable().optional(),
  })
  .passthrough();

export function useYmStatus() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ym-status', channelId],
    staleTime: STALE_STATUS,
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/ym/status', YmStatusSchema, { signal, channelId }),
  });
}

// Период Метрики сериализуется тем же feed-топбаром, что у МС (msPeriodQuery/msPeriodKey —
// сете-агностичные хелперы окна): одна система координат окон на все не-социальные источники.
export function useYmSummary(period: MsPeriod, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['ym-summary', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ym/summary?${msPeriodQuery(period)}`, YmSummarySchema, { signal, channelId }),
  });
}

export function useYmSources(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ym-sources', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ym/sources?${msPeriodQuery(period)}`, YmSourcesSchema, { signal, channelId }),
  });
}

// Слайс 2: цели (reaches + conversionRate — отдельная метрика, из reaches не выводится),
// топ-страницы (hits-неймспейс, просмотры ≠ визиты) и utm_source-разрез с честным хвостом
// неразмеченных визитов.
const YmGoalsSchema = z
  .object({
    rows: z.array(
      z
        .object({ id: z.string(), name: z.string().nullable(), reaches: z.number(), conversion_rate: z.number() })
        .passthrough(),
    ),
    truncated: z.boolean(),
  })
  .passthrough();
const YmPagesSchema = z
  .object({
    pageviews_total: z.number(),
    rows: z.array(z.object({ path: z.string(), pageviews: z.number(), users: z.number() }).passthrough()),
  })
  .passthrough();
const YmUtmSchema = z
  .object({
    visits_total: z.number(),
    tagged_visits: z.number(),
    untagged_visits: z.number(),
    rows: z.array(
      z
        .object({ id: z.string().nullable(), name: z.string().nullable(), visits: z.number(), users: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();

export function useYmGoals(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ym-goals', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ym/goals?${msPeriodQuery(period)}`, YmGoalsSchema, { signal, channelId }),
  });
}

export function useYmPages(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ym-pages', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ym/pages?${msPeriodQuery(period)}`, YmPagesSchema, { signal, channelId }),
  });
}

export function useYmUtm(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ym-utm', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ym/utm?${msPeriodQuery(period)}`, YmUtmSchema, { signal, channelId }),
  });
}

const MsBackfillStatusSchema = z
  .object({
    status: z.string(),
    fetched: z.number(),
    total: z.number().nullable().optional(),
    cursor_month: z.string().nullable().optional(),
    orders_in_db: z.number().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
type MsBackfillStatus = z.infer<typeof MsBackfillStatusSchema>;

export function useMsBackfillStatus(enabled: boolean, pollAnyway = false) {
  const { channelId } = useSelectedChannel();
  // Явные дженерики обязательны: inline-refetchInterval, читающий query.state.data,
  // зацикливает вывод TQueryFnData и схлопывает тип данных в {}.
  return useQuery<MsBackfillStatus, Error>({
    enabled: enabled && channelId != null,
    queryKey: ['ms-backfill', channelId],
    retry: false,
    // Живой прогресс: опрос каждые 2с пока история грузится ИЛИ пока вызывающий ждёт старта
    // (pollAnyway): движок пишет running-строку только ПОСЛЕ живой оценки объёма (~секунда),
    // и без внешнего толчка интервал не завёлся бы вовсе — кнопка выглядела мёртвой (прод-фидбек).
    refetchInterval: (query) => (pollAnyway || query.state.data?.status === 'running' ? 2000 : false),
    queryFn: ({ signal }) => apiGet('/api/ms/backfill-status', MsBackfillStatusSchema, { signal, channelId }),
  });
}

// ── МойСклад, слайс 3: аналитика архива заказов (все суммы уже В РУБЛЯХ с бэка) ──
const MsFunnelSchema = z
  .object({
    window_days: z.number(),
    total_orders: z.number(),
    no_state_orders: z.number(),
    no_state_sum: z.number(),
    rows: z.array(
      z
        .object({
          state_id: z.string(),
          name: z.string().nullable(),
          color: z.string().nullable(),
          orders: z.number(),
          sum: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsFunnel(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-funnel', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/funnel?${msPeriodQuery(period)}`, MsFunnelSchema, { signal, channelId }),
  });
}

const MsCustomersSchema = z
  .object({
    window_days: z.number(),
    summary: z
      .object({
        customers: z.number(),
        new_customers: z.number(),
        repeat_customers: z.number(),
        orders_new: z.number(),
        orders_repeat: z.number(),
        sum_new: z.number(),
        sum_repeat: z.number(),
        no_agent_orders: z.number(),
        repeat_ever: z.number(),
      })
      .passthrough(),
    series: z.array(
      z
        .object({
          day: z.string(),
          new_orders: z.number(),
          repeat_orders: z.number(),
          sum_new: z.number(),
          sum_repeat: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsCustomers(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-customers', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/customers?${msPeriodQuery(period)}`, MsCustomersSchema, { signal, channelId }),
  });
}

const MsRfmSchema = z
  .object({
    window_days: z.number(),
    as_of: z.string().nullable(),
    customers: z.number(),
    no_agent_orders: z.number(),
    total_orders: z.number(),
    total_sum: z.number(),
    segments: z.array(
      z
        .object({
          key: z.enum(['champions', 'loyal', 'potential', 'new', 'at_risk', 'hibernating']),
          customers: z.number(),
          orders: z.number(),
          sum: z.number(),
          average_recency_days: z.number().nullable(),
          average_frequency: z.number().nullable(),
          average_monetary: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type MsRfm = z.infer<typeof MsRfmSchema>;

export function useMsRfm(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-rfm', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/rfm?${msPeriodQuery(period)}`, MsRfmSchema, { signal, channelId }),
  });
}

// Покупатели одного RFM-сегмента — в отличие от агрегатного /api/ms/rfm это сознательный
// tenant-scoped листинг. name/address резолвит живой словарь counterparty только для строк
// страницы; при сбое словаря бэк честно отдаёт name/address = null (и не кэширует ответ).
const MsRfmCustomersSchema = z
  .object({
    window_days: z.number(),
    as_of: z.string().nullable(),
    segment: z.string(),
    // Покупателей в ЭТОМ сегменте за окно (после фильтра, до пагинации) — опора «Показать ещё».
    total_customers: z.number(),
    rows: z.array(
      z
        .object({
          agent_id: z.string(),
          name: z.string().nullable(),
          address: z.string().nullable(),
          // Контакты из того же словаря counterparty; при деградации словаря — null.
          phone: z.string().nullable(),
          email: z.string().nullable(),
          // Город ПОСЛЕДНЕГО заказа клиента с непустым city (архив ms_orders); null если нет.
          city: z.string().nullable(),
          orders: z.number(),
          sum: z.number(),
          last_day: z.string(),
          recency_days: z.number(),
          r: z.number(),
          f: z.number(),
          m: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type MsRfmCustomers = z.infer<typeof MsRfmCustomersSchema>;

/** Размер страницы листинга покупателей сегмента (совпадает с серверным дефолтом limit=50). */
export const MS_RFM_CUSTOMERS_PAGE = 50;

/** Страница покупателей выбранного RFM-сегмента; `segment == null` — сегмент не выбран, запрос не идёт. */
export function useMsRfmSegmentCustomers(period: MsPeriod, segment: string | null, offset: number) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null && segment != null,
    queryKey: ['ms-rfm-customers', channelId, ...msPeriodKey(period), segment, offset],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(
        `/api/ms/rfm-customers?${msPeriodQuery(period)}&segment=${encodeURIComponent(segment ?? '')}&limit=${MS_RFM_CUSTOMERS_PAGE}&offset=${offset}`,
        MsRfmCustomersSchema,
        { signal, channelId },
      ),
  });
}

/** Императивная страница ТОГО ЖЕ листинга для CSV-выгрузки сегмента. Прямой apiGet, мимо кэша
    React Query: у выгрузки свой limit, и запись её страниц под ключи интерактивного листинга
    (limit=50) подсунула бы «Показать ещё» чужие по размеру страницы. */
export function fetchMsRfmCustomersPage(
  channelId: number,
  period: MsPeriod,
  segment: string,
  limit: number,
  offset: number,
): Promise<MsRfmCustomers> {
  return apiGet(
    `/api/ms/rfm-customers?${msPeriodQuery(period)}&segment=${encodeURIComponent(segment)}&limit=${limit}&offset=${offset}`,
    MsRfmCustomersSchema,
    { channelId },
  );
}

const MsCohortsSchema = z
  .object({
    cohorts: z.array(
      z
        .object({
          cohort_month: z.string(),
          size: z.number(),
          // revenue — выручка заказов клиентов когорты в offset-месяце, В РУБЛЯХ (граница API уже
          // сконвертировала копейки). active/size сохранены для ретеншена и старых вызывающих.
          cells: z.array(z.object({ offset: z.number(), active: z.number(), revenue: z.number().nullable() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsCohorts() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-cohorts', channelId],
    staleTime: STALE_ARCHIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet('/api/ms/cohorts', MsCohortsSchema, { signal, channelId }),
  });
}

const MsSalesByChannelSchema = z
  .object({
    window_days: z.number(),
    total_orders: z.number(),
    no_channel_orders: z.number(),
    // Выручка заказов без канала (синтетическая строка «Без канала» на странице вклада каналов).
    no_channel_sum: z.number(),
    rows: z.array(
      z
        .object({
          sales_channel_id: z.string(),
          name: z.string().nullable(),
          type: z.string().nullable(),
          orders: z.number(),
          sum: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsSalesByChannel(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-sales-by-channel', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(`/api/ms/sales-by-channel?${msPeriodQuery(period)}`, MsSalesByChannelSchema, { signal, channelId }),
  });
}

const MsDayPointSchema = z.object({ day: z.string(), orders: z.number(), sum: z.number() }).passthrough();
const MsChannelSeriesSchema = z
  .object({
    window_days: z.number(),
    // Echo of the selected channel ids (null = all channels aggregated).
    channels: z.array(z.string()).nullable(),
    // AGGREGATE series over the selected channels (or all) — the Steep «filter = aggregate» view.
    series: z.array(MsDayPointSchema),
    // Per-channel series, present only when Breakdown is requested; bounded server-side.
    groups: z
      .array(z.object({ sales_channel_id: z.string(), series: z.array(MsDayPointSchema) }).passthrough())
      .nullable()
      .optional(),
    // How many separate series the server rendered vs how many the caller asked for — lets the UI
    // state the limit honestly rather than silently dropping channels.
    group_limit: z.number().optional(),
    group_total: z.number().optional(),
  })
  .passthrough();
export type MsChannelSeries = z.infer<typeof MsChannelSeriesSchema>;

/** Daily revenue/orders series for the sales-channel axis. `channels` empty = all channels
    aggregated (the default). `breakdown` asks the server for per-channel series (bounded). */
export function useMsChannelSeries(period: MsPeriod, opts: { channels: string[]; breakdown: boolean }) {
  const { channelId } = useSelectedChannel();
  const channels = [...opts.channels].sort();
  const breakdown = opts.breakdown && channels.length > 0;
  const channelParam = channels.length > 0 ? `&channels=${encodeURIComponent(channels.join(','))}` : '';
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-channel-series', channelId, ...msPeriodKey(period), channels.join(',') || 'all', breakdown],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(
        `/api/ms/channel-series?${msPeriodQuery(period)}${channelParam}${breakdown ? '&breakdown=1' : ''}`,
        MsChannelSeriesSchema,
        { signal, channelId },
      ),
  });
}

const MsGeographySchema = z
  .object({
    window_days: z.number(),
    total_orders: z.number(),
    no_city_orders: z.number(),
    rows: z.array(z.object({ city: z.string(), orders: z.number(), sum: z.number() }).passthrough()),
  })
  .passthrough();

export function useMsGeography(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-geography', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/geography?${msPeriodQuery(period)}`, MsGeographySchema, { signal, channelId }),
  });
}

const MsTopCustomersSchema = z
  .object({
    window_days: z.number(),
    rows: z.array(
      z
        .object({ agent_id: z.string(), name: z.string().nullable(), orders: z.number(), sum: z.number() })
        .passthrough(),
    ),
  })
  .passthrough();

export function useMsTopCustomers(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-top-customers', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/top-customers?${msPeriodQuery(period)}`, MsTopCustomersSchema, { signal, channelId }),
  });
}

const MsReturnsSchema = z
  .object({
    window_days: z.number(),
    archive_status: z.enum(['pending', 'idle', 'running', 'done', 'error']),
    complete: z.boolean(),
    archived_count: z.number(),
    total_estimate: z.number().nullable(),
    count: z.number(),
    sum: z.number(),
    // Дневная серия архива (только дни с возвратами; фронт дозаполняет календарь нулями). Сумма
    // уже в рублях. Возвраты считаются ОТДЕЛЬНО и из выручки заказов не вычитаются.
    series: z.array(z.object({ day: z.string(), count: z.number(), sum: z.number() }).passthrough()).default([]),
  })
  .passthrough();

export function useMsReturns(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-returns', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/returns?${msPeriodQuery(period)}`, MsReturnsSchema, { signal, channelId }),
  });
}

export function useMsSummary(period: MsPeriod, opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: ['ms-summary', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/summary?${msPeriodQuery(period)}`, MsSummarySchema, { signal, channelId }),
  });
}

export type MsProductSort = 'revenue' | 'profit' | 'margin';

export function useMsTopProducts(period: MsPeriod, limit = 10, sort: MsProductSort = 'revenue', enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: ['ms-top-products', channelId, ...msPeriodKey(period), limit, sort],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(`/api/ms/top-products?${msPeriodQuery(period)}&limit=${limit}&sort=${sort}`, MsTopProductsSchema, { signal, channelId }),
  });
}

/**
 * Сравнение ассортимента текущего окна с предыдущим равным (compare=prev). Отдельный хук с `enabled`-
 * гейтом, чтобы компактная карточка «Товаров» НИКОГДА не запрашивала сравнение — только полная
 * страница на вкладке «Динамика». Сервер отдаёт сразу три метрики (выручка/прибыль/штуки), поэтому
 * ключ окна-независим от выбранной метрики: переключение показателя не рефетчит и не плодит ключей.
 * `limit=1` держит легаси-rows минимальными — списки движений приходят из comparison, а не из rows.
 */
export function useMsAssortmentComparison(period: MsPeriod, enabled: boolean) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: ['ms-top-products-compare', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(`/api/ms/top-products?${msPeriodQuery(period)}&limit=1&compare=prev`, MsTopProductsSchema, { signal, channelId }),
  });
}

const MsStockSchema = z
  .object({
    window_days: z.number(),
    // Сервер сортирует по срочности (days_left ASC NULLS LAST → stock ASC) и отдаёт первые
    // 200 строк; days_left=null — товар без продаж за окно («нет продаж», не бесконечность).
    rows: z.array(
      z
        .object({
          id: z.string().nullable(),
          name: z.string().nullable(),
          stock: z.number(),
          reserve: z.number(),
          days_left: z.number().nullable(),
          sold_window: z.number(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type MsStock = z.infer<typeof MsStockSchema>;
export type MsStockRow = MsStock['rows'][number];

/** Остатки «что заканчивается»: живой отчёт склада + скорость продаж выбранного окна. Окно
    ОБЯЗАНО быть конечным — «Всё» (days=0 без диапазона) сервер отвечает 400, вызывающие
    подменяют его конечным 30-дневным окном. */
export function useMsStock(period: MsPeriod) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: ['ms-stock', channelId, ...msPeriodKey(period)],
    staleTime: STALE_LIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/ms/stock?${msPeriodQuery(period)}`, MsStockSchema, { signal, channelId }),
  });
}

// ── Аннотации-события трендов (chart_annotations): флажки «реклама / пост-хит» на графике ────
const AnnotationSchema = z.object({ id: z.number(), day: z.string(), label: z.string() }).passthrough();
const AnnotationsResponseSchema = z.object({ annotations: z.array(AnnotationSchema).default([]) }).passthrough();
export type ChartAnnotation = z.infer<typeof AnnotationSchema>;

export function useAnnotations(channelId: number | null) {
  return useQuery({
    enabled: channelId != null,
    queryKey: ['annotations', channelId],
    staleTime: STALE_ARCHIVE,
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/channels/${channelId}/annotations`, AnnotationsResponseSchema, { signal }),
  });
}

export function useChannelKeys(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['channel-keys', id],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) =>
      apiGet(`/api/channels/${id}/keys`, z.object({ keys: z.array(KeySchema) }).passthrough(), { signal }),
  });
}

export function useCollectorStatus(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['collector-status', id],
    staleTime: STALE_STATUS,
    queryFn: ({ signal }) => apiGet(`/api/channels/${id}/collector-status`, CollectorStatusResponseSchema, { signal }),
  });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin-users'],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/admin/users', AdminUsersResponseSchema, { signal }),
  });
}

export function useBugs() {
  return useQuery({
    queryKey: ['bugs'],
    staleTime: STALE_LIVE,
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

/** GDPR F4 (admin-путь): стирание чужого аккаунта из панели. Суперюзеров сервер не удаляет. */
export function useAdminDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/admin/users/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
}

/**
 * GDPR F4 (self-serve): немедленный hard-delete собственного аккаунта. `confirm` — email
 * аккаунта (подтверждение намерения; пароль не годится — Google-аккаунты живут без него).
 * После успеха сессия мертва и на сервере (users-строки больше нет) — чистим локально и
 * сбрасываем весь кэш; редирект — на вызывающей стороне.
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  const { setChannelId } = useSelectedChannel();
  return useMutation({
    mutationFn: (confirm: string) => apiSend('DELETE', '/api/account', { confirm }, OkSchema),
    onSuccess: () => {
      clearSessionToken();
      setChannelId(null);
      qc.clear();
    },
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

// ── Reports (saved multi-report documents) ──
// Per-USER, not per-channel: no X-Channel-Id key — ownership is enforced server-side (uid in SQL).

export type ReportSchedule = 'none' | 'weekly' | 'monthly';

/** The saved-reports index. `enabled:false` lets demo mode skip the fetch (no fixture exists). */
export function useReports(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['reports'],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/reports', ReportsResponseSchema, { signal }),
  });
}

/** One report with its full config (the composed document). 404 on a foreign/missing id. */
export function useReport(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: ['report', id],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/reports/${id}`, ReportResponseSchema, { signal }),
  });
}

export function useCreateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; config?: ReportConfig; schedule?: ReportSchedule }) =>
      apiSend('POST', '/api/reports', body, ReportResponseSchema),
    onSuccess: (data) => {
      // Seed the detail cache so the follow-up navigate renders without a refetch.
      qc.setQueryData(['report', data.report.id], data);
      return qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useUpdateReport(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; config?: ReportConfig; schedule?: ReportSchedule }) =>
      apiSend('PUT', `/api/reports/${id}`, body, ReportResponseSchema),
    onSuccess: (data) => {
      // The PUT echoes the full report — write it straight into the detail cache (no refetch
      // after every debounced config save) and refresh the list (name / updated_at ordering).
      qc.setQueryData(['report', id], data);
      return qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/reports/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports'] }),
  });
}

// ── Campaigns («Кампании и группы контента») ──
// Доступ остаётся workspace-scoped, а выбранный channelId определяет workspace списка. Поэтому
// один и тот же пользователь не смешивает кампании разных команд в одном селекторе.

export function useCampaigns(channelId: number | null = null) {
  return useQuery({
    enabled: !isDemoMode() && channelId != null,
    queryKey: ['campaigns', channelId],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/campaigns?channel_id=${channelId}`, CampaignsResponseSchema, { signal }),
  });
}

export function useCampaign(id: number | null) {
  return useQuery({
    enabled: id != null && !isDemoMode(),
    queryKey: ['campaign', id],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/campaigns/${id}`, CampaignResponseSchema, { signal }),
  });
}

/** Публикации кампании, обогащённые метриками на сервере, — единственный источник membership
    для фильтра «Контента» (никаких параллельных чтений по компонентам). */
export function useCampaignPosts(id: number | null) {
  return useQuery({
    enabled: id != null && !isDemoMode(),
    queryKey: ['campaign-posts', id],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/campaigns/${id}/posts`, CampaignPostsResponseSchema, { signal }),
  });
}

export function useCampaignSummary(
  id: number | null,
  source: CampaignSourceScope | null = null,
  enabled = true,
) {
  const scopeKey = source ? `${source.network}:${source.channelId}` : 'all';
  const query = source
    ? `?network=${encodeURIComponent(source.network)}&channel_id=${source.channelId}`
    : '';
  return useQuery({
    enabled: enabled && id != null && !isDemoMode(),
    queryKey: ['campaign-summary', id, scopeKey],
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/campaigns/${id}/summary${query}`, CampaignSummaryResponseSchema, { signal }),
  });
}

export interface CampaignBody {
  name?: string;
  description?: string;
  color?: string | null;
  status?: CampaignStatus;
  start_date?: string | null;
  end_date?: string | null;
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignBody & { name: string; channel_id: number }) =>
      apiSend('POST', '/api/campaigns', body, CampaignResponseSchema),
    onSuccess: (data) => {
      qc.setQueryData(['campaign', data.campaign.id], data);
      return qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useUpdateCampaign(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignBody) => apiSend('PATCH', `/api/campaigns/${id}`, body, CampaignResponseSchema),
    onSuccess: (data) => {
      qc.setQueryData(['campaign', id], data);
      // Сводка несёт копию campaign-строки в заголовке — обновляем и её.
      qc.invalidateQueries({ queryKey: ['campaign-summary', id] });
      return qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/campaigns/${id}`, undefined, OkSchema),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: ['campaign', id] });
      qc.removeQueries({ queryKey: ['campaign-posts', id] });
      qc.removeQueries({ queryKey: ['campaign-summary', id] });
      return qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

/** campaignId — в variables (не в замыкании хука): диалог «Добавить в кампанию» выбирает цель динамически. */
export function useAddCampaignPosts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, items }: { campaignId: number; items: CampaignPostInput[] }) =>
      apiSend('POST', `/api/campaigns/${campaignId}/posts`, { items }, CampaignAddResultSchema),
    onSuccess: (_data, { campaignId }) => {
      qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
      qc.invalidateQueries({ queryKey: ['campaign-posts', campaignId] });
      qc.invalidateQueries({ queryKey: ['campaign-summary', campaignId] });
      return qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useRemoveCampaignPosts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, items }: { campaignId: number; items: CampaignPostInput[] }) =>
      apiSend('DELETE', `/api/campaigns/${campaignId}/posts`, { items }, CampaignRemoveResultSchema),
    onSuccess: (_data, { campaignId }) => {
      qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
      qc.invalidateQueries({ queryKey: ['campaign-posts', campaignId] });
      qc.invalidateQueries({ queryKey: ['campaign-summary', campaignId] });
      return qc.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}
