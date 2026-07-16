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
import { cn } from '@/lib/utils';
import { PillSelect } from '@/components/PillSelect';
import {
  BTN_DESTRUCTIVE,
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
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErr(null);
              }}
              placeholder="email коллеги"
              disabled={full}
              className="w-full flex-1 rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-ink3 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            />
            <div className="flex shrink-0 items-center gap-2">
              <PillSelect<TeamRole>
                value={role}
                options={ROLE_OPTIONS.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                onValueChange={(v) => setRole(v)}
                disabled={full}
                ariaLabel="Роль"
              />
              <button
                type="submit"
                disabled={full || email.trim().length === 0}
                className="btn-pill bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                Пригласить
              </button>
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
              <button
                type="button"
                onClick={() => removeMember(m.email)}
                aria-label={`Убрать ${m.email}`}
                className={cn(BTN_DESTRUCTIVE, 'px-2.5')}
              >
                <SettingsIcon name="close" className="h-3.5 w-3.5" />
              </button>
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
          <div className={cn('text-2xs', badgeMuted ? 'text-muted-foreground' : 'text-primary')}>
            {badge}
          </div>
        </div>
      </div>
      {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
    </div>
  );
}
