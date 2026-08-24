import { msPeriodKey, type MsPeriod } from '@/lib/msPeriod';
import { ME_QUERY_KEY } from '@/api/authQueryKey';

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

/** Семья отчёта «Яндекс.Метрики»: префикс инвалидации (`all`) + точный ключ чтения (`window`).
    Хвост (`limit`, цель) добавляется ПОЗИЦИОННО в том же порядке, что и в query-строке запроса. */
const ymFamily = (name: string) => ({
  all: [name] as const,
  window: (channelId: number | null, period: MsPeriod, ...tail: number[]) =>
    [name, channelId, ...msPeriodKey(period), ...tail],
});

/**
 * Один счётчик Метрики кормит 17 семей: статус, сводка и 15 разрезов. Смена счётчика обязана
 * сбрасывать ВСЕ — иначе разрезы до истечения staleTime (5 мин) показывают данные прошлого
 * счётчика. Поэтому семьи собраны в одну запись, а `qk.ymAll` отдаёт их префиксы списком.
 */
const ymFamilies = {
  ymStatus: {
    all: ['ym-status'] as const,
    byChannel: (channelId: number | null) => ['ym-status', channelId] as const,
  },
  ymSummary: ymFamily('ym-summary'),
  ymSources: ymFamily('ym-sources'),
  ymReferrers: ymFamily('ym-referrers'),
  ymSocial: ymFamily('ym-social'),
  ymMessengers: ymFamily('ym-messengers'),
  ymDevices: ymFamily('ym-devices'),
  ymCountries: ymFamily('ym-countries'),
  ymCities: ymFamily('ym-cities'),
  ymAge: ymFamily('ym-age'),
  ymGender: ymFamily('ym-gender'),
  ymGoals: ymFamily('ym-goals'),
  ymUtm: ymFamily('ym-utm'),
  ymPages: ymFamily('ym-pages'),
  ymLandings: ymFamily('ym-landings'),
  ymHourly: ymFamily('ym-hourly'),
  ymExits: ymFamily('ym-exits'),
};

export const qk = {
  // ── Профиль / сессия ──
  me: ME_QUERY_KEY,

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
  // ── СДЭК Fulfillment (source='cdek'): источник с ручной загрузкой Excel ──
  // Отдельные семьи, а не одна: после загрузки инвалидируются ВСЕ три (архив вырос, покрытие
  // изменилось, история пополнилась), а вот при смене канала статус и история независимы.
  cdekStatus: {
    all: ['cdek-status'] as const,
    byChannel: (channelId: number | null) => ['cdek-status', channelId] as const,
  },
  cdekImports: {
    all: ['cdek-imports'] as const,
    byChannel: (channelId: number | null) => ['cdek-imports', channelId] as const,
  },
  cdekCoverage: {
    all: ['cdek-coverage'] as const,
    byChannel: (channelId: number | null) => ['cdek-coverage', channelId] as const,
  },
  ...ymFamilies,
  /** Префиксы ВСЕХ семей Метрики одним списком: `invalidateYm` после смены счётчика обязан
      пройтись по ним, а не по трём — иначе 14 карточек разрезов до 5 минут врут прошлым счётчиком. */
  ymAll: Object.values(ymFamilies).map((family) => family.all),

  // ── Аккаунт-кластер ──
  team: ['team'] as const,
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
