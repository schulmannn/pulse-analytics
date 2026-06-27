import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChannels, useLogout } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { useTheme } from '@/lib/theme';
import { fmt } from '@/lib/format';
import { Icon, type IconName } from '@/components/nav-icons';

/** Close a popover/dropdown on Escape, and (when a ref is given) on outside mousedown.
    Outside-click via a document listener instead of a scrim avoids stacking-context traps. */
function useDismiss(active: boolean, setOpen: Dispatch<SetStateAction<boolean>>, ref?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = ref
      ? (e: MouseEvent) => {
          if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
      : null;
    document.addEventListener('keydown', onKey);
    if (onDown) document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [active, setOpen, ref]);
}

interface NavLinkDef {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const NAV: NavLinkDef[] = [
  { to: '/', label: 'Обзор', icon: 'overview', end: true },
  { to: '/analytics', label: 'Аналитика', icon: 'analytics' },
  { to: '/posts', label: 'Посты', icon: 'posts' },
  { to: '/mentions', label: 'Упоминания', icon: 'mentions' },
];
const SYSTEM_NAV: NavLinkDef[] = [{ to: '/settings', label: 'Настройки', icon: 'settings' }];
const SUPER_NAV: NavLinkDef[] = [
  { to: '/admin', label: 'Админ', icon: 'admin' },
  { to: '/bugs', label: 'Баги', icon: 'bugs' },
];

const TITLES: Record<string, string> = {
  '/': 'Обзор',
  '/analytics': 'Аналитика',
  '/posts': 'Посты',
  '/mentions': 'Упоминания',
  '/settings': 'Настройки',
  '/admin': 'Админ',
  '/bugs': 'Баги',
  '/connect': 'Подключение данных',
};

const PERIODS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

// Platform brand colors (platform identity, not the app palette — intentional hex).
const PLATFORMS = [
  { key: 'tg', name: 'Telegram', color: '#229ED9', active: true, soon: false },
  { key: 'ig', name: 'Instagram', color: '#E1306C', active: false, soon: false },
];

/** Brand glyph for the platform chip (white, on the brand-colored square). */
function PlatformGlyph({ k, className }: { k: string; className?: string }) {
  if (k === 'tg') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
      </svg>
    );
  }
  if (k === 'ig') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
        <circle cx="12" cy="12" r="4.2" />
        <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return null;
}

interface DashboardLayoutProps {
  email?: string;
  role?: string;
}

/** App shell: left sidebar (brand + channel + nav) and a top bar (title + period + menu). */
export function DashboardLayout({ email, role }: DashboardLayoutProps) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar email={email} role={role} />
        {/* Channel identity + switcher for mobile (the sidebar card is hidden below md). */}
        <div className="border-b py-2 md:hidden">
          <ChannelCard />
        </div>
        <MobileNav role={role} />
        <main className="flex-1 px-4 py-5 sm:px-6">
          <div className="mx-auto w-full max-w-screen-2xl">
            <PlatformSwitcher />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({ role }: { role?: string }) {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/30 md:flex">
      <div className="flex items-center gap-2.5 px-5 pt-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">
          P
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Pulse</span>
      </div>

      <div className="mt-4">
        <ChannelCard />
      </div>

      <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
        <p className="px-3 pb-1 pt-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Система
        </p>
        {SYSTEM_NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
        {role === 'superuser' && SUPER_NAV.map((item) => <NavItem key={item.to} {...item} />)}
      </nav>

      <div className="px-3 pb-4">
        <SearchBox />
      </div>
    </aside>
  );
}

/** Horizontal nav for mobile (the sidebar is hidden below md). */
function MobileNav({ role }: { role?: string }) {
  const items = role === 'superuser' ? [...NAV, ...SYSTEM_NAV, ...SUPER_NAV] : [...NAV, ...SYSTEM_NAV];
  return (
    <nav className="flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              isActive ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`
          }
        >
          <Icon name={item.icon} className="h-4 w-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

function NavItem({ to, label, icon, end }: NavLinkDef) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
          isActive
            ? 'bg-primary/15 font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        }`
      }
    >
      <Icon name={icon} className="h-[18px] w-[18px] shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function ChannelCard() {
  const { data } = useChannels();
  const { channelId, setChannelId } = useSelectedChannel();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const channels = data?.channels ?? [];

  // Initialise the selected channel once the list loads (drives X-Channel-Id).
  useEffect(() => {
    if (!data || channelId != null || channels.length === 0) return;
    setChannelId(data.selected ?? channels[0].id);
  }, [channelId, channels, data, setChannelId]);

  useDismiss(open, setOpen, cardRef);

  const current = channels.find((c) => c.id === channelId) ?? channels[0];
  const handle = current ? `@${current.username || current.title || current.id}` : '@—';
  const initial = (current?.username || current?.title || 'T').slice(0, 1).toUpperCase();
  const count = current?.memberCount;
  const subtitle =
    count != null && count > 0
      ? `${fmt.short(count)} подписчиков`
      : current?.source === 'collector'
        ? 'Collector'
        : 'Telegram';
  const multi = channels.length >= 2;

  const pick = (id: number) => {
    setChannelId(id);
    void queryClient.cancelQueries();
    setOpen(false);
  };

  return (
    <div ref={cardRef} className="relative px-3">
      <button
        type="button"
        onClick={() => multi && setOpen((o) => !o)}
        className={`flex w-full items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left transition-colors ${
          multi ? 'hover:bg-muted/50' : 'cursor-default'
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{handle}</span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </span>
        {multi && <Icon name="chevron" className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>

      {open && multi && (
        <div className="absolute inset-x-3 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover p-1 shadow-md">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => pick(channel.id)}
              className={`block w-full truncate rounded px-2.5 py-1.5 text-left text-sm transition-colors ${
                channel.id === channelId
                  ? 'bg-primary/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              @{channel.username || channel.title || channel.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchBox() {
  // Opens the global ⌘K command palette (mounted in App.tsx) by replaying the shortcut.
  const openPalette = () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }));
  return (
    <button
      type="button"
      onClick={openPalette}
      className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <Icon name="search" className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Поиск</span>
      <kbd className="rounded border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}

function Topbar({ email, role }: { email?: string; role?: string }) {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? 'Pulse';
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b bg-background/80 px-4 py-3 backdrop-blur sm:px-6">
      <h1 className="truncate text-lg font-semibold">{title}</h1>
      <div className="flex items-center gap-2">
        <PeriodSwitcher />
        <button
          type="button"
          className="rounded-lg border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Уведомления"
        >
          <Icon name="bell" className="h-4 w-4" />
        </button>
        <MoreMenu email={email} role={role} />
      </div>
    </header>
  );
}

function MoreMenu({ email, role }: { email?: string; role?: string }) {
  const [open, setOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const logoutMutation = useLogout();
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, menuRef);

  const handleLogout = () =>
    logoutMutation.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Меню"
      >
        <Icon name="more" strokeWidth={2.4} className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border bg-popover p-1.5 text-sm shadow-md">
          {email && (
            <div className="flex items-center gap-1.5 truncate px-2.5 py-1.5 text-xs text-muted-foreground">
              <span className="truncate">{email}</span>
              {role === 'superuser' && (
                <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">super</span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={toggle}
            className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span>Тема</span>
            <span className="text-xs">{theme === 'dark' ? 'тёмная' : 'светлая'}</span>
          </button>
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="block w-full rounded px-2.5 py-1.5 text-left text-destructive transition-colors hover:bg-muted disabled:opacity-50"
          >
            {logoutMutation.isPending ? 'Выход…' : 'Выйти'}
          </button>
        </div>
      )}
    </div>
  );
}

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

function PeriodSwitcher() {
  const { days, setDays, range, setRange } = usePeriod();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen); // Escape closes; outside-click handled by the scrim (date inputs stay safe)

  const seg = (active: boolean) =>
    `rounded-md px-3 py-1 text-xs font-medium transition-colors ${
      active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
    }`;

  const toggle = () => {
    if (open) return setOpen(false);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  const apply = () => {
    const f = Date.parse(from);
    const t = Date.parse(to);
    if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) return;
    setRange({ from: f, to: t + 24 * 60 * 60 * 1000 - 1 }); // inclusive end-of-day
    setOpen(false);
  };

  const reset = () => {
    setFrom('');
    setTo('');
    setDays(30); // also clears the range
    setOpen(false);
  };

  return (
    <div className="flex items-center">
      <div className="inline-flex items-center rounded-lg border bg-muted p-0.5">
        {PERIODS.map((period) => (
          <button
            key={period.days}
            type="button"
            onClick={() => setDays(period.days)}
            className={seg(range === null && days === period.days)}
          >
            {period.label}
          </button>
        ))}
        <button
          ref={btnRef}
          type="button"
          onClick={toggle}
          className={`${seg(range !== null)} inline-flex items-center gap-1`}
          title="Произвольный период"
          aria-label="Произвольный период"
        >
          {range ? `${shortDate(range.from)}–${shortDate(range.to)}` : <Icon name="calendar" className="h-3.5 w-3.5" />}
        </button>
      </div>

      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-60 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
            style={{ top: pos.top, right: pos.right }}
          >
            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-muted-foreground">
                С
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <label className="block text-[11px] font-medium text-muted-foreground">
                По
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={apply}
                  className="flex-1 rounded bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Применить
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  Сброс
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Network selector. Only Telegram is live today; others are forthcoming. */
function PlatformSwitcher() {
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {PLATFORMS.map((p) => (
        <div
          key={p.key}
          aria-current={p.active ? 'true' : undefined}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            p.active ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground'
          } ${p.soon ? 'opacity-60' : ''}`}
        >
          <span
            className="flex h-5 w-5 items-center justify-center rounded text-white"
            style={{ backgroundColor: p.color }}
          >
            <PlatformGlyph k={p.key} className="h-3 w-3" />
          </span>
          <span className="font-medium">{p.name}</span>
          {p.active && <span className="sr-only">— активно</span>}
          {p.soon && (
            <span className="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">скоро</span>
          )}
        </div>
      ))}
    </div>
  );
}
