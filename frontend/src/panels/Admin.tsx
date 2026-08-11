import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAdminDeleteUser, useAdminUsers, useUpdateUser } from '@/api/queries';
import { useConfirm } from '@/components/ConfirmDialogProvider';
import { ErrorState } from '@/components/ErrorState';
import { PillSelect } from '@/components/PillSelect';
import { fmt } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';

const ROLE_LABELS: Record<string, string> = { user: 'Пользователь', superuser: 'Админ' };
const STATUS_LABELS: Record<string, string> = {
  unverified: 'Не подтверждён',
  pending: 'Ожидает',
  active: 'Активен',
  disabled: 'Отключён',
};

export function Admin() {
  const { data, isLoading, isError, error, refetch } = useAdminUsers();

  if (isLoading) return <AdminSkeleton />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить админку" reason={error instanceof Error ? error.message : 'ошибка сервера'} onRetry={() => refetch()} />;
  }

  const users = data?.users ?? [];
  const roles = data?.roles ?? [];
  const statuses = data?.statuses ?? [];
  const me = data?.me ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-medium tracking-tight">Управление пользователями</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Роли доступа и статусы аккаунтов</p>
      </div>

      {users.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">Пользователи не найдены.</div>
      ) : (
        <div className="grid grid-cols-1 gap-px border-t border-border bg-border">
          {users.map((user) => (
            <UserRowCard key={user.id} user={user} availableRoles={roles} availableStatuses={statuses} isMe={me === user.id} />
          ))}
        </div>
      )}
    </div>
  );
}

interface UserRowCardProps {
  user: { id: number; email?: string | null; role?: string | null; status?: string | null; created_at?: string | null };
  availableRoles: string[];
  availableStatuses: string[];
  isMe: boolean;
}

function UserRowCard({ user, availableRoles, availableStatuses, isMe }: UserRowCardProps) {
  const confirm = useConfirm();
  const updateUserMutation = useUpdateUser(user.id);
  const [failed, setFailed] = useState<string | null>(null);
  const isDisabled = isMe || updateUserMutation.isPending;

  // Провал PATCH раньше уходил в никуда: пилюля оставалась со старым значением, и админ был
  // уверен, что роль сменилась. Теперь сбой виден в строке пользователя и озвучивается AT.
  const apply = (patch: { role?: string; status?: string }, whatFailed: string) => {
    setFailed(null);
    updateUserMutation.mutate(patch, {
      onError: (e) => setFailed(e instanceof Error ? e.message : whatFailed),
    });
  };

  const handleRoleChange = (role: string) => {
    // Выдача админских прав — самое привилегированное действие приложения; до сих пор оно
    // совершалось одним выбором в выпадашке, без единого вопроса. Понижение и прочие роли
    // подтверждения не требуют: они не расширяют доступ.
    if (role === 'admin') {
      void (async () => {
        const ok = await confirm({
          title: 'Выдать права администратора?',
          reason: `${user.email || 'Этот пользователь'} получит доступ к списку пользователей, сможет менять роли и статусы других и удалять аккаунты. Смена роли также завершит все активные сессии пользователя.`,
          actionLabel: 'Выдать права',
        });
        if (ok) apply({ role }, 'Не удалось сменить роль.');
      })();
      return;
    }
    apply({ role }, 'Не удалось сменить роль.');
  };
  const handleStatusChange = (status: string) => apply({ status }, 'Не удалось сменить статус.');

  return (
    <div className={isMe ? 'bg-muted/30' : 'bg-background'}>
      <div className="flex flex-col justify-between gap-4 p-4 md:flex-row md:items-center">
        <div className="space-y-0.5">
          {failed && (
            <p role="alert" className="text-2xs font-medium text-destructive">{failed}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="max-w-xs truncate text-sm font-medium text-foreground">
              {user.email || <span className="italic text-muted-foreground">без email</span>}
            </span>
            {isMe && (
              <span className="select-none rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-accent-foreground">(вы)</span>
            )}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            #{user.id}
            {user.created_at ? ` · ${fmt.date(user.created_at)}` : ''}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 self-end md:self-auto">
          <PillSelect
            value={user.role ?? ''}
            options={[
              { value: '', label: 'Роль', disabled: true },
              ...availableRoles.map((r) => ({ value: r, label: ROLE_LABELS[r] || r })),
            ]}
            onValueChange={handleRoleChange}
            disabled={isDisabled}
            ariaLabel={`Роль ${user.email || `#${user.id}`}`}
          />
          <PillSelect
            value={user.status ?? ''}
            options={[
              { value: '', label: 'Статус', disabled: true },
              ...availableStatuses.map((s) => ({ value: s, label: STATUS_LABELS[s] || s })),
            ]}
            onValueChange={handleStatusChange}
            disabled={isDisabled}
            ariaLabel={`Статус ${user.email || `#${user.id}`}`}
          />
          <DeleteUserButton user={user} isMe={isMe} />
        </div>
      </div>
    </div>
  );
}

/**
 * GDPR F4 (admin-путь): стирание аккаунта со всеми данными. Двухшаговое подтверждение прямо в
 * кнопке (первый клик взводит, второй удаляет; через 4 с взвод спадает) — без alert-канона.
 * Себя и суперюзеров не удалить: кнопка скрыта, сервер продублирует запрет.
 */
function DeleteUserButton({ user, isMe }: { user: UserRowCardProps['user']; isMe: boolean }) {
  const deleteUser = useAdminDeleteUser();
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Взвод не спадает во время запроса: таймер гейтится на isPending, иначе стиль кнопки
  // откатывался в спокойный прямо посреди «Удаление…» (дизайн-проход №3).
  useEffect(() => {
    if (!armed || deleteUser.isPending) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed, deleteUser.isPending]);

  if (isMe || user.role === 'superuser') return null;

  const onClick = async () => {
    if (!armed) {
      setArmed(true);
      setErr(null);
      return;
    }
    try {
      await deleteUser.mutateAsync(user.id);
      toast('Пользователь удалён');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить');
      setArmed(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      {err && <span className="text-2xs font-medium text-destructive">{err}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={deleteUser.isPending}
        aria-label={
          armed
            ? `Подтвердить удаление аккаунта ${user.email || `#${user.id}`}`
            : `Удалить аккаунт ${user.email || `#${user.id}`}`
        }
        // Общая часть классов держит transition-colors в ОБОИХ состояниях — снятие взвода по
        // таймеру больше не схлопывается рывком (проход №3).
        className={`rounded border px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
          armed
            ? 'border-destructive bg-destructive text-destructive-foreground'
            : 'border-border bg-background text-destructive hover:border-destructive/40'
        }`}
      >
        {deleteUser.isPending ? 'Удаление…' : armed ? 'Точно удалить?' : 'Удалить'}
      </button>
    </span>
  );
}

function AdminSkeleton() {
  // Зеркалит ЗАГРУЖЕННЫЙ лейаут (плоский hairline-леджер), а не старый card-грид —
  // скелетон обещал другую страницу и вызывал layout-jump (дизайн-проход №3).
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <div className="grid grid-cols-1 gap-px border-t border-border bg-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-background p-4">
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
