import { msPeriodKey, type MsPeriod } from '@/lib/msPeriod';

/**
 * Фабрика query-ключей для семей, которые ТРОГАЮТ мутации (invalidateQueries /
 * setQueryData / removeQueries).
 *
 * Зачем: опечатка в строковом литерале ключа не даёт ошибки компиляции — инвалидация
 * просто перестаёт совпадать с ключом чтения, и UI ТИХО перестаёт обновляться после
 * мутации. Фабрика делает оба конца (queryKey в useQuery и ключ в invalidate/setQueryData)
 * одним и тем же выражением, так что расхождение невозможно и опечатка ловится tsc.
 *
 * Правила:
 * - Новая мутационная семья (её ключ упоминает хоть один invalidate/setQueryData/
 *   removeQueries) — ТОЛЬКО сюда, не inline-литералом. Оба конца зовут одну запись.
 * - Формы ключей сохранены байт-в-байт с прежними inline-литералами (те же строки и
 *   порядок элементов) — на них завязаны активные кэши и prefix-matching инвалидаций.
 * - Read-only семьи без адресных инвалидаций (tg-full, ig-*, ym-отчёты, ms-витрины и
 *   т.п.) остаются inline в queries.ts — фабрика их сознательно не размножает.
 * - Predicate-инвалидации по строковому префиксу (`startsWith('ig-')` / `'ms-'`) — вне
 *   фабрики: они матчат первый элемент как строку, а не семью-массив.
 * - `.all` — префикс семьи для инвалидации всех её ключей (TanStack матчит ключи
 *   поэлементно с начала массива); параметризованные формы — точный ключ чтения.
 */
export const qk = {
  // ── Профиль / сессия ──
  me: ['me'] as const,

  // ── Упоминания (per-channel) ──
  mentions: (channelId: number | null) => ['mentions', channelId] as const,
  mentionSettings: (channelId: number | null) => ['mention-settings', channelId] as const,
  mentionNotify: (channelId: number | null) => ['mention-notify', channelId] as const,

  // ── Источники / подключения ──
  tgQrStatus: ['tg-qr-status'] as const,
  channels: ['channels'] as const,
  channelKeys: (channelId: number | null) => ['channel-keys', channelId] as const,
  collectorStatus: (channelId: number | null) => ['collector-status', channelId] as const,
  msStatus: {
    all: ['ms-status'] as const,
    byChannel: (channelId: number | null) => ['ms-status', channelId] as const,
  },
  msBackfill: {
    all: ['ms-backfill'] as const,
    byChannel: (channelId: number | null) => ['ms-backfill', channelId] as const,
  },
  msSummary: {
    all: ['ms-summary'] as const,
    window: (channelId: number | null, period: MsPeriod) => ['ms-summary', channelId, ...msPeriodKey(period)],
  },
  msTopProducts: {
    all: ['ms-top-products'] as const,
    window: (channelId: number | null, period: MsPeriod, limit: number, sort: string) =>
      ['ms-top-products', channelId, ...msPeriodKey(period), limit, sort],
  },
  ymStatus: {
    all: ['ym-status'] as const,
    byChannel: (channelId: number | null) => ['ym-status', channelId] as const,
  },
  ymSummary: {
    all: ['ym-summary'] as const,
    window: (channelId: number | null, period: MsPeriod) => ['ym-summary', channelId, ...msPeriodKey(period)],
  },
  ymSources: {
    all: ['ym-sources'] as const,
    window: (channelId: number | null, period: MsPeriod, goal: number | null) =>
      ['ym-sources', channelId, ...msPeriodKey(period), goal ?? 0],
  },

  // ── Аккаунт-кластер ──
  adminUsers: ['admin-users'] as const,
  bugs: ['bugs'] as const,
  annotations: (channelId: number | null) => ['annotations', channelId] as const,

  // ── Отчёты ──
  reports: ['reports'] as const,
  report: (id: number | null) => ['report', id] as const,

  // ── Кампании ──
  campaigns: {
    all: ['campaigns'] as const,
    list: (channelId: number | null) => ['campaigns', channelId] as const,
  },
  campaign: (id: number | null) => ['campaign', id] as const,
  campaignPosts: (id: number | null) => ['campaign-posts', id] as const,
  /** Без scopeKey — префикс ['campaign-summary', id] (инвалидация/remove всех scope кампании);
      со scopeKey — точный ключ чтения ['campaign-summary', id, scopeKey]. */
  campaignSummary: (id: number | null, scopeKey?: string) =>
    scopeKey == null ? (['campaign-summary', id] as const) : (['campaign-summary', id, scopeKey] as const),

  // ── AI-чат ──
  aiChats: ['ai-chats'] as const,
  aiChat: (chatId: number | null) => ['ai-chat', chatId] as const,
};
