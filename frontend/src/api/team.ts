import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet, apiSend } from '@/api/client';
import { qk } from '@/api/queryKeys';
import type { TeamRole } from '@/lib/team';

/**
 * API команды — схемы и хуки ОТДЕЛЬНЫМ модулем, а не в общих `api/schemas.ts` / `api/queries.ts`.
 * Причина механическая: те два модуля тянет КАЖДАЯ роут-группа, и лишние zod-схемы (Rollup не
 * доказывает чистоту `z.object(...)` и не вытряхивает их) сразу упираются в бюджеты размера
 * (scripts/check-bundle-size.mjs). Команда живёт только в настройках и на публичной странице
 * приглашения — пусть и весит только там.
 */

// Роли — тот же словарь, что в БД и в рангах middleware/tenant.js. `role` намеренно широкая
// строка с сужением на месте: незнакомая роль из будущей миграции не должна ронять парсинг
// всего ростера (её просто нечем подписать в UI).
export const TeamMemberSchema = z
  .object({
    uid: z.coerce.number(),
    email: z.string(),
    role: z.string(),
    created_at: z.string().optional().nullable(),
  })
  .passthrough();

export const TeamInviteSchema = z
  .object({
    id: z.coerce.number(),
    email: z.string(),
    role: z.string(),
    created_at: z.string().optional().nullable(),
    expires_at: z.string().optional().nullable(),
  })
  .passthrough();

export const TeamResponseSchema = z
  .object({
    workspace: z
      .object({ id: z.coerce.number(), name: z.string(), name_max: z.coerce.number().optional().default(64) })
      .passthrough(),
    members: z.array(TeamMemberSchema).optional().default([]),
    invites: z.array(TeamInviteSchema).optional().default([]),
    // Воркспейсы, где пользователь — приглашённый участник, а не владелец.
    memberships: z
      .array(
        z
          .object({
            id: z.coerce.number(),
            name: z.string(),
            role: z.string(),
            owner_email: z.string().optional().nullable(),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
    seats: z.object({ used: z.coerce.number(), limit: z.coerce.number() }).passthrough(),
    // false → на сервере не настроен RESEND_API_KEY: приглашение создаётся, но письмо только
    // пишется в лог. Поверхность обязана сказать это вслух.
    email_configured: z.boolean().optional().default(true),
    delivered: z.boolean().optional(),
    // Причина, по которой письмо не ушло (исход sendEmailDetailed + ответ Resend). null при успехе.
    delivery: z
      .object({
        outcome: z.string().optional().nullable(),
        status: z.coerce.number().optional().nullable(),
        error: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    // Ссылка приходит ТОЛЬКО в ответ на выпуск/перевыпуск: сырой токен нигде не хранится,
    // в ростере (GET /api/team) его нет и быть не может.
    invite_link: z.string().optional().nullable(),
  })
  .passthrough();
export type TeamResponse = z.infer<typeof TeamResponseSchema>;

/** Превью приглашения на публичной странице /invite (до входа). */
export const InvitePreviewSchema = z
  .object({
    status: z.enum(['live', 'expired', 'revoked', 'accepted']),
    email: z.string(),
    role: z.string(),
    workspace: z.string(),
    invited_by: z.string().optional().nullable(),
    needs_account: z.boolean().optional().default(false),
  })
  .passthrough();
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

export const InviteAcceptSchema = z
  .object({
    ok: z.literal(true),
    workspace: z.string().optional().nullable(),
    role: z.string().optional().nullable(),
  })
  .passthrough();

/**
 * Ростер команды: участники воркспейса + живые приглашения. Раньше жил в localStorage —
 * теперь это серверная правда (`/api/team`, таблицы workspace_members / workspace_invites).
 * retry:false по правилу «ворота окружения»: 503 «БД не подключена» и 401 — это ответ, а не сбой.
 */
export function useTeam({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.team,
    enabled,
    queryFn: ({ signal }) => apiGet('/api/team', TeamResponseSchema, { signal }),
    retry: false,
  });
}

// Каждая мутация команды возвращает СВЕЖИЙ кадр ростера целиком (routes/team.js), поэтому
// ответ кладётся в кэш напрямую — без второго round-trip'а на рефетч.
function useTeamWrite<TBody>(send: (body: TBody) => Promise<TeamResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (data) => qc.setQueryData(qk.team, data),
  });
}

/**
 * Переименовать команду. По умолчанию имя — локальная часть email владельца (так его завела
 * миграция воркспейсов), из-за чего приглашение звало «в schulmannn»; это поле закрывает хвост.
 * Имя попадает в тему письма, его заголовок и в строку «Вы участник пространства …».
 */
export function useRenameTeam() {
  return useTeamWrite((name: string) =>
    apiSend('PATCH', '/api/team', { name }, TeamResponseSchema),
  );
}

/** Пригласить коллегу: сервер выпускает токен и шлёт письмо со ссылкой на /invite. */
export function useInviteMember() {
  return useTeamWrite((body: { email: string; role: TeamRole }) =>
    apiSend('POST', '/api/team/invites', body, TeamResponseSchema),
  );
}

/**
 * Получить ссылку на уже выпущенное приглашение — запасной путь, когда почта подвела.
 * Сервер ПЕРЕВЫПУСКАЕТ токен (сырой нигде не хранится), поэтому прежняя ссылка из письма
 * перестаёт работать — вызывающий обязан это показать.
 */
export function useInviteLink() {
  return useTeamWrite((id: number) =>
    apiSend('POST', `/api/team/invites/${id}/link`, undefined, TeamResponseSchema),
  );
}

/** Отозвать приглашение — ссылка из письма умирает немедленно. */
export function useRevokeInvite() {
  return useTeamWrite((id: number) =>
    apiSend('DELETE', `/api/team/invites/${id}`, undefined, TeamResponseSchema),
  );
}

export function useSetMemberRole() {
  return useTeamWrite((body: { uid: number; role: TeamRole }) =>
    apiSend('PATCH', `/api/team/members/${body.uid}`, { role: body.role }, TeamResponseSchema),
  );
}

/** Исключить участника. Доступ пропадает сразу — tenant-предикаты читают членство на каждом запросе. */
export function useRemoveMember() {
  return useTeamWrite((uid: number) =>
    apiSend('DELETE', `/api/team/members/${uid}`, undefined, TeamResponseSchema),
  );
}

/**
 * Публичное превью приглашения по токену из письма (страница /invite до входа).
 * retry:false — «ссылка мертва» это ответ 4xx, а не транзиентный сбой.
 */
export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: ['invite-preview', token],
    enabled: token.length > 0,
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) =>
      apiGet(`/api/team/invite/${encodeURIComponent(token)}`, InvitePreviewSchema, { signal }),
  });
}

/** Принять приглашение ДЕЙСТВУЮЩИМ аккаунтом (сессия уже есть, email обязан совпасть). */
export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiSend('POST', `/api/team/invite/${encodeURIComponent(token)}/accept`, undefined, InviteAcceptSchema),
    onSuccess: () => qc.invalidateQueries(),
  });
}

/** Принять приглашение БЕЗ аккаунта: сервер заводит активный аккаунт и сразу выдаёт сессию. */
export function useClaimInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      apiSend(
        'POST',
        `/api/team/invite/${encodeURIComponent(body.token)}/claim`,
        { password: body.password },
        InviteAcceptSchema,
      ),
    onSuccess: () => qc.invalidateQueries(),
  });
}
