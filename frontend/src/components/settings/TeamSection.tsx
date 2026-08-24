import { useState, type FormEvent, type ReactNode } from 'react';
import {
  useInviteLink,
  useInviteMember,
  useRemoveMember,
  useRevokeInvite,
  useSetMemberRole,
  useTeam,
  type TeamResponse,
} from '@/api/team';
import { isPaidPlan, PLAN_LABEL, usePlan } from '@/lib/plan';
import {
  INVITE_ROLES,
  isValidEmail,
  ROLE_HINT,
  ROLE_LABEL,
  TEAM_LIMIT,
  type MemberRole,
  type TeamRole,
} from '@/lib/team';
import { cn } from '@/lib/utils';
import { PillSelect } from '@/components/PillSelect';
import { Snippet } from '@/components/ui/snippet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SettingsGroup,
  SettingsIcon,
  SettingsRow,
} from '@/components/settings/primitives';

/**
 * «Команда» — участники рабочего пространства. Ростер серверный (`/api/team`): приглашение
 * выпускает токен, шлёт письмо со ссылкой на /invite, а принявший попадает в workspace_members
 * и с этого момента виден всем tenant-предикатам доступа. Free-план видит апселл — это витрина
 * тарифа (lib/plan.ts), доступ она не охраняет; настоящий потолок мест держит сервер.
 */
export function TeamSection({ onOpenBilling }: { onOpenBilling: () => void }) {
  const plan = usePlan();
  if (!isPaidPlan(plan)) return <TeamUpsell onOpenBilling={onOpenBilling} />;
  return <TeamRoster plan={plan} />;
}

/** Free plan: what the team surface is + where to unlock it. */
function TeamUpsell({ onOpenBilling }: { onOpenBilling: () => void }) {
  return (
    <SettingsGroup>
      <SettingsRow
        title="Команда доступна на Pro и Max"
        description="Приглашайте коллег в общий дашборд: роли «Редактор» и «Наблюдатель», до 10 участников на Max."
        control={
          <button
            type="button"
            onClick={onOpenBilling}
            className="btn-pill bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Смотреть тарифы
          </button>
        }
      />
    </SettingsGroup>
  );
}

const initialsOf = (email: string) =>
  email.replace(/@.*/, '').replace(/[^\p{L}\d]/gu, '').slice(0, 2).toUpperCase() || '?';

const roleOptions = INVITE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));

/** Незнакомая роль из будущей миграции подписывается своим идентификатором, а не пустотой. */
const roleLabelOf = (role: string) => ROLE_LABEL[role as MemberRole] ?? role;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось выполнить запрос';

/**
 * Что сказать после «Пригласить». Раньше здесь всегда стояло «Приглашение отправлено» — и это
 * ВРАЛО ровно в том случае, который встречается первым: без RESEND_API_KEY сервер только пишет
 * письмо в лог, а форма рапортовала об отправке. Теперь ответ разбирается по трём состояниям,
 * и провал называет причину провайдера, а не оставляет человека гадать.
 */
function deliveryText(data: TeamResponse | undefined): string {
  if (!data) return 'Приглашение создано.';
  if (data.email_configured === false) {
    return 'Приглашение создано, но письмо НЕ отправлено: на сервере не настроена почта (RESEND_API_KEY).';
  }
  if (data.delivered === false) {
    const reason = [data.delivery?.status, data.delivery?.error].filter(Boolean).join(' · ');
    return reason
      ? `Приглашение создано, но почтовый провайдер отклонил письмо (${reason}). Ссылку можно выслать заново.`
      : 'Приглашение создано, но письмо отправить не удалось — попробуйте выслать ещё раз.';
  }
  return 'Приглашение отправлено.';
}

function TeamRoster({ plan }: { plan: 'pro' | 'max' }) {
  const team = useTeam();
  const invite = useInviteMember();
  const revoke = useRevokeInvite();
  const setRole = useSetMemberRole();
  const remove = useRemoveMember();
  const inviteLink = useInviteLink();

  // Какую ссылку сейчас показываем: свежевыпущенную формой или перевыпущенную по кнопке в строке.
  // `reissued` разводит два текста: у второй прежняя ссылка из письма уже мертва.
  const [shownLink, setShownLink] = useState<{ email: string; url: string; reissued: boolean } | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRoleValue] = useState<TeamRole>('viewer');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const planLimit = TEAM_LIMIT[plan];
  const used = team.data?.seats.used ?? 0;
  const full = used >= planLimit;
  const members = team.data?.members ?? [];
  const invites = team.data?.invites ?? [];
  const busy = invite.isPending || revoke.isPending || setRole.isPending || remove.isPending || inviteLink.isPending;

  const onInvite = (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!isValidEmail(value)) {
      setLocalErr('Похоже, это не email');
      return;
    }
    setLocalErr(null);
    invite.mutate(
      { email: value, role },
      {
        onSuccess: (data) => {
          setEmail('');
          setRoleValue('viewer');
          if (data.invite_link) setShownLink({ email: value, url: data.invite_link, reissued: false });
        },
      },
    );
  };

  if (team.isError) {
    return (
      <SettingsGroup>
        <SettingsRow title="Команда недоступна" description={errorText(team.error)} />
      </SettingsGroup>
    );
  }

  // Письмо уходит через Resend; без ключа сервер только пишет его в лог — говорим это вслух,
  // иначе поверхность обещает доставку, которой нет.
  const emailOff = team.data ? team.data.email_configured === false : false;
  const description = team.isLoading
    ? 'Загружаем состав команды…'
    : `Занято ${used} из ${planLimit} мест для коллег на плане ${PLAN_LABEL[plan]}.`
      + (emailOff
        ? ' Почта на сервере не настроена — приглашение создастся, но письмо не уйдёт.'
        : ' Коллега получит письмо со ссылкой; доступ откроется, когда он её примет.');

  return (
    <SettingsGroup>
      <SettingsRow
        title="Пригласить участника"
        description={description}
        footer={
          <>
            <form onSubmit={onInvite} className="mt-3 flex flex-col gap-2 @min-[32rem]:flex-row">
              <Input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setLocalErr(null);
                  invite.reset();
                }}
                placeholder="email коллеги"
                disabled={full || invite.isPending}
                className="w-full flex-1"
              />
              <div className="flex shrink-0 items-center gap-2">
                <PillSelect<TeamRole>
                  value={role}
                  options={roleOptions}
                  onValueChange={(v) => setRoleValue(v)}
                  disabled={full || invite.isPending}
                  ariaLabel="Роль"
                />
                <Button
                  type="submit"
                  size="sm"
                  pending={invite.isPending}
                  disabled={full || invite.isPending || email.trim().length === 0}
                >
                  {invite.isPending ? 'Отправляем…' : 'Пригласить'}
                </Button>
              </div>
            </form>
            <p className="mt-2 text-xs text-ink3">{ROLE_HINT[role]}</p>
            {full && (
              <p className="mt-2 text-xs text-ink3">
                Все места плана заняты — отзовите приглашение или повысьте тариф.
              </p>
            )}
            {(localErr || invite.isError) && (
              <p role="alert" className="mt-2 text-xs font-medium text-destructive">
                {localErr ?? errorText(invite.error)}
              </p>
            )}
            <div aria-live="polite">
              {invite.isSuccess && (
                <p className="mt-2 text-xs text-ink2">{deliveryText(invite.data)}</p>
              )}
            </div>
            {shownLink && (
              <div className="mt-3">
                <Snippet
                  value={shownLink.url}
                  tone={shownLink.reissued ? 'warn' : 'default'}
                  label={
                    shownLink.reissued
                      ? `Новая ссылка для ${shownLink.email} — прежняя из письма больше не работает`
                      : `Ссылка для ${shownLink.email} — можно передать напрямую`
                  }
                />
              </div>
            )}
          </>
        }
      />

      {members.map((m) => (
        <MemberRow
          key={m.uid}
          email={m.email}
          badge={roleLabelOf(m.role)}
          control={
            m.role === 'owner' ? (
              <span className="text-xs text-muted-foreground">Полный доступ</span>
            ) : (
              <>
                <PillSelect<TeamRole>
                  value={(INVITE_ROLES as string[]).includes(m.role) ? (m.role as TeamRole) : 'viewer'}
                  options={roleOptions}
                  onValueChange={(v) => setRole.mutate({ uid: m.uid, role: v })}
                  disabled={busy}
                  ariaLabel={`Роль ${m.email}`}
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon-xs"
                  disabled={busy}
                  onClick={() => remove.mutate(m.uid)}
                  aria-label={`Убрать ${m.email}`}
                >
                  <SettingsIcon name="close" className="h-3.5 w-3.5" />
                </Button>
              </>
            )
          }
        />
      ))}

      {invites.map((inv) => (
        <MemberRow
          key={`invite-${inv.id}`}
          email={inv.email}
          badge={`Приглашён · ${roleLabelOf(inv.role)}`}
          badgeMuted
          control={
            <>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={busy}
                onClick={() =>
                  inviteLink.mutate(inv.id, {
                    onSuccess: (data) => {
                      if (data.invite_link) {
                        setShownLink({ email: inv.email, url: data.invite_link, reissued: true });
                      }
                    },
                  })
                }
              >
                Ссылка
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon-xs"
                disabled={busy}
                onClick={() => revoke.mutate(inv.id)}
                aria-label={`Отозвать приглашение ${inv.email}`}
              >
                <SettingsIcon name="close" className="h-3.5 w-3.5" />
              </Button>
            </>
          }
        />
      ))}

      {(setRole.isError || remove.isError || revoke.isError || inviteLink.isError) && (
        <div className="px-5 pb-3">
          <p role="alert" className="text-xs font-medium text-destructive">
            {errorText(setRole.error ?? remove.error ?? revoke.error ?? inviteLink.error)}
          </p>
        </div>
      )}

      {/* Приглашённому: куда его позвали. Без этой строки он открывает «Команду» и видит свой
          пустой личный воркспейс, не понимая, где общий доступ. */}
      {(team.data?.memberships ?? []).map((ws) => (
        <div key={ws.id} className="border-t border-border px-5 py-3.5 text-xs text-ink2">
          Вы участник пространства «{ws.name}»
          {ws.owner_email ? ` (${ws.owner_email})` : ''} — роль «{roleLabelOf(ws.role)}».
        </div>
      ))}
    </SettingsGroup>
  );
}

function MemberRow({
  email,
  badge,
  badgeMuted,
  control,
}: {
  email: string;
  badge: string;
  badgeMuted?: boolean;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-avatar text-2xs font-medium text-ink2',
            badgeMuted && 'opacity-60',
          )}
        >
          {initialsOf(email)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm text-foreground">{email}</div>
          <Badge variant={badgeMuted ? 'secondary' : 'outline'}>{badge}</Badge>
        </div>
      </div>
      {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}
