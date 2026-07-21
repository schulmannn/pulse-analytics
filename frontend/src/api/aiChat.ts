import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';

/**
 * AI-чат (STEEP-паттерн): CRUD личных диалогов. Эндпоинты не каналозависимы —
 * channelId: null убирает заголовок X-Channel-Id. Стриминговый ответ ассистента живёт
 * отдельно в lib/aiStream.ts (fetch + ReadableStream, грузится только lazy-страницей чата).
 */

export const AiChatSchema = z
  .object({
    id: z.number(),
    title: z.string().default(''),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    message_count: z.number().optional(),
  })
  .passthrough();
export type AiChat = z.infer<typeof AiChatSchema>;

export const AiChatsResponseSchema = z
  .object({
    chats: z.array(AiChatSchema).default([]),
    usage: z.object({ used: z.number(), limit: z.number() }).optional(),
  })
  .passthrough();
export type AiChatsResponse = z.infer<typeof AiChatsResponseSchema>;

export const AiToolTraceSchema = z
  .object({
    name: z.string(),
    ok: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type AiToolTrace = z.infer<typeof AiToolTraceSchema>;

export const AiMessageSchema = z
  .object({
    id: z.number(),
    role: z.enum(['user', 'assistant']),
    content: z.string().default(''),
    tool_trace: z.array(AiToolTraceSchema).nullable().optional(),
    error: z.string().nullable().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();
export type AiMessage = z.infer<typeof AiMessageSchema>;

export const AiChatWithMessagesSchema = z
  .object({ chat: AiChatSchema, messages: z.array(AiMessageSchema).default([]) })
  .passthrough();

const AiChatCreatedSchema = z.object({ chat: AiChatSchema }).passthrough();
const AiOkSchema = z.object({ ok: z.boolean().optional() }).passthrough();

export function useAiChats(enabled: boolean) {
  return useQuery({
    queryKey: ['ai-chats'],
    enabled,
    staleTime: 30_000,
    queryFn: ({ signal }) => apiGet('/api/ai/chats', AiChatsResponseSchema, { signal, channelId: null }),
  });
}

export function useAiChat(chatId: number | null) {
  return useQuery({
    queryKey: ['ai-chat', chatId],
    enabled: chatId != null,
    queryFn: ({ signal }) =>
      apiGet(`/api/ai/chats/${chatId}`, AiChatWithMessagesSchema, { signal, channelId: null }),
  });
}

export function useCreateAiChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend('POST', '/api/ai/chats', undefined, AiChatCreatedSchema, { channelId: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-chats'] }),
  });
}

export function useDeleteAiChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (chatId: number) =>
      apiSend('DELETE', `/api/ai/chats/${chatId}`, undefined, AiOkSchema, { channelId: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-chats'] }),
  });
}

/** Человекочитаемые подписи инструментов ассистента (chips «Смотрю: …» и след в сообщении). */
export const AI_TOOL_LABELS: Record<string, string> = {
  get_telegram_metrics: 'метрики Telegram',
  get_telegram_top_posts: 'топ постов Telegram',
  get_instagram_metrics: 'метрики Instagram',
  get_mentions_summary: 'упоминания',
  get_campaigns: 'кампании',
  get_campaign_summary: 'сводка кампании',
};
export const aiToolLabel = (name: string): string => AI_TOOL_LABELS[name] ?? name;

/** Куда «проваливается» источник ответа: инструмент → поверхность с этими же данными. Карта —
    основа «Источников» под ответом (Astryx Citation, наш вариант: цитата = живой drill). */
export const AI_TOOL_ROUTES: Record<string, string> = {
  get_telegram_metrics: '/analytics',
  get_telegram_top_posts: '/posts',
  get_instagram_metrics: '/instagram/analytics',
  get_mentions_summary: '/mentions',
  get_campaigns: '/posts?view=campaigns',
  get_campaign_summary: '/posts?view=campaigns',
};
export const aiToolRoute = (name: string): string | null => AI_TOOL_ROUTES[name] ?? null;
