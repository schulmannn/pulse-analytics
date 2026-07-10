import { useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useLogout } from '@/api/queries';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/nav-icons';
import { SUPER_NAV } from './nav';
import { useDismiss } from './useDismiss';

/** Letter-badge fallback for the account avatar — first two letters of the mailbox name. */
export const avatarInitials = (email?: string) =>
  (email ? email.replace(/@.*/, '').replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase() : '') || '?';

/** Popover shell shared by both account menus — Claude-style card: 12px radius, hairline,
    paper popover surface, 4px inner padding. No shadow (governance). */
export const ACCOUNT_MENU_SHELL = 'overflow-hidden rounded-xl border border-border bg-popover p-1 text-sm';

/** Account-menu row: full-ink label, muted icon, quiet hover — one recipe for links and buttons. */
const ACCOUNT_MENU_ITEM =
  'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-hover-row/60';

const THEME_MODES = [
  { mode: 'light', icon: 'sun', label: 'Светлая тема' },
  { mode: 'system', icon: 'monitor', label: 'Как в системе' },
  { mode: 'dark', icon: 'moon', label: 'Тёмная тема' },
] as const;

/** «Тема» row — a compact light/system/dark segment on the right (the only way back to
    «как в системе» outside Настройки, so all three states live here). */
function ThemeRow() {
  const { theme, mode, setMode } = useTheme();
  return (
    <div className="flex items-center justify-between gap-2.5 rounded px-2.5 py-1">
      <span className="flex items-center gap-2.5 text-foreground">
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} className="h-4 w-4 text-muted-foreground" />
        Тема
      </span>
      <div role="radiogroup" aria-label="Тема оформления" className="flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5">
        {THEME_MODES.map((t) => (
          <button
            key={t.mode}
            type="button"
            role="radio"
            aria-checked={mode === t.mode}
            aria-label={t.label}
            title={t.label}
            onClick={() => setMode(t.mode)}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full transition-colors',
              mode === t.mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name={t.icon} className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Shared account-menu body — Claude-style: identity header (avatar + name + address), theme row,
 * system links (Настройки / Админ / Баги), logout — groups split by hairlines. Rendered inside
 * two popover shells: the mobile-header avatar menu (downward) and the sidebar user row (upward).
 */
export function AccountMenuContent({
  email,
  role,
  avatar,
  onClose,
}: {
  email?: string;
  role?: string;
  avatar?: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const logoutMutation = useLogout();
  const handleLogout = () =>
    logoutMutation.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <>
      {/* Identity header: avatar + mailbox name + full address — who is signed in, at a glance. */}
      {email && (
        <>
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2">
              {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : avatarInitials(email)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{email.replace(/@.*/, '')}</span>
                {role === 'superuser' && (
                  <span className="shrink-0 rounded border border-border px-1 text-2xs leading-4 text-muted-foreground">
                    Админ
                  </span>
                )}
              </div>
              <div className="truncate text-2xs text-muted-foreground">{email}</div>
            </div>
          </div>
          <div className="my-1 border-t border-border" aria-hidden="true" />
        </>
      )}
      {/* Preferences group: Настройки + Подписка + Тема. */}
      <NavLink to="/settings" onClick={onClose} className={ACCOUNT_MENU_ITEM}>
        <Icon name="gear" className="h-4 w-4 text-muted-foreground" />
        Настройки
      </NavLink>
      <NavLink to="/settings?section=billing" onClick={onClose} className={ACCOUNT_MENU_ITEM}>
        <Icon name="card" className="h-4 w-4 text-muted-foreground" />
        Подписка
      </NavLink>
      <ThemeRow />
      {/* Elevated tools (superuser only) — their own group marks them as admin surface. */}
      {role === 'superuser' && (
        <>
          <div className="my-1 border-t border-border" aria-hidden="true" />
          {SUPER_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={onClose} className={ACCOUNT_MENU_ITEM}>
              <Icon name={item.icon} className="h-4 w-4 text-muted-foreground" />
              {item.label}
            </NavLink>
          ))}
        </>
      )}
      <div className="my-1 border-t border-border" aria-hidden="true" />
      {/* Logout: calm by default, destructive only on hover (it's important, not an alarm). */}
      <button
        type="button"
        onClick={handleLogout}
        disabled={logoutMutation.isPending}
        className="group flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
      >
        <Icon name="logout" className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-destructive" />
        {logoutMutation.isPending ? 'Выход…' : 'Выйти'}
      </button>
    </>
  );
}

/**
 * Account menu — an avatar that opens the shared account-menu body downward. MOBILE ONLY now
 * (<md, MobileHeader): on md+ the account moved into the sidebar user row (SidebarUserRow).
 */
export function AccountMenu({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, menuRef, triggerRef);

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Аккаунт"
        aria-expanded={open}
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : avatarInitials(email)}
      </button>
      {open && (
        <div className={cn('absolute right-0 top-full z-popover mt-1 w-64', ACCOUNT_MENU_SHELL)}>
          <AccountMenuContent email={email} role={role} avatar={avatar} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
