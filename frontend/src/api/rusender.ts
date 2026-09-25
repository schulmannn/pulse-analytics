import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet } from '@/api/client';
import { msPeriodQuery, type MsPeriod } from '@/lib/msPeriod';

/**
 * Запросы источника «Rusender» — ОТДЕЛЬНЫМ модулем, а не в общем api/queries, по той же причине,
 * что и api/cdek: queries.ts статически импортируют почти все маршруты, поэтому каждая схема в
 * нём попадает и в оболочку, и в чанк каждой метрик-страницы. Гейт размера бандла ловит это
 * сразу. Здесь модуль тянут только страницы Rusender (ленивый чанк) и /connect — TG/IG-пользователь
 * не платит за источник, которым не пользуется.
 *
 * ПОКА ЗДЕСЬ ТОЛЬКО СТАТУС ПОДКЛЮЧЕНИЯ. Схемы витрин (обзор, лента рассылок, база) приезжают
 * следующим шагом — их форма фиксируется по ЖИВЫМ ответам Rusender, а не по OpenAPI-спеке.
 */

const STALE_STATUS = 60_000;

/**
 * Статус подключения. `missing_scopes` — разрешения, которых ключу не хватает ПРЯМО СЕЙЧАС:
 * их могли отозвать уже после подключения, и тогда источник тихо перестал бы наполняться.
 * Экран обязан это показать, а не оставить пользователя гадать.
 */
export const RusenderStatusSchema = z
  .object({
    connected: z.boolean(),
    channel_id: z.number().nullable(),
    account_email: z.string().nullable(),
    account_id: z.string().nullable(),
    scopes: z.array(z.string()).default([]),
    missing_scopes: z.array(z.string()).default([]),
    connected_at: z.string().nullable(),
  })
  .passthrough();

export type RusenderStatus = z.infer<typeof RusenderStatusSchema>;

/** Ответ connect: канал заведён/переиспользован, ключ сохранён шифрованным. */
export const RusenderConnectSchema = z
  .object({
    ok: z.boolean(),
    channel_id: z.number(),
    account_email: z.string().nullable(),
    scopes: z.array(z.string()).default([]),
  })
  .passthrough();

/** Метрика периода: абсолютное число (доли считаются на клиенте от одного знаменателя). */
const CampaignTotalsSchema = z
  .object({
    campaigns: z.coerce.number().default(0),
    total: z.coerce.number().default(0),
    delivered: z.coerce.number().default(0),
    opens: z.coerce.number().default(0),
    clicks: z.coerce.number().default(0),
    errors: z.coerce.number().default(0),
    unsubscribes: z.coerce.number().default(0),
    complaints: z.coerce.number().default(0),
  })
  .passthrough();

/**
 * Дневная точка. `opens/clicks` — СОБЫТИЯ дня (настоящий ряд). Контакты — снимок базы, и они
 * NULLABLE осознанно: день без снимка это дыра в сборе, а не обнулившаяся база, поэтому линия
 * в этом месте обязана разорваться, а не упасть в ноль.
 */
const RusenderPointSchema = z
  .object({
    day: z.string(),
    opens: z.coerce.number().default(0),
    clicks: z.coerce.number().default(0),
    contacts_total: z.coerce.number().nullable().default(null),
    contacts_active: z.coerce.number().nullable().default(null),
    contacts_unsubscribed: z.coerce.number().nullable().default(null),
  })
  .passthrough();

/**
 * Ответ обзора. ДВЕ независимые группы величин, которые НЕЛЬЗЯ складывать:
 *   events    — открытия/клики, СЛУЧИВШИЕСЯ в окне (включая открытия старых писем);
 *   campaigns — итоги рассылок, ЗАПУЩЕННЫХ в окне (кумулятивные счётчики кампаний).
 * Тот же канон, что «Просмотры канала» ≠ «Просмотры публикаций» у Telegram.
 */
export const RusenderSummarySchema = z
  .object({
    days: z.number(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    events: z.object({ opens: z.coerce.number().default(0), clicks: z.coerce.number().default(0) }).passthrough(),
    campaigns: CampaignTotalsSchema,
    contacts: z
      .object({
        day: z.string().nullable().default(null),
        contacts_total: z.coerce.number().nullable().default(null),
        contacts_active: z.coerce.number().nullable().default(null),
        contacts_unsubscribed: z.coerce.number().nullable().default(null),
        contacts_unavailable: z.coerce.number().nullable().default(null),
      })
      .passthrough()
      .nullable(),
    series: z.array(RusenderPointSchema).default([]),
    bounds: z
      .object({
        first_day: z.string().nullable(),
        last_day: z.string().nullable(),
        campaigns: z.coerce.number().default(0),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export const RusenderCampaignSchema = z
  .object({
    campaign_id: z.coerce.number(),
    name: z.string().nullable(),
    subject: z.string().nullable(),
    type: z.string().nullable(),
    status: z.string().nullable(),
    sender_email: z.string().nullable(),
    list_names: z.array(z.string()).nullable().default(null),
    is_archived: z.boolean().default(false),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    // Части семьи A/B: в ленте показывается только база, части — на развороте (миграция 040).
    parts_count: z.coerce.number().default(0),
    family_role: z.string().nullable().default(null),
    total: z.coerce.number().nullable().default(null),
    delivered: z.coerce.number().nullable().default(null),
    opens: z.coerce.number().nullable().default(null),
    clicks: z.coerce.number().nullable().default(null),
    errors: z.coerce.number().nullable().default(null),
    unsubscribes: z.coerce.number().nullable().default(null),
    complaints: z.coerce.number().nullable().default(null),
  })
  .passthrough();

export const RusenderCampaignsSchema = z
  .object({
    days: z.number(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    campaigns: z.array(RusenderCampaignSchema).default([]),
  })
  .passthrough();

export type RusenderSummary = z.infer<typeof RusenderSummarySchema>;
export type RusenderCampaign = z.infer<typeof RusenderCampaignSchema>;
export type RusenderPoint = z.infer<typeof RusenderPointSchema>;

export const rusenderKeys = {
  /** Корень семьи — по нему инвалидируется ВЕСЬ источник разом (connect/disconnect меняют всё). */
  all: ['rusender'] as const,
  status: (channelId: number | null) => ['rusender', 'status', channelId] as const,
  // Ключ несёт ПОЛНОЕ окно (days + явный диапазон): у страницы метрики текущее и предыдущее окна
  // различаются только диапазоном, и ключ по одному `days` склеил бы их в один кэш.
  summary: (channelId: number | null, windowQuery: string) =>
    ['rusender', 'summary', channelId, windowQuery] as const,
  campaigns: (channelId: number | null, windowQuery: string) =>
    ['rusender', 'campaigns', channelId, windowQuery] as const,
};

/**
 * Статус источника. `channelId` передаётся ЯВНО (а не берётся из свитчера): на /connect панель
 * показывает состояние конкретного rusender-канала, а не активного источника — иначе у второго
 * аккаунта отображался бы статус первого (урок #539 у Метрики).
 */
export function useRusenderStatus(channelId: number | null) {
  return useQuery({
    queryKey: rusenderKeys.status(channelId),
    queryFn: () => apiGet('/api/rusender/status', RusenderStatusSchema, { channelId }),
    staleTime: STALE_STATUS,
    // Без канала спрашивать нечего: источник ещё не заведён, панель рисует пустое состояние.
    enabled: channelId != null,
  });
}

// Витрины живут за фичефлагом: пока он выключен, роутов для клиента НЕ существует (404), и
// спрашивать их — значит гарантированно ловить ошибку на каждом маунте. `enabled` поэтому
// завязан и на канал, и на флаг.
const STALE_DATA = 5 * 60_000;

/**
 * Окно витрин — ТОТ ЖЕ `MsPeriod`, что у МойСклада, Метрики и СДЭКа, а не свой тип. Вместе с ним
 * достаются готовые `msPeriodQuery` (сериализация) и `msPreviousPeriod` (предыдущее равное окно):
 * заводить для Rusender собственную арифметику дат значило бы держать вторую правду о том, что
 * такое «прошлый период».
 */
export function useRusenderSummary(channelId: number | null, period: MsPeriod, enabled = true) {
  const q = msPeriodQuery(period);
  return useQuery({
    queryKey: rusenderKeys.summary(channelId, q),
    queryFn: () => apiGet(`/api/rusender/summary?${q}`, RusenderSummarySchema, { channelId }),
    staleTime: STALE_DATA,
    // ВАЖНО (грабли prev-периода): при выключенном запросе вызывающие обязаны читать `.data`
    // только через проверку «предыдущее окно существует». Ключ здесь несёт полное окно, поэтому
    // fallback на текущее окно отдал бы ТЕКУЩИЙ кэш и дельта вышла бы нулевой.
    enabled: enabled && channelId != null,
  });
}

export function useRusenderCampaigns(channelId: number | null, period: MsPeriod, enabled = true) {
  const q = msPeriodQuery(period);
  return useQuery({
    queryKey: rusenderKeys.campaigns(channelId, q),
    queryFn: () => apiGet(`/api/rusender/campaigns?${q}`, RusenderCampaignsSchema, { channelId }),
    staleTime: STALE_DATA,
    enabled: enabled && channelId != null,
  });
}
