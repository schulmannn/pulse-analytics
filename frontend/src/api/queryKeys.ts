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
 * - Read-only семьи без адресных инвалидаций (config, tg-full, tg-stats, tg-graphs, post-stats)
 *   остаются inline в queries.ts — фабрика их сознательно не размножает. Семьи IG и МойСклада
 *   отсюда УШЛИ в фабрику: их как раз инвалидируют, и делали это строковым predicate'ом.
 * - Predicate-инвалидаций по строковому префиксу здесь БОЛЬШЕ НЕТ: они матчили первый элемент
 *   как строку, то есть сбрасывали кэш всех каналов разом и не проверялись компилятором.
 *   Вместо них — префикс семьи (`qk.ig.all(channelId)`), который TanStack матчит поэлементно.
 * - `.all` — префикс семьи для инвалидации всех её ключей (TanStack матчит ключи
 *   поэлементно с начала массива); параметризованные формы — точный ключ чтения.
 */

/** Семья ОКОННОГО отчёта: префикс инвалидации (`all`) + точный ключ чтения (`window`). Хвост
    (`limit`, цель, разрез, режим выручки) добавляется ПОЗИЦИОННО в том же порядке, что и в
    query-строке запроса. Родилась для Метрики, теперь общая — у СДЭКа те же оконные чтения, и
    свои развёрнутые семьи стоили бы лишних байт в ОБЩЕЙ оболочке (гейт размера бандла). */
const periodFamily = (name: string) => ({
  all: [name] as const,
  // Хвост принимает и null/boolean: у витрин есть необязательные фильтры («сегмент не выбран»)
  // и булевы флажки разреза. Приводить их к строке в каждом хуке значило бы, что `null` и строка
  // 'null' дают ОДИН ключ.
  window: (channelId: number | null, period: MsPeriod, ...tail: Array<string | number | boolean | null>) =>
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
  ymSummary: periodFamily('ym-summary'),
  ymSources: periodFamily('ym-sources'),
  ymReferrers: periodFamily('ym-referrers'),
  ymSocial: periodFamily('ym-social'),
  ymMessengers: periodFamily('ym-messengers'),
  ymDevices: periodFamily('ym-devices'),
  ymCountries: periodFamily('ym-countries'),
  ymCities: periodFamily('ym-cities'),
  ymAge: periodFamily('ym-age'),
  ymGender: periodFamily('ym-gender'),
  ymGoals: periodFamily('ym-goals'),
  ymUtm: periodFamily('ym-utm'),
  ymPages: periodFamily('ym-pages'),
  ymLandings: periodFamily('ym-landings'),
  ymHourly: periodFamily('ym-hourly'),
  ymExits: periodFamily('ym-exits'),
};

/**
 * Instagram — одна семья вместо девяти независимых строковых ключей.
 *
 * Инвалидация IG держалась на predicate `startsWith('ig-')`. Он сравнивает ПЕРВЫЙ элемент ключа
 * как строку, поэтому: сбрасывал IG-кэш ВСЕХ каналов разом, а не текущего; ловил бы любой будущий
 * ключ, начинающийся с `ig-`; и никак не проверялся компилятором — опечатка просто перестала бы
 * совпадать, и экран тихо перестал бы обновляться после подключения аккаунта.
 *
 * Общий префикс `['ig', channelId]` делает точечное чтение и поканальную инвалидацию ОДНИМ
 * выражением. channelId остаётся ВТОРЫМ элементом — на этом держится channel-guard в
 * keepPreviousForChannel.
 */
const igFamily = {
  /** ВЕСЬ IG-кластер, все каналы. Нужен ровно в одном месте — на возврате из OAuth, где аккаунт
      мог быть только что создан вместе со своим каналом, и «текущий» id ещё не тот. */
  root: ['ig'] as const,
  all: (channelId: number | null) => ['ig', channelId] as const,
  profile: (channelId: number | null) => ['ig', channelId, 'profile'] as const,
  insights: (channelId: number | null, days: number) => ['ig', channelId, 'insights', days] as const,
  posts: (channelId: number | null, limit: number) => ['ig', channelId, 'posts', limit] as const,
  breakdowns: (channelId: number | null, timeframe: string) => ['ig', channelId, 'breakdowns', timeframe] as const,
  online: (channelId: number | null) => ['ig', channelId, 'online'] as const,
  stories: (channelId: number | null) => ['ig', channelId, 'stories'] as const,
  tags: (channelId: number | null) => ['ig', channelId, 'tags'] as const,
  history: (channelId: number | null, days: number) => ['ig', channelId, 'history', days] as const,
  oauthStatus: (channelId: number | null) => ['ig', channelId, 'oauth-status'] as const,
};

export const qk = {
  ig: igFamily,

  // ── Профиль / сессия ──
  me: ME_QUERY_KEY,

  // ── Упоминания (per-channel) ──
  mentions: (channelId: number | null) => ['mentions', channelId] as const,
  mentionsArchive: {
    all: ['mentions-archive'] as const,
    window: (channelId: number | null, ...tail: Array<string | number | null>) =>
      ['mentions-archive', channelId, ...tail],
  },
  mentionSettings: (channelId: number | null) => ['mention-settings', channelId] as const,
  mentionNotify: (channelId: number | null) => ['mention-notify', channelId] as const,

  // ── Архивы канала (TG) ──
  historyChannel: {
    all: ['history-channel'] as const,
    window: (channelId: number | null, days: number) => ['history-channel', channelId, days] as const,
  },
  velocity: (channelId: number | null) => ['velocity', channelId] as const,

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
  // Витрины склада. Жили inline-литералами в queries.ts, а сбрасывались predicate'ом
  // `startsWith('ms-')` — то есть связь между чтением и инвалидацией держалась на совпадении
  // строк и компилятором не проверялась.
  msFunnel: periodFamily('ms-funnel'),
  msCustomers: periodFamily('ms-customers'),
  msRfm: periodFamily('ms-rfm'),
  msRfmCustomers: periodFamily('ms-rfm-customers'),
  msSalesByChannel: periodFamily('ms-sales-by-channel'),
  msChannelSeries: periodFamily('ms-channel-series'),
  msGeography: periodFamily('ms-geography'),
  msTopCustomers: periodFamily('ms-top-customers'),
  msReturns: periodFamily('ms-returns'),
  msTopProductsCompare: periodFamily('ms-top-products-compare'),
  msStock: periodFamily('ms-stock'),
  msCohorts: {
    all: ['ms-cohorts'] as const,
    byChannel: (channelId: number | null) => ['ms-cohorts', channelId] as const,
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
  // Оконные чтения «Обзора». Ключ несёт ГРАНИЦЫ окна (msPeriodKey), а не только число дней:
  // пресет и точный диапазон одной длины — разные данные.
  cdekSummary: periodFamily('cdek-summary'),
  cdekSeries: periodFamily('cdek-series'),
  cdekBreakdown: periodFamily('cdek-breakdown'),
  cdekOrders: periodFamily('cdek-orders'),
  cdekHourly: periodFamily('cdek-hourly'),
  ...ymFamilies,
  /** Префиксы ВСЕХ семей Метрики одним списком: `invalidateYm` после смены счётчика обязан
      пройтись по ним, а не по трём — иначе 14 карточек разрезов до 5 минут врут прошлым счётчиком. */
  ymAll: Object.values(ymFamilies).map((family) => family.all),
  /** Префиксы всех семей МойСклада. Заменяет predicate `startsWith('ms-')`: тот сравнивал первый
      элемент ключа как СТРОКУ, поэтому не проверялся компилятором и ловил бы любой будущий ключ,
      начинающийся с `ms-`. Список явный — новую семью в него добавляют вместе с самой семьёй. */
  msAll: [
    ['ms-status'], ['ms-backfill'], ['ms-summary'], ['ms-top-products'],
    ['ms-funnel'], ['ms-customers'], ['ms-rfm'], ['ms-rfm-customers'],
    ['ms-sales-by-channel'], ['ms-channel-series'], ['ms-geography'],
    ['ms-top-customers'], ['ms-returns'], ['ms-top-products-compare'],
    ['ms-stock'], ['ms-cohorts'],
  ] as const,

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
