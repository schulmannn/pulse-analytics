import type { ChangeEvent } from 'react';
import { useAdminUsers, useUpdateUser } from '@/api/queries';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/ErrorState';
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
  const { data, isLoading, isError, error } = useAdminUsers();

  if (isLoading) return <AdminSkeleton />;
  if (isError) {
    return <ErrorState title="Не удалось загрузить админку" reason={error instanceof Error ? error.message : 'ошибка сервера'} />;
  }

  const users = data?.users ?? [];
  const roles = data?.roles ?? [];
  const statuses = data?.statuses ?? [];
  const me = data?.me ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-medium tracking-tight">Управление пользователями</h2>
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
  const updateUserMutation = useUpdateUser(user.id);
  const isDisabled = isMe || updateUserMutation.isPending;

  const handleRoleChange = (e: ChangeEvent<HTMLSelectElement>) => updateUserMutation.mutate({ role: e.target.value });
  const handleStatusChange = (e: ChangeEvent<HTMLSelectElement>) => updateUserMutation.mutate({ status: e.target.value });

  return (
    <div className={isMe ? 'bg-muted/30' : 'bg-background'}>
      <div className="flex flex-col justify-between gap-4 p-4 md:flex-row md:items-center">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="max-w-xs truncate text-sm font-medium text-foreground">
              {user.email || <span className="italic text-muted-foreground">без email</span>}
            </span>
            {isMe && (
              <span className="select-none rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">(вы)</span>
            )}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            #{user.id}
            {user.created_at ? ` · ${fmt.date(user.created_at)}` : ''}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 self-end md:self-auto">
          <select
            value={user.role ?? ''}
            onChange={handleRoleChange}
            disabled={isDisabled}
            className="rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="" disabled>Роль</option>
            {availableRoles.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>
            ))}
          </select>
          <select
            value={user.status ?? ''}
            onChange={handleStatusChange}
            disabled={isDisabled}
            className="rounded border border-border bg-background px-2 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="" disabled>Статус</option>
            {availableStatuses.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s] || s}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function AdminSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-8 w-full" /></CardContent></Card>
        ))}
      </div>
    </div>
  );
}
