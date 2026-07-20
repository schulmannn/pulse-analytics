import { useState, type FormEvent, type ReactNode } from 'react';
import { useMe } from '@/api/queries';
import { isPaidPlan, PLAN_LABEL, usePlan } from '@/lib/plan';
import {
  addMember,
  removeMember,
  ROLE_LABEL,
  setMemberRole,
  TEAM_LIMIT,
  useTeam,
  type TeamRole,
} from '@/lib/team';
import { PillSelect } from '@/components/PillSelect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SettingsGroup,
  SettingsIcon,
  SettingsRow,
} from '@/components/settings/primitives';

/**
 * «Команда» — plan-gated members preview. Free plan sees the upsell; paid plans manage a
 * local roster (owner row + invited members with roles). Invites are a stub: nothing is
 * emailed and no access is granted — the row says so honestly.
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
          <Button
            type="button"
            size="sm"
            onClick={onOpenBilling}
          >
            Смотреть тарифы
          </Button>
        }
      />
    </SettingsGroup>
  );
}

const initialsOf = (email: string) =>
  email.replace(/@.*/, '').replace(/[^\p{L}\d]/gu, '').slice(0, 2).toUpperCase() || '?';

const ROLE_OPTIONS: TeamRole[] = ['editor', 'viewer'];

function TeamRoster({ plan }: { plan: 'pro' | 'max' }) {
  const me = useMe();
  const team = useTeam();
  const limit = TEAM_LIMIT[plan];
  const full = team.length >= limit;

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('viewer');
  const [err, setErr] = useState<string | null>(null);

  const onInvite = (e: FormEvent) => {
    e.preventDefault();
    const problem = addMember(email, role);
    setErr(problem);
    if (!problem) {
      setEmail('');
      setRole('viewer');
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow
        title="Пригласить участника"
        description={`Занято ${team.length} из ${limit} мест на плане ${PLAN_LABEL[plan]}. Приглашения в предпросмотре — письмо не отправляется, доступ не выдаётся.`}
        footer={
          <>
            <form onSubmit={onInvite} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErr(null);
              }}
              placeholder="email коллеги"
              disabled={full}
              className="w-full flex-1"
            />
            <div className="flex shrink-0 items-center gap-2">
              <PillSelect<TeamRole>
                value={role}
                options={ROLE_OPTIONS.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                onValueChange={(v) => setRole(v)}
                disabled={full}
                ariaLabel="Роль"
              />
              <Button
                type="submit"
                size="sm"
                disabled={full || email.trim().length === 0}
              >
                Пригласить
              </Button>
            </div>
            </form>
            {err && <p className="mt-2 text-xs font-medium text-destructive">{err}</p>}
          </>
        }
      />
      {/* Owner — the signed-in account, implicit and irremovable. */}
      <MemberRow
        email={me.data?.email ?? '—'}
        badge="Владелец"
        control={<span className="text-xs text-muted-foreground">Полный доступ</span>}
      />
      {team.map((m) => (
        <MemberRow
          key={m.email}
          email={m.email}
          badge="Приглашён"
          badgeMuted
          control={
            <>
              <PillSelect<TeamRole>
                value={m.role}
                options={ROLE_OPTIONS.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                onValueChange={(v) => setMemberRole(m.email, v)}
                ariaLabel={`Роль ${m.email}`}
              />
              <Button
                type="button"
                variant="destructive"
                size="icon-xs"
                onClick={() => removeMember(m.email)}
                aria-label={`Убрать ${m.email}`}
              >
                <SettingsIcon name="close" className="h-3.5 w-3.5" />
              </Button>
            </>
          }
        />
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
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-avatar text-2xs font-medium text-ink2">
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
