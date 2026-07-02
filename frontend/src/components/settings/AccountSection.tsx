import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  useChangePassword,
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
  SettingsRow,
} from '@/components/settings/primitives';

/**
 * «Аккаунт» — the identity/appearance/security pane, laid out steep/Claude-style as an inner
 * two-pane: a sticky left rail of in-page section links (Профиль · Оформление · Безопасность)
 * + a right column of hairline-bordered section cards. Rail clicks scroll-to the section; a
 * scroll-spy keeps the matching link active. On mobile the rail collapses to a horizontal
 * pill row above the stacked cards (no horizontal body scroll). Every control keeps its own
 * API call — avatar upload/remove, theme, and the change-password flow.
 */

const PANES = [
  { id: 'profile', label: 'Профиль' },
  { id: 'appearance', label: 'Оформление' },
  { id: 'security', label: 'Безопасность' },
] as const;
type PaneId = (typeof PANES)[number]['id'];

export function AccountSection() {
  const [active, setActive] = useState<PaneId>('profile');
  const scrollRootRef = useRef<HTMLDivElement>(null);
  // Rail clicks set a short intent lock so the scroll-spy doesn't fight the smooth-scroll animation.
  const lockUntil = useRef(0);

  const goto = useCallback((id: PaneId) => {
    setActive(id);
    lockUntil.current = Date.now() + 700;
    document.getElementById(`account-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Scroll-spy: activate the section nearest the top of the content pane. Guarded by the intent
  // lock (rail clicks) and degrades gracefully where IntersectionObserver is unavailable (tests).
  useEffect(() => {
    const node = scrollRootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    // The real scroll container is an ANCESTOR (the Settings dialog's overflow-y-auto pane),
    // not this inner div — observe against it so the spy tracks on manual scroll, not just clicks.
    let root: Element | null = node.parentElement;
    while (root && root !== document.body) {
      const oy = getComputedStyle(root).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      root = root.parentElement;
    }
    if (!root || root === document.body) root = null; // viewport fallback
    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < lockUntil.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = visible?.target.getAttribute('data-pane') as PaneId | undefined;
        if (id) setActive(id);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    PANES.forEach((p) => {
      const el = document.getElementById(`account-${p.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-8">
      {/* Left rail (md+): sticky in-page section links. Mobile: a horizontal pill row on top. */}
      <nav
        aria-label="Разделы аккаунта"
        className="md:sticky md:top-0 md:w-[180px] md:shrink-0 md:self-start"
      >
        <ul className="flex gap-1.5 overflow-x-auto pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
          {PANES.map((p) => (
            <li key={p.id} className="shrink-0">
              <button
                type="button"
                onClick={() => goto(p.id)}
                aria-current={active === p.id ? 'true' : undefined}
                className={cn(
                  'w-full whitespace-nowrap rounded px-3 py-1.5 text-left text-sm transition-colors',
                  active === p.id
                    ? 'bg-hover-row font-medium text-foreground'
                    : 'text-ink2 hover:bg-hover-row/60 hover:text-foreground',
                )}
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Right content column: the grouped section cards. scroll-spy observes within this root. */}
      <div ref={scrollRootRef} className="min-w-0 flex-1 space-y-8">
        <ProfileGroup />
        <AppearanceGroup />
        <SecurityGroup />
      </div>
    </div>
  );
}

/** Wrapper that anchors a section for the rail links + scroll-spy. */
function PaneAnchor({ id, children }: { id: PaneId; children: ReactNode }) {
  return (
    <div id={`account-${id}`} data-pane={id} className="scroll-mt-4">
      {children}
    </div>
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
    <PaneAnchor id="profile">
      <SettingsGroup title="Профиль" description="Как вы выглядите и входите в Atlavue.">
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
    </PaneAnchor>
  );
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
  { value: 'system', label: 'Системная' },
];

function AppearanceGroup() {
  return (
    <PaneAnchor id="appearance">
      <SettingsGroup title="Оформление" description="Внешний вид интерфейса на этом устройстве.">
        <SettingsRow
          title="Тема"
          description="Светлая, тёмная или как в системе."
          control={<ThemeControl />}
        />
      </SettingsGroup>
    </PaneAnchor>
  );
}

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

const PW_INPUT =
  'w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-ink3 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';
const PW_LABEL = 'mb-1.5 block text-xs font-medium text-ink2';
const BTN_PRIMARY =
  'rounded bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';

/** «Безопасность» — change the account password (POST /api/auth/change-password). */
function SecurityGroup() {
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
    <PaneAnchor id="security">
      <SettingsGroup title="Безопасность" description="Пароль от входа в аккаунт.">
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
                  className={PW_INPUT}
                  value={next}
                  onChange={(e) => {
                    setNext(e.target.value);
                    setErr(null);
                    setDone(false);
                  }}
                  disabled={changePassword.isPending}
                />
                {tooShort && <p className="mt-1 text-2xs text-ink3">Минимум 8 символов.</p>}
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
                  className={PW_INPUT}
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setErr(null);
                    setDone(false);
                  }}
                  disabled={changePassword.isPending}
                />
                {mismatch && <p className="mt-1 text-2xs text-destructive">Пароли не совпадают.</p>}
              </div>

              <div className="flex items-center gap-3 pt-0.5" aria-live="polite">
                <button type="submit" className={BTN_PRIMARY} disabled={!canSubmit}>
                  {changePassword.isPending ? 'Сохранение…' : 'Изменить пароль'}
                </button>
                {done && <span className="text-xs font-medium text-primary">Пароль изменён</span>}
              </div>
              {err && <p className="text-xs font-medium text-destructive">{err}</p>}
            </form>
          }
        />
      </SettingsGroup>
    </PaneAnchor>
  );
}
