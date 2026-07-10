import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
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
    (email ? email.replace(/@.*/, '').replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase() : '') || '?';

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
              {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initials}
            </span>
            <label className={cn(BTN_SECONDARY, 'cursor-pointer')}>
              {updateAvatar.isPending ? 'Загрузка…' : avatar ? 'Сменить фото' : 'Загрузить фото'}
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
        footer={err ? <p className="mt-2 text-xs font-medium text-destructive">{err}</p> : null}
      />
      <SettingsRow
        title="Email"
        description="Адрес, с которым вы входите в Atlavue."
        control={<span className="font-mono text-xs text-ink2">{email || '—'}</span>}
      />
    </SettingsGroup>
  );
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: SettingsIconName }> = [
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

const PW_INPUT =
  'w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-ink3 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';
const PW_LABEL = 'mb-1.5 block text-xs font-medium text-ink2';
const BTN_PRIMARY =
  'btn-pill bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';

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
          <form onSubmit={onSubmit} className="mt-4 w-full max-w-[340px] space-y-3">
            <div>
              <label htmlFor="pw-current" className={PW_LABEL}>
                Текущий пароль
              </label>
              <input
                id="pw-current"
                type="password"
                autoComplete="current-password"
                className={PW_INPUT}
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
              <label htmlFor="pw-next" className={PW_LABEL}>
                Новый пароль
              </label>
              <input
                id="pw-next"
                type="password"
                autoComplete="new-password"
                minLength={8}
                aria-invalid={tooShort || undefined}
                aria-describedby={tooShort ? 'pw-next-hint' : undefined}
                className={PW_INPUT}
                value={next}
                onChange={(e) => {
                  setNext(e.target.value);
                  setErr(null);
                  setDone(false);
                }}
                disabled={changePassword.isPending}
              />
              {tooShort && <p id="pw-next-hint" className="mt-1 text-2xs text-ink3">Минимум 8 символов.</p>}
            </div>
            <div>
              <label htmlFor="pw-confirm" className={PW_LABEL}>
                Повторите новый пароль
              </label>
              <input
                id="pw-confirm"
                type="password"
                autoComplete="new-password"
                aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'pw-confirm-err' : undefined}
                className={PW_INPUT}
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setErr(null);
                  setDone(false);
                }}
                disabled={changePassword.isPending}
              />
              {mismatch && <p id="pw-confirm-err" className="mt-1 text-2xs text-destructive">Пароли не совпадают.</p>}
            </div>

            <div className="flex items-center gap-3 pt-0.5" aria-live="polite">
              <button type="submit" className={BTN_PRIMARY} disabled={!canSubmit}>
                {changePassword.isPending ? 'Сохранение…' : 'Изменить пароль'}
              </button>
              {done && <span className="text-xs font-medium text-primary">Пароль изменён</span>}
            </div>
            {err && <p role="alert" className="text-xs font-medium text-destructive">{err}</p>}
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
  // Открытие/отмена размонтируют сфокусированный элемент — возвращаем фокус явно.
  const openerRef = useRef<HTMLButtonElement>(null);

  const email = me.data?.email ?? '';
  if (me.data?.role === 'superuser') return null;

  const match = confirm.trim().toLowerCase() === email.toLowerCase() && email.length > 0;

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
        !open ? (
          <button ref={openerRef} type="button" onClick={() => setOpen(true)} className={BTN_DESTRUCTIVE}>
            Удалить аккаунт
          </button>
        ) : null
      }
      footer={
        open ? (
          <form onSubmit={onDelete} className="mt-4 w-full max-w-[340px] space-y-3">
            <div>
              <label htmlFor="del-confirm" className={PW_LABEL}>
                Введите email аккаунта для подтверждения
              </label>
              <input
                id="del-confirm"
                type="email"
                autoComplete="off"
                autoFocus
                placeholder={email}
                className={PW_INPUT}
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setErr(null);
                }}
                disabled={deleteAccount.isPending}
              />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" className={BTN_DESTRUCTIVE} disabled={!match || deleteAccount.isPending}>
                {deleteAccount.isPending ? 'Удаление…' : 'Удалить навсегда'}
              </button>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => {
                  setOpen(false);
                  setConfirm('');
                  setErr(null);
                  requestAnimationFrame(() => openerRef.current?.focus());
                }}
                disabled={deleteAccount.isPending}
              >
                Отмена
              </button>
            </div>
            {err && <p role="alert" className="text-xs font-medium text-destructive">{err}</p>}
          </form>
        ) : null
      }
    />
  );
}
