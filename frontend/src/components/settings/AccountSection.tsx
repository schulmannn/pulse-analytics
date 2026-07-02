import { useState, type ChangeEvent } from 'react';
import { useMe, useRemoveAvatar, useUpdateAvatar } from '@/api/queries';
import { ApiError } from '@/api/client';
import { resizeImageToDataUrl } from '@/lib/image';
import { useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import {
  BTN_DESTRUCTIVE,
  BTN_SECONDARY,
  SettingsGroup,
  SettingsRow,
} from '@/components/settings/primitives';

/** «Аккаунт» — profile identity (photo + email) and appearance (theme). */
export function AccountSection() {
  return (
    <>
      <ProfileGroup />
      <SettingsGroup title="Оформление">
        <SettingsRow
          title="Тема"
          description="Светлая, тёмная или как в системе."
          control={<ThemeControl />}
        />
      </SettingsGroup>
    </>
  );
}

function ProfileGroup() {
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
    <SettingsGroup title="Профиль">
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

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
  { value: 'system', label: 'Системная' },
];

/** Segmented Светлая | Тёмная | Системная — same store the account-menu toggle uses. */
function ThemeControl() {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="group"
      aria-label="Тема интерфейса"
      className="grid grid-cols-3 gap-px overflow-hidden rounded border border-border bg-border"
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
              'px-3 py-1.5 text-xs transition-colors',
              active
                ? 'bg-muted/60 font-medium text-foreground'
                : 'bg-background text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
