import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STALE_ARCHIVE, STALE_LIVE, STALE_STATUS } from '@/api/policy';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import { qk } from '@/api/queryKeys';
import { keepPreviousForChannel } from '@/api/keepPrevious';
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
  MentionNotifyLinkSchema,
  MentionNotifyRunSchema,
  MentionNotifyStatusSchema,
  MentionNotifySubscriptionSchema,
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
import { isDemoMode } from '@/lib/demo';
import { useSelectedChannel } from '@/lib/channel-context';
import { effectiveLimit, usePeriod } from '@/lib/period';
import type { DateRange, PeriodDays } from '@/lib/period';

/** Current session. retry:false so a 401 surfaces immediately (→ login gate). */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}
export function useRemoveAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('DELETE', '/api/me/avatar', undefined, AuthOkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
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

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiSend('POST', '/api/auth/login', body, LoginResponseSchema),
    onSuccess: () => qc.invalidateQueries(),
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
  return useMutation({
    mutationFn: () => apiSend('POST', '/api/auth/logout', undefined, AuthOkSchema),
    onSuccess: () => {
      setChannelId(null);
      // Keep this mutation alive until its per-call onSuccess navigation fires.
      qc.getQueryCache().clear();
    },
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
    queryKey: qk.mentions(channelId),
    queryFn: ({ signal }) => apiGet('/api/tg/mtproto/mentions', MentionsSchema, { signal, channelId }),
  });
}

/** Per-selected-channel Telegram mention rules. Reading is viewer-safe; writes are owner/admin. */
export function useMentionSettings() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.mentionSettings(channelId),
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
      qc.setQueryData(qk.mentionSettings(channelId), data);
      return qc.invalidateQueries({ queryKey: qk.mentions(channelId) });
    },
  });
}

/**
 * Личные уведомления об упоминаниях: статус привязки бота + подписки выбранного канала.
 * `poll` включает refetchInterval — диалог ждёт нажатия Start в Telegram после deep-link'а.
 */
export function useMentionNotifyStatus(poll = false) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.mentionNotify(channelId),
    staleTime: STALE_STATUS,
    retry: false,
    refetchInterval: poll ? 3000 : false,
    // Диалог монтируется только по клику: всегда тянем свежий статус, иначе закрытие до
    // подтверждения привязки показывает при повторном открытии устаревшее «не привязан».
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      apiGet('/api/tg/mention-notify', MentionNotifyStatusSchema, { signal, channelId }),
  });
}

/** Выдать deep-link t.me/<bot>?start=… для привязки личного чата с ботом. */
export function useMentionNotifyLink() {
  return useMutation({
    mutationFn: () => apiSend('POST', '/api/tg/mention-notify/link', {}, MentionNotifyLinkSchema),
  });
}

/** Тумблер + расписание личной подписки на упоминания выбранного канала. */
export function useSetMentionNotify() {
  const { channelId } = useSelectedChannel();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled: boolean; send_days?: number[]; send_hour?: number }) => {
      if (channelId == null) return Promise.reject(new Error('Сначала выберите канал'));
      return apiSend('PUT', '/api/tg/mention-notify', body, MentionNotifySubscriptionSchema, { channelId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mentionNotify(channelId) }),
  });
}

/** Ручной тест-прогон «Прислать сейчас» — тратит квоту searchPosts подписчика вне планового дня. */
export function useRunMentionNotify() {
  const { channelId } = useSelectedChannel();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (channelId == null) return Promise.reject(new Error('Сначала выберите канал'));
      return apiSend('POST', '/api/tg/mention-notify/run', {}, MentionNotifyRunSchema, { channelId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mentionNotify(channelId) }),
  });
}

/** Отвязать личный чат с ботом (подписки замолкают до новой привязки). */
export function useUnbindMentionNotify() {
  const { channelId } = useSelectedChannel();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('DELETE', '/api/tg/mention-notify/binding', undefined, AuthOkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mentionNotify(channelId) }),
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
    queryKey: qk.mentionsArchive.window(channelId, d, src, lim, rng?.from ?? null, rng?.to ?? null),
    staleTime: STALE_ARCHIVE,
    placeholderData: keepPreviousForChannel(channelId),
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
    queryKey: qk.historyChannel.window(channelId, days),
    staleTime: STALE_ARCHIVE,
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/history/channel?days=${days}`, HistorySchema, { signal, channelId }),
  });
}

/** View-velocity snapshot (how fast posts accumulate reach). */
export function useVelocity(opts?: { enabled?: boolean }) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // opts.enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: channelId != null && opts?.enabled !== false,
    queryKey: qk.velocity(channelId),
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
    queryKey: qk.ig.profile(channelId),
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
    queryKey: qk.ig.insights(channelId, days),
    staleTime: STALE_LIVE,
    // A period change re-keys `days`; keep the previous window's data mounted while the new one
    // loads (same contract as useTgFull windowPair). Without it ig.loading flips to true and the
    // IG shell/metric page swaps the WHOLE view for a skeleton — the chart unmounts and the
    // MorphingSeries period morph never runs (owner report: «переход не как в shadcn»). The old
    // series re-windows client-side instantly, then the fresh response retargets the morph.
    // Never carry data across a channel switch — that would flash another source's metrics.
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ig/insights?days=${days}`, IgInsightsSchema, { signal, channelId }),
  });
}

export function useIgPosts(limit = 20, enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: enabled && channelId != null,
    queryKey: qk.ig.posts(channelId, limit),
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
    queryKey: qk.ig.breakdowns(channelId, timeframe),
    staleTime: STALE_ARCHIVE,
    // Period switches re-key `timeframe` — hold the previous breakdowns for the same channel so
    // the Аудитория sections don't collapse to empty mid-switch (mirrors useIgInsights above).
    placeholderData: keepPreviousForChannel(channelId),
    queryFn: ({ signal }) => apiGet(`/api/ig/breakdowns?timeframe=${timeframe}`, IgBreakdownsSchema, { signal, channelId }),
  });
}

/** Online-followers hourly map (best-time heatmap). Degrades to empty gracefully. */
export function useIgOnline(enabled = true) {
  const { channelId } = useSelectedChannel();
  return useQuery({
    // enabled — внешний гейт поверх канального (офскрин-виджеты Главной), queryKey прежний.
    enabled: enabled && channelId != null,
    queryKey: qk.ig.online(channelId),
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/online', IgOnlineSchema, { signal, channelId }),
  });
}

/** Active stories (last 24h) + per-story insights. */
export function useIgStories() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.ig.stories(channelId),
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/ig/stories', IgStoriesSchema, { signal, channelId }),
  });
}

/** Tags — media where the account is @-tagged (live edge + DB archive). */
export function useIgTags() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.ig.tags(channelId),
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
    queryKey: qk.ig.history(channelId, days),
    staleTime: STALE_ARCHIVE,
    placeholderData: keepPreviousForChannel(channelId),
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
    // Срок токена в машинном виде. Дефолт 'ok' — совместимость со старым ответом сервера (кэш
    // страницы переживает деплой): отсутствие поля не должно рисовать тревогу на живом аккаунте.
    token_state: z.enum(['none', 'ok', 'expiring', 'expired']).default('ok'),
  })
  .passthrough();
export type IgOauthStatus = z.infer<typeof IgOauthStatusSchema>;
const IgConnectStartSchema = z.object({ authorize_url: z.string().url() }).passthrough();

/** Connection state for the current channel (Settings + connect panel). No token is ever exposed. */
export function useIgOauthStatus() {
  const { channelId } = useSelectedChannel();
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.ig.oauthStatus(channelId),
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
  const { channelId } = useSelectedChannel();
  return useMutation({
    mutationFn: () => apiSend('DELETE', '/api/ig/oauth', undefined, OkSchema),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.channels }),
        // Префикс семьи вместо строкового predicate: сбрасывается IG ЭТОГО канала, а не всех
        // сразу. Отключение поканальное (DELETE идёт с x-channel-id), и сбрасывать чужие
        // аккаунты было лишним — они просто перезапрашивались без причины.
        qc.invalidateQueries({ queryKey: qk.ig.all(channelId) }),
      ]),
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
    queryKey: qk.tgQrStatus,
    staleTime: STALE_STATUS,
    queryFn: ({ signal }) => apiGet('/api/tg/qr/status', TgQrStatusSchema, { signal }),
  });
}

// ── Account cluster: channels / keys / admin / bugs ──
const OkSchema = z.object({ ok: z.boolean() }).passthrough();

export function useChannels() {
  return useQuery({
    queryKey: qk.channels,
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/channels', ChannelsResponseSchema, { signal }),
  });
}

// ── Аннотации-события трендов (chart_annotations): флажки «реклама / пост-хит» на графике ────
const AnnotationSchema = z.object({ id: z.number(), day: z.string(), label: z.string() }).passthrough();
const AnnotationsResponseSchema = z.object({ annotations: z.array(AnnotationSchema).default([]) }).passthrough();
export type ChartAnnotation = z.infer<typeof AnnotationSchema>;

export function useAnnotations(channelId: number | null) {
  return useQuery({
    enabled: channelId != null,
    queryKey: qk.annotations(channelId),
    staleTime: STALE_ARCHIVE,
    queryFn: ({ signal }) => apiGet(`/api/channels/${channelId}/annotations`, AnnotationsResponseSchema, { signal }),
  });
}

export function useChannelKeys(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: qk.channelKeys(id),
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) =>
      apiGet(`/api/channels/${id}/keys`, z.object({ keys: z.array(KeySchema) }).passthrough(), { signal }),
  });
}

export function useCollectorStatus(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: qk.collectorStatus(id),
    staleTime: STALE_STATUS,
    queryFn: ({ signal }) => apiGet(`/api/channels/${id}/collector-status`, CollectorStatusResponseSchema, { signal }),
  });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: qk.adminUsers,
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/admin/users', AdminUsersResponseSchema, { signal }),
  });
}

export function useBugs() {
  return useQuery({
    queryKey: qk.bugs,
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/bugs', BugsResponseSchema, { signal }),
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string }) => apiSend('POST', '/api/channels', body, ChannelSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/channels/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
  });
}

export function useCreateKey(channelId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label: string }) => apiSend('POST', `/api/channels/${channelId}/key`, body, CreateKeyResponseSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelKeys(channelId) }),
  });
}

export function useRevokeKey(channelId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => apiSend('DELETE', `/api/channels/${channelId}/key/${keyId}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelKeys(channelId) }),
  });
}

export function useUpdateUser(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { role?: string; status?: string }) => apiSend('PATCH', `/api/admin/users/${id}`, body, AdminUserSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  });
}

/** GDPR F4 (admin-путь): стирание чужого аккаунта из панели. Суперюзеров сервер не удаляет. */
export function useAdminDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/admin/users/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  });
}

/**
 * GDPR F4 (self-serve): немедленный hard-delete собственного аккаунта. `confirm` — email
 * аккаунта (подтверждение намерения; пароль не годится — Google-аккаунты живут без него).
 * После успеха сервер удаляет пользователя и очищает HttpOnly-cookie; сбрасываем
 * выбранный канал/кэш, редирект остаётся на вызывающей стороне.
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  const { setChannelId } = useSelectedChannel();
  return useMutation({
    mutationFn: (confirm: string) => apiSend('DELETE', '/api/account', { confirm }, OkSchema),
    onSuccess: () => {
      setChannelId(null);
      qc.getQueryCache().clear();
    },
  });
}

export function useCreateBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string; severity: string; context: string; kind: string }) =>
      apiSend('POST', '/api/bugs', body, BugSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bugs }),
  });
}

export function useUpdateBugStatus(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: string }) => apiSend('PATCH', `/api/bugs/${id}`, body, BugSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bugs }),
  });
}

export function useDeleteBug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/bugs/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bugs }),
  });
}

// ── Reports (saved multi-report documents) ──
// Per-USER, not per-channel: no X-Channel-Id key — ownership is enforced server-side (uid in SQL).

export type ReportSchedule = 'none' | 'weekly' | 'monthly';

/** The saved-reports index. `enabled:false` lets demo mode skip the fetch (no fixture exists). */
export function useReports(enabled = true) {
  return useQuery({
    enabled,
    queryKey: qk.reports,
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet('/api/reports', ReportsResponseSchema, { signal }),
  });
}

/** One report with its full config (the composed document). 404 on a foreign/missing id. */
export function useReport(id: number | null) {
  return useQuery({
    enabled: id != null,
    queryKey: qk.report(id),
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
      qc.setQueryData(qk.report(data.report.id), data);
      return qc.invalidateQueries({ queryKey: qk.reports });
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
      qc.setQueryData(qk.report(id), data);
      return qc.invalidateQueries({ queryKey: qk.reports });
    },
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/reports/${id}`, undefined, OkSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reports }),
  });
}

// ── Campaigns («Кампании и группы контента») ──
// Доступ остаётся workspace-scoped, а выбранный channelId определяет workspace списка. Поэтому
// один и тот же пользователь не смешивает кампании разных команд в одном селекторе.

export function useCampaigns(channelId: number | null = null) {
  return useQuery({
    enabled: !isDemoMode() && channelId != null,
    queryKey: qk.campaigns.list(channelId),
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/campaigns?channel_id=${channelId}`, CampaignsResponseSchema, { signal }),
  });
}

export function useCampaign(id: number | null) {
  return useQuery({
    enabled: id != null && !isDemoMode(),
    queryKey: qk.campaign(id),
    staleTime: STALE_LIVE,
    queryFn: ({ signal }) => apiGet(`/api/campaigns/${id}`, CampaignResponseSchema, { signal }),
  });
}

/** Публикации кампании, обогащённые метриками на сервере, — единственный источник membership
    для фильтра «Контента» (никаких параллельных чтений по компонентам). */
export function useCampaignPosts(id: number | null) {
  return useQuery({
    enabled: id != null && !isDemoMode(),
    queryKey: qk.campaignPosts(id),
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
    queryKey: qk.campaignSummary(id, scopeKey),
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
      qc.setQueryData(qk.campaign(data.campaign.id), data);
      return qc.invalidateQueries({ queryKey: qk.campaigns.all });
    },
  });
}

export function useUpdateCampaign(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignBody) => apiSend('PATCH', `/api/campaigns/${id}`, body, CampaignResponseSchema),
    onSuccess: (data) => {
      qc.setQueryData(qk.campaign(id), data);
      // Сводка несёт копию campaign-строки в заголовке — обновляем и её.
      qc.invalidateQueries({ queryKey: qk.campaignSummary(id) });
      return qc.invalidateQueries({ queryKey: qk.campaigns.all });
    },
  });
}

export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiSend('DELETE', `/api/campaigns/${id}`, undefined, OkSchema),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: qk.campaign(id) });
      qc.removeQueries({ queryKey: qk.campaignPosts(id) });
      qc.removeQueries({ queryKey: qk.campaignSummary(id) });
      return qc.invalidateQueries({ queryKey: qk.campaigns.all });
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
      qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
      qc.invalidateQueries({ queryKey: qk.campaignPosts(campaignId) });
      qc.invalidateQueries({ queryKey: qk.campaignSummary(campaignId) });
      return qc.invalidateQueries({ queryKey: qk.campaigns.all });
    },
  });
}

export function useRemoveCampaignPosts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, items }: { campaignId: number; items: CampaignPostInput[] }) =>
      apiSend('DELETE', `/api/campaigns/${campaignId}/posts`, { items }, CampaignRemoveResultSchema),
    onSuccess: (_data, { campaignId }) => {
      qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
      qc.invalidateQueries({ queryKey: qk.campaignPosts(campaignId) });
      qc.invalidateQueries({ queryKey: qk.campaignSummary(campaignId) });
      return qc.invalidateQueries({ queryKey: qk.campaigns.all });
    },
  });
}
