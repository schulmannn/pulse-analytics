import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  useChangePassword,
  useDeleteAccount,
  useMe,
  useRemoveAvatar,
  useUpdateAvatar,
} from '@/api/queries';
import { ApiError } from '@/api/client';
import { resizeImageToDataUrl } from '@/lib/image';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BTN_DESTRUCTIVE,
  BTN_SECONDARY,
  SettingsGroup,
  SettingsIcon,
  SettingsRow,
  type SettingsIconName,
} from '@/components/settings/primitives';

/**
 * The account panes — Профиль / Оформление / Безопасность. Each is its own dialog section
 * (left-nav item), so panes hold ONLY their rows: open hairline ledger, no inner rail,
 * no scroll-spy, no duplicated heading (the dialog header already names the pane).
 */

export function ProfileSection() {
  const me = useMe();
  const updateAvatar = useUpdateAvatar();
  const removeAvatar = useRemoveAvatar();
  const [err, setErr] = useState<string | null>(null);

  const avatar = me.data?.avatar;
  const email = me.data?.email ?? '';
  const initials =
    (email
      ? email
          .replace(/@.*/, '')
          .replace(/[^\p{L}]/gu, '')
          .slice(0, 2)
          .toUpperCase()
      : '') || '?';

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr(null);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256, 0.85);
      await updateAvatar.mutateAsync(dataUrl);
    } catch (error) {
      setErr(
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Не удалось загрузить фото',
      );
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow
        title="Фото профиля"
        description="PNG, JPEG или WebP — уменьшим до 256 px."
        control={
          <>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-xs font-medium text-ink2">
              {avatar ? (
                <img
                  src={avatar}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                initials
              )}
            </span>
            <label className={cn(BTN_SECONDARY, 'cursor-pointer')}>
              {updateAvatar.isPending
                ? 'Загрузка…'
                : avatar
                  ? 'Сменить фото'
                  : 'Загрузить фото'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={onFile}
                disabled={updateAvatar.isPending}
              />
            </label>
            {avatar && (
              <button
                type="button"
                onClick={() => removeAvatar.mutate()}
                disabled={removeAvatar.isPending}
                className={BTN_DESTRUCTIVE}
              >
                Удалить
              </button>
            )}
          </>
        }
        footer={
          err ? (
            <p className="mt-2 text-xs font-medium text-destructive">{err}</p>
          ) : null
        }
      />
      <SettingsRow
        title="Email"
        description="Адрес, с которым вы входите в Atlavue."
        control={
          <span className="font-mono text-xs text-ink2">{email || '—'}</span>
        }
      />
    </SettingsGroup>
  );
}

const THEME_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  icon: SettingsIconName;
}> = [
  { value: 'light', label: 'Светлая', icon: 'sun' },
  { value: 'system', label: 'Системная', icon: 'monitor' },
  { value: 'dark', label: 'Тёмная', icon: 'moon' },
];

export function AppearanceSection() {
  return (
    <SettingsGroup>
      <SettingsRow
        title="Тема"
        description="Внешний вид интерфейса на этом устройстве."
        control={<ThemeControl />}
      />
    </SettingsGroup>
  );
}

/** Pill segment Светлая | Системная | Тёмная — same store the account-menu segment uses. */
function ThemeControl() {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="group"
      aria-label="Тема интерфейса"
      className="flex items-center gap-0.5 rounded-full border border-border p-0.5"
    >
      {THEME_OPTIONS.map((option) => {
        const active = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setMode(option.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <SettingsIcon name={option.icon} className="h-3.5 w-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** «Безопасность» — change the account password (POST /api/auth/change-password). */
export function SecuritySection() {
  const changePassword = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    !changePassword.isPending &&
    current.length > 0 &&
    next.length >= 8 &&
    confirm === next;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setDone(false);
    if (next.length < 8) {
      setErr('Новый пароль минимум 8 символов');
      return;
    }
    if (next !== confirm) {
      setErr('Пароли не совпадают');
      return;
    }
    try {
      await changePassword.mutateAsync({ current, next });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (error) {
      setErr(
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Не удалось изменить пароль',
      );
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow
        title="Пароль"
        description="Минимум 8 символов. После смены другие сессии остаются активными."
        footer={
          <form
            onSubmit={onSubmit}
            className="mt-4 w-full max-w-[340px] space-y-3"
          >
            <div>
              <Label htmlFor="pw-current" className="mb-1.5 block">
                Текущий пароль
              </Label>
              <Input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => {
                  setCurrent(e.target.value);
                  setErr(null);
                  setDone(false);
                }}
                disabled={changePassword.isPending}
              />
            </div>
            <div>
              <Label htmlFor="pw-next" className="mb-1.5 block">
                Новый пароль
              </Label>
              <Input
                id="pw-next"
                type="password"
                autoComplete="new-password"
                minLength={8}
                aria-invalid={tooShort || undefined}
                aria-describedby={tooShort ? 'pw-next-hint' : undefined}
                value={next}
                onChange={(e) => {
                  setNext(e.target.value);
                  setErr(null);
                  setDone(false);
                }}
                disabled={changePassword.isPending}
              />
              {tooShort && (
                <p id="pw-next-hint" className="mt-1 text-2xs text-ink3">
                  Минимум 8 символов.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="pw-confirm" className="mb-1.5 block">
                Повторите новый пароль
              </Label>
              <Input
                id="pw-confirm"
                type="password"
                autoComplete="new-password"
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'pw-confirm-err' : undefined}
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setErr(null);
                  setDone(false);
                }}
                disabled={changePassword.isPending}
              />
              {mismatch && (
                <p
                  id="pw-confirm-err"
                  className="mt-1 text-2xs text-destructive"
                >
                  Пароли не совпадают.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 pt-0.5" aria-live="polite">
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {changePassword.isPending ? 'Сохранение…' : 'Изменить пароль'}
              </Button>
              {done && <Badge variant="success">Пароль изменён</Badge>}
            </div>
            {err && (
              <Alert variant="destructive" className="py-2.5">
                <AlertDescription className="text-xs">{err}</AlertDescription>
              </Alert>
            )}
          </form>
        }
      />
      <DeleteAccountRow />
    </SettingsGroup>
  );
}

/**
 * GDPR F4 (self-serve): немедленное и необратимое стирание аккаунта. Подтверждение — точный
 * email аккаунта (пароль не фактор: Google-аккаунты живут без него). Суперюзеру строка не
 * показывается — сервер его всё равно не удалит (иначе одна кнопка оставляет приложение без
 * владельца). После успеха — полная перезагрузка на лендинг: сессия и кэш уже вычищены хуком.
 */
function DeleteAccountRow() {
  const me = useMe();
  const deleteAccount = useDeleteAccount();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const email = me.data?.email ?? '';
  if (me.data?.role === 'superuser') return null;

  const match =
    confirm.trim().toLowerCase() === email.toLowerCase() && email.length > 0;

  const onDelete = async (e: FormEvent) => {
    e.preventDefault();
    if (!match || deleteAccount.isPending) return;
    setErr(null);
    try {
      await deleteAccount.mutateAsync(confirm.trim());
      window.location.assign('/');
    } catch (error) {
      setErr(
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Не удалось удалить аккаунт',
      );
    }
  };

  return (
    <SettingsRow
      title="Удалить аккаунт"
      description="Немедленно и безвозвратно: каналы, архивы, отчёты, подключения. Копии в резервных бэкапах исчезают при их ротации (до 30 дней)."
      control={
        <AlertDialog
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (!nextOpen && !deleteAccount.isPending) {
              setConfirm('');
              setErr(null);
            }
          }}
        >
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive" size="sm">
              Удалить аккаунт
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md">
            <form onSubmit={onDelete} className="space-y-4">
              <AlertDialogHeader>
                <AlertDialogTitle>Удалить аккаунт навсегда?</AlertDialogTitle>
                <AlertDialogDescription>
                  Действие нельзя отменить. Введите email{' '}
                  <strong className="font-medium text-foreground">
                    {email}
                  </strong>
                  , чтобы подтвердить удаление всех данных.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="del-confirm">Email аккаунта</Label>
                <Input
                  id="del-confirm"
                  type="email"
                  autoComplete="off"
                  autoFocus
                  placeholder={email}
                  value={confirm}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    setErr(null);
                  }}
                  disabled={deleteAccount.isPending}
                />
              </div>
              {err && (
                <Alert variant="destructive" className="py-2.5">
                  <AlertDescription className="text-xs">{err}</AlertDescription>
                </Alert>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteAccount.isPending}>
                  Отмена
                </AlertDialogCancel>
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={!match || deleteAccount.isPending}
                >
                  {deleteAccount.isPending ? 'Удаление…' : 'Удалить навсегда'}
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}
