import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet } from '@/api/client';

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

export const rusenderKeys = {
  /** Корень семьи — по нему инвалидируется ВЕСЬ источник разом (connect/disconnect меняют всё). */
  all: ['rusender'] as const,
  status: (channelId: number | null) => ['rusender', 'status', channelId] as const,
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
