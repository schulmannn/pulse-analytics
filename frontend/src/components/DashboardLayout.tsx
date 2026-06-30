import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useIgProfile, useLogout, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { useTheme } from '@/lib/theme';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { railMode, useSidebarCollapsed } from '@/lib/sidebar';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { downloadCsv } from '@/lib/csv';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { markdownToPlainText } from '@/lib/markdown';
import { normalizeTgPosts } from '@/lib/posts';
import { Icon, type IconName } from '@/components/nav-icons';
import { PulseMark } from '@/components/PulseMark';
import { ChannelAvatar } from '@/components/ChannelAvatar';
import { DateRangePicker } from '@/components/DateRangePicker';

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
  '/instagram': 'Instagram',
};

const PERIODS: Array<{ days: PeriodDays; label: string }> = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

// Platform brand colors (platform identity, not the app palette — intentional hex).
const PLATFORMS = [
  { key: 'tg', name: 'Telegram', color: '#229ED9', to: '/' },
  { key: 'ig', name: 'Instagram', color: '#E1306C', to: '/instagram' },
];

/** Brand glyph for the platform chip — uses currentColor; the call site tints it the platform's
    brand colour on a neutral chip (no filled square). */
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
        <MobileHeader email={email} role={role} />
        {/* Extra bottom padding on mobile clears the fixed bottom nav; md+ navigates via the sidebar. */}
        <main className="flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-5">
          <div className="mx-auto w-full max-w-screen-2xl">
            <Outlet />
          </div>
        </main>
      </div>
      <MobileBottomNav />
    </div>
  );
}

/**
 * Reveal-on-peek class strings: an element is hidden in the icon-rail and shown when the
 * panel is hovered OR keyboard focus enters it. The focus-within companion is essential —
 * `:hover` never fires on Tab, so without it a keyboard user sees an icon-only rail. Pairs
 * with `focus-within:w-60` on the panel so focusing a rail control expands the peek too.
 */
const REVEAL_BLOCK = 'hidden group-hover/sb:block group-focus-within/sb:block';
const REVEAL_INLINE = 'hidden group-hover/sb:inline group-focus-within/sb:inline';

/**
 * Three-state sidebar. ≥lg: full (w-60) with a manual collapse toggle (persisted).
 * md–lg: auto icon-rail (w-16), labels accessible via title/aria + a hover/focus peek that
 * expands the rail into an overlay (absolute, so content never reflows). <md: hidden
 * (MobileNav takes over). In rail mode the visible panel is absolutely positioned and the
 * w-16 <aside> stays as a layout spacer, so peeking overlays the content instead of
 * pushing it. The aside stays `h-screen sticky top-0`, so the topbar/SectionNav offsets
 * (top-0 / top-14, in the content column) are untouched.
 */
function Sidebar({ role }: { role?: string }) {
  const isLg = useMediaQuery('(min-width: 1024px)');
  const { collapsed, toggle } = useSidebarCollapsed();
  const rail = railMode(isLg, collapsed);

  return (
    <aside
      className={cn(
        // z-30: the aside is `sticky`, so it owns a stacking context; without a z-index the
        // peek panel can't paint above the positive-z-index Topbar (z-20) / SectionNav (z-10)
        // and content bleeds through it. z-30 lifts the whole sidebar above all content while
        // staying under the period scrim (z-40) and modals (z-50).
        'sticky top-0 z-30 hidden h-screen shrink-0 md:block',
        rail ? 'w-16' : 'w-60',
      )}
    >
      <div
        className={cn(
          // White panel sidebar on the warm-paper canvas (Figma) — separated from content by border-r.
          'group/sb flex h-full flex-col border-r bg-card',
          rail
            ? 'absolute inset-y-0 left-0 z-30 w-16 overflow-hidden bg-card transition-[width] duration-200 hover:w-60 focus-within:w-60'
            : 'w-full',
        )}
      >
        <div className="flex items-center gap-2.5 px-4 pt-5">
          {/* Brand glyph on paper (no filled tile) — Figma renders the mark itself in accent blue. */}
          <span className="flex h-8 w-8 shrink-0 items-center justify-center text-primary">
            <PulseMark className="h-6 w-6" />
          </span>
          <span className={cn('flex-1 whitespace-nowrap text-[15px] font-medium tracking-tight', rail && REVEAL_BLOCK)}>
            Pulse
          </span>
        </div>

        <div className="mt-4">
          <ChannelCard rail={rail} />
        </div>

        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
          {/* Платформа данных (платформа) — выше, чем виды дашборда. */}
          {rail ? (
            <p
              className={cn(
                'whitespace-nowrap px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground',
                REVEAL_BLOCK,
              )}
            >
              Платформа
            </p>
          ) : (
            <p className="px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground">Платформа</p>
          )}
          <PlatformNav variant="sidebar" rail={rail} />
          <div className="mx-1 my-2 border-t" aria-hidden="true" />

          {NAV.map((item) => (
            <NavItem key={item.to} {...item} rail={rail} />
          ))}
          {rail ? (
            <div className="px-2 pb-1 pt-4">
              <div className="border-t group-hover/sb:hidden group-focus-within/sb:hidden" aria-hidden="true" />
              <p
                className={cn(
                  'whitespace-nowrap pt-1 text-[11px] font-medium tracking-wider text-muted-foreground',
                  REVEAL_BLOCK,
                )}
              >
                Система
              </p>
            </div>
          ) : (
            <p className="px-3 pb-1 pt-5 text-[11px] font-medium tracking-wider text-muted-foreground">
              Система
            </p>
          )}
          {SYSTEM_NAV.map((item) => (
            <NavItem key={item.to} {...item} rail={rail} />
          ))}
          {role === 'superuser' && SUPER_NAV.map((item) => <NavItem key={item.to} {...item} rail={rail} />)}
        </nav>

        <div className="space-y-1 px-3 pb-4">
          <SearchBox rail={rail} />
          {/* Manual collapse only exists at lg; below it the rail is responsive-forced.
              Kept always-visible + focusable (never display:none) so a keyboard/touch user
              who collapses can always re-expand. */}
          {isLg && <CollapseToggle collapsed={collapsed} onToggle={toggle} rail={rail} />}
          <SidebarStatus rail={rail} />
        </div>
      </div>
    </aside>
  );
}

/** Sidebar footer freshness — a status dot + "обновлено <time>" (mono). Rail collapses to the dot. */
function SidebarStatus({ rail }: { rail?: boolean }) {
  const { data: history } = useHistory(730);
  const fresh = freshness(latestHistoryDay(history), Date.now());
  if (!fresh) return null;
  return (
    <div
      title={rail ? `обновлено ${fresh.label}` : undefined}
      className={cn(
        'flex items-center gap-2 px-3 pt-1 text-[11px] text-muted-foreground',
        rail &&
          'justify-center px-1 group-hover/sb:justify-start group-hover/sb:px-3 group-focus-within/sb:justify-start group-focus-within/sb:px-3',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', fresh.stale ? 'bg-status-warn' : 'bg-verdant')}
      />
      <span className={cn('truncate font-mono', rail && REVEAL_INLINE)}>обновлено {fresh.label}</span>
    </div>
  );
}

/** Bottom collapse/expand control (lg only). Always rendered + tabbable, even in the rail. */
function CollapseToggle({ collapsed, onToggle, rail }: { collapsed: boolean; onToggle: () => void; rail: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
      title={collapsed ? 'Развернуть' : 'Свернуть'}
      className={cn(
        'flex w-full items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        rail
          ? 'justify-center px-1 py-2 group-hover/sb:justify-start group-hover/sb:gap-2 group-hover/sb:px-3 group-focus-within/sb:justify-start group-focus-within/sb:gap-2 group-focus-within/sb:px-3'
          : 'gap-2 px-3 py-2',
      )}
    >
      <Icon
        name="chevron"
        className={cn('h-4 w-4 shrink-0 transition-transform', collapsed ? '-rotate-90' : 'rotate-90')}
      />
      <span className={cn('text-xs', rail && REVEAL_INLINE)}>{collapsed ? 'Развернуть' : 'Свернуть'}</span>
    </button>
  );
}

/**
 * Fixed bottom tab bar for mobile (sidebar is hidden below md). Figma 390 shows the four
 * primary views here; system links (Настройки / Админ / Баги) move into the account menu so
 * the bar stays uncrowded. Icon tints via currentColor, so `text-primary` colours the active glyph.
 */
function MobileBottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
            )
          }
        >
          <Icon name={item.icon} className="h-5 w-5" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

function NavItem({ to, label, icon, end, rail }: NavLinkDef & { rail?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={rail ? label : undefined}
      aria-label={rail ? label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive
            ? 'font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Left accent bar marks the active section clearly (beyond just the tint). */}
          {isActive && (
            <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-primary" />
          )}
          <Icon name={icon} className={cn('h-[18px] w-[18px] shrink-0', isActive && 'text-primary')} />
          <span className={cn('whitespace-nowrap', rail && REVEAL_INLINE)}>{label}</span>
        </>
      )}
    </NavLink>
  );
}

function ChannelCard({ rail = false }: { rail?: boolean }) {
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
        ? 'Локальный сбор'
        : 'Telegram';
  const multi = channels.length >= 2;

  const pick = (id: number) => {
    setChannelId(id);
    void queryClient.cancelQueries();
    setOpen(false);
  };

  return (
    // In the rail the dropdown can only be opened while peeked; closing it when the pointer
    // leaves the card (descendants included) stops it being left clipped once the peek collapses.
    <div ref={cardRef} className="relative px-3" onMouseLeave={() => rail && setOpen(false)}>
      <button
        type="button"
        onClick={() => multi && setOpen((o) => !o)}
        title={rail ? handle : undefined}
        aria-label={rail ? `Канал ${handle}` : undefined}
        className={cn(
          'flex w-full items-center rounded-lg border text-left transition-colors',
          rail
            ? 'justify-center border-transparent bg-transparent px-1 py-1.5 group-hover/sb:justify-start group-hover/sb:gap-2.5 group-hover/sb:border-border group-hover/sb:bg-card group-hover/sb:px-2.5 group-hover/sb:py-2 group-focus-within/sb:justify-start group-focus-within/sb:gap-2.5 group-focus-within/sb:border-border group-focus-within/sb:bg-card group-focus-within/sb:px-2.5 group-focus-within/sb:py-2'
            : 'gap-2.5 border-border bg-card px-2.5 py-2',
          multi ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
        )}
      >
        <ChannelAvatar source={current?.source} initial={initial} className="h-9 w-9 rounded-md text-sm" />
        <span className={cn('min-w-0 flex-1', rail && REVEAL_BLOCK)}>
          <span className="block truncate text-sm font-medium text-foreground">{handle}</span>
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        </span>
        {multi && (
          <Icon
            name="chevron"
            className={cn('h-4 w-4 shrink-0 text-muted-foreground', rail && REVEAL_BLOCK)}
          />
        )}
      </button>

      {open && multi && (
        <div className="absolute inset-x-3 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover p-1">
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

function SearchBox({ rail = false }: { rail?: boolean }) {
  // Opens the global ⌘K command palette (mounted in App.tsx) by replaying the shortcut.
  const openPalette = () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }));
  return (
    <button
      type="button"
      onClick={openPalette}
      title={rail ? 'Поиск (⌘K)' : undefined}
      aria-label={rail ? 'Поиск (⌘K)' : undefined}
      className={cn(
        'flex w-full items-center rounded-lg border bg-card text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground',
        rail
          ? 'justify-center px-1 py-2 group-hover/sb:justify-start group-hover/sb:gap-2 group-hover/sb:px-3 group-focus-within/sb:justify-start group-focus-within/sb:gap-2 group-focus-within/sb:px-3'
          : 'gap-2 px-3 py-2',
      )}
    >
      <Icon name="search" className="h-4 w-4 shrink-0" />
      <span className={cn('flex-1 text-left', rail && REVEAL_BLOCK)}>Поиск</span>
      <kbd className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px]', rail && REVEAL_BLOCK)}>⌘K</kbd>
    </button>
  );
}

/** Desktop top bar (md+; mobile uses MobileHeader). Title + period + export + theme + account. */
function Topbar({ email, role }: { email?: string; role?: string }) {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? 'Pulse';
  return (
    <header className="sticky top-0 z-20 hidden h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 backdrop-blur sm:gap-4 sm:px-6 md:flex">
      {/* min-w-0 lets the title truncate instead of shoving the controls off a narrow screen. */}
      <h1 className="min-w-0 truncate text-lg font-medium">{title}</h1>
      <div className="flex shrink-0 items-center gap-2">
        <PeriodSwitcher />
        <ExportButton />
        <ThemeToggle />
        <AccountMenu email={email} role={role} />
      </div>
    </header>
  );
}

/**
 * Mobile header (md:hidden) — replaces the desktop top bar below md (Figma 390). Row 1: channel
 * identity + account avatar. Row 2: full-width segmented platform switch. Row 3: a compact period
 * strip sitting just above the content (Figma places the period by the KPI hero).
 */
function MobileHeader({ email, role }: { email?: string; role?: string }) {
  return (
    <div className="md:hidden">
      <div className="flex items-center gap-2 border-b py-2 pr-3">
        <div className="min-w-0 flex-1">
          <ChannelCard />
        </div>
        <AccountMenu email={email} role={role} />
      </div>
      <div className="border-b px-3 py-2">
        <PlatformNav variant="segment" />
      </div>
      <div className="flex justify-end border-b px-3 py-1.5">
        <PeriodSwitcher />
      </div>
    </div>
  );
}

/** Export the active channel's Telegram posts (current period) to CSV. Shown only on TG data views. */
function ExportButton() {
  const { pathname } = useLocation();
  const { days, inRange } = usePeriod();
  const { data } = useTgFull(days);
  if (!['/', '/analytics', '/posts'].includes(pathname)) return null;
  const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {}).filter((p) => inRange(p.date));
  const onExport = () =>
    downloadCsv(
      'telegram-posts.csv',
      posts.map((p) => ({
        Дата: p.date,
        Просмотры: p.reach,
        Реакции: p.likes,
        Репосты: p.shares,
        ER: p.er != null ? `${p.er.toFixed(1)}%` : '',
        Пост: markdownToPlainText(p.caption || ''),
      })),
    );
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={posts.length === 0}
      title="Экспорт постов в CSV"
      className="btn-pill inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
      </svg>
      Экспорт
    </button>
  );
}

/** Light/dark toggle as a top-bar icon button (sun in dark mode, moon in light). */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Светлая тема' : 'Тёмная тема'}
      title={dark ? 'Светлая тема' : 'Тёмная тема'}
      className="rounded-lg border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <Icon name={dark ? 'sun' : 'moon'} className="h-4 w-4" />
    </button>
  );
}

/**
 * Account menu — an avatar (user initials) that opens identity + logout (Figma replaces the kebab
 * with an avatar). On mobile it also carries the theme toggle and the system links (Настройки /
 * Админ / Баги), which on md+ live in the top bar / sidebar instead (those rows are md:hidden).
 */
function AccountMenu({ email, role }: { email?: string; role?: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();
  const logoutMutation = useLogout();
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, menuRef);

  const initials =
    (email ? email.replace(/@.*/, '').replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase() : '') || '?';
  const handleLogout = () =>
    logoutMutation.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Аккаунт"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-avatar text-[11px] font-medium text-ink2 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border bg-popover p-1.5 text-sm">
          {/* Identity block: who you are. */}
          {email && (
            <div className="px-2.5 py-1.5">
              <div className="truncate text-xs font-medium text-foreground">{email}</div>
              {role === 'superuser' && (
                <div className="text-[11px] text-muted-foreground">Администратор</div>
              )}
            </div>
          )}
          <div className="my-1 border-t" aria-hidden="true" />
          {/* Theme — only in the mobile menu (md+ has the standalone toggle in the top bar). */}
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-4 w-4" />
            {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          </button>
          {/* System links — mobile only; the bottom bar carries primary views, the sidebar carries
              these on md+. */}
          <div className="md:hidden">
            {(role === 'superuser' ? [...SYSTEM_NAV, ...SUPER_NAV] : SYSTEM_NAV).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded px-2.5 py-1.5 transition-colors',
                    isActive
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )
                }
              >
                <Icon name={item.icon} className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </div>
          <div className="my-1 border-t md:hidden" aria-hidden="true" />
          {/* Logout: calm by default, destructive only on hover (it's important, not an alarm). */}
          <button
            type="button"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="block w-full rounded px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
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
  const btnRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen); // Escape closes; outside-click handled by the scrim

  // Underline tab — active = blue underline bar, no fill (Refined Technical).
  const tab = (active: boolean) =>
    cn(
      'relative px-0.5 pb-1.5 pt-1 text-xs font-medium tabular-nums transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
    );

  const toggle = () => {
    if (open) return setOpen(false);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  return (
    <div className="flex items-center">
      <div className="flex items-center gap-3">
        {PERIODS.map((period) => {
          const active = range === null && days === period.days;
          return (
            <button
              key={period.days}
              type="button"
              onClick={() => setDays(period.days)}
              className={tab(active)}
            >
              {period.label}
              {active && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-px bg-primary" />}
            </button>
          );
        })}
        {/* hairline divider before the custom-range control */}
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <button
          ref={btnRef}
          type="button"
          onClick={toggle}
          className={cn(tab(range !== null), 'inline-flex items-center gap-1')}
          title="Произвольный период"
          aria-label="Произвольный период"
        >
          {range ? (
            <>
              {`${shortDate(range.from)}–${shortDate(range.to)}`}
              <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-px bg-primary" />
            </>
          ) : (
            <Icon name="calendar" className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-auto rounded-lg border bg-popover p-4 text-popover-foreground"
            style={{ top: pos.top, right: pos.right }}
          >
            <DateRangePicker
              value={range}
              onApply={(r) => {
                setRange(r);
                setOpen(false);
              }}
              onReset={() => {
                setDays(30); // also clears the range
                setOpen(false);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Source/network switcher (Telegram ↔ Instagram). Lives at the "data source" level — in the
 * sidebar under the channel card (desktop) and in the mobile context bar — NOT in the page
 * content, so it doesn't read as a per-page filter on Settings/Admin/Bugs. Instagram is
 * demo/mock-backed until connected; `mock === true` (not just "no data") avoids a false flag
 * during the initial load.
 */
function PlatformNav({ variant, rail = false }: { variant: 'sidebar' | 'segment'; rail?: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const igActive = pathname.startsWith('/instagram');
  const igProfile = useIgProfile();
  const igDemo = igProfile.data?.mock === true;

  const items = PLATFORMS.map((p) => ({
    ...p,
    active: p.key === 'ig' ? igActive : !igActive,
    demo: p.key === 'ig' && igDemo,
  }));

  if (variant === 'segment') {
    // Mobile: full-width two-half segmented control (Figma 390) — glyph + text label + демо chip,
    // active half on a blue tint; the gap-px over bg-border draws the centre hairline.
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {items.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => navigate(p.to)}
            aria-current={p.active ? 'true' : undefined}
            className={cn(
              'flex items-center justify-center gap-2 px-3 py-2 text-sm transition-colors',
              p.active ? 'bg-accent font-medium text-foreground' : 'bg-background text-muted-foreground',
            )}
          >
            <span className="shrink-0" style={{ color: p.color }}>
              <PlatformGlyph k={p.key} className="h-4 w-4" />
            </span>
            <span className="whitespace-nowrap">{p.name}</span>
            {p.demo && (
              <span className="rounded-full bg-status-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
                демо
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  // Sidebar: source-level rows (rail-aware), styled like nav items but with brand glyphs.
  return (
    <div className="space-y-0.5">
      {items.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => navigate(p.to)}
          aria-current={p.active ? 'true' : undefined}
          title={rail ? (p.demo ? `${p.name} · демо` : p.name) : undefined}
          aria-label={rail ? p.name : undefined}
          className={cn(
            'relative flex w-full items-center rounded-lg text-sm transition-colors',
            rail
              ? 'justify-center px-1 py-2 group-hover/sb:justify-start group-hover/sb:gap-3 group-hover/sb:px-3 group-focus-within/sb:justify-start group-focus-within/sb:gap-3 group-focus-within/sb:px-3'
              : 'gap-3 px-3 py-2',
            p.active
              ? 'font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          <span className="shrink-0" style={{ color: p.color }}>
            <PlatformGlyph k={p.key} className="h-[18px] w-[18px]" />
          </span>
          <span className={cn('whitespace-nowrap', rail && REVEAL_INLINE)}>{p.name}</span>
          {p.demo && (
            <span
              className={cn(
                'ml-auto rounded-full bg-status-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warn',
                rail && REVEAL_INLINE,
              )}
            >
              демо
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
