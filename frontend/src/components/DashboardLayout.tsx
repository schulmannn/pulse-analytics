import { useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useIgProfile, useLogout, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { openCommandPalette } from '@/lib/command-palette';
import { usePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';
import { useTheme } from '@/lib/theme';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useSidebarMode } from '@/lib/sidebar';
import { useWidgetPrefsSync } from '@/components/ChartWidget';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { downloadCsv } from '@/lib/csv';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { markdownToPlainText } from '@/lib/markdown';
import { METRIC_DEFS } from '@/lib/metricDefs';
import { normalizeTgPosts } from '@/lib/posts';
import { Icon, type IconName } from '@/components/nav-icons';
import { AtlavueMark } from '@/components/AtlavueMark';
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

// Telegram's dashboard is split into routes…
const TG_NAV: NavLinkDef[] = [
  { to: '/', label: 'Обзор', icon: 'overview', end: true },
  { to: '/analytics', label: 'Аналитика', icon: 'analytics' },
  { to: '/posts', label: 'Посты', icon: 'posts' },
  { to: '/mentions', label: 'Упоминания', icon: 'mentions' },
  { to: '/report', label: 'Отчёт', icon: 'report' },
];
// …and Instagram into its own parallel set (Обзор / Аналитика / Контент / Аудитория). The desktop
// sidebar lists BOTH sets as labeled sections (steep's Teams/Entities pattern); mobile stays
// platform-aware (usePlatformNav) so the bottom tab bar shows only the active platform's routes.
const IG_NAV: NavLinkDef[] = [
  { to: '/instagram', label: 'Обзор', icon: 'overview', end: true },
  { to: '/instagram/analytics', label: 'Аналитика', icon: 'analytics' },
  { to: '/instagram/content', label: 'Контент', icon: 'posts' },
  { to: '/instagram/audience', label: 'Аудитория', icon: 'audience' },
];
const SYSTEM_NAV: NavLinkDef[] = [{ to: '/settings', label: 'Настройки', icon: 'gear' }];
const SUPER_NAV: NavLinkDef[] = [
  { to: '/admin', label: 'Админ', icon: 'admin' },
  { to: '/bugs', label: 'Баги', icon: 'bugs' },
];

/** The nav set for the active platform (mobile bottom bar) — Telegram routes vs Instagram routes. */
function usePlatformNav(): NavLinkDef[] {
  const { pathname } = useLocation();
  return pathname.startsWith('/instagram') ? IG_NAV : TG_NAV;
}

const TITLES: Record<string, string> = {
  '/': 'Обзор',
  '/analytics': 'Аналитика',
  '/posts': 'Посты',
  '/mentions': 'Упоминания',
  '/report': 'Отчёт',
  '/settings': 'Настройки',
  '/admin': 'Админ',
  '/bugs': 'Баги',
  '/connect': 'Подключение данных',
  '/instagram': 'Instagram',
};

/** Topbar h1 for the current route; metric pages resolve to the metric's display name. */
function routeTitle(pathname: string): string {
  const exact = TITLES[pathname];
  if (exact) return exact;
  if (pathname.startsWith('/metrics/')) {
    const key = pathname.split('/')[2] as keyof typeof METRIC_DEFS;
    return METRIC_DEFS[key]?.term ?? 'Метрика';
  }
  return pathname.startsWith('/instagram') ? 'Instagram' : 'Atlavue';
}

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
  avatar?: string | null;
}

/** App shell: left sidebar (brand + channel + nav) and a top bar (title + period + menu). */
export function DashboardLayout({ email, role, avatar }: DashboardLayoutProps) {
  // ONE header at a time. The old `hidden md:flex` + `md:hidden` pair mounted BOTH headers
  // simultaneously — every control (period switcher, account menu, channel card) ran its
  // hooks/effects twice. Conditional render keeps a single instance per breakpoint.
  const isMd = useMediaQuery('(min-width: 768px)');
  // Widget customisation follows the account (user_prefs), not the browser.
  useWidgetPrefsSync();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {isMd ? (
          <Topbar email={email} role={role} avatar={avatar} />
        ) : (
          <MobileHeader email={email} role={role} avatar={avatar} />
        )}
        {/* Extra bottom padding on mobile clears the fixed bottom nav; md+ navigates via the sidebar. */}
        <main className="flex-1 px-4 pb-24 pt-5 sm:px-6 md:pb-5">
          <div className="mx-auto w-full max-w-screen-2xl">
            <DemoBanner />
            <Outlet />
          </div>
        </main>
      </div>
      <MobileBottomNav />
    </div>
  );
}

/** Persistent banner while demo mode is on — labels the sample data and offers a one-click exit. */
function DemoBanner() {
  const { demo, exitDemo } = useDemo();
  if (!demo) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-primary/30 px-4 py-2.5 text-sm">
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
      <span className="text-foreground">Демо-режим — данные примерные, для ознакомления.</span>
      <button
        type="button"
        onClick={exitDemo}
        className="ml-auto shrink-0 rounded border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        Выйти из демо
      </button>
    </div>
  );
}

/** 6 muted identity tints (see index.css --chip-N-*) picked deterministically from the channel
    name, so a channel keeps its colour across reloads, themes and dropdown rows. */
const CHIP_TINTS = ['chip-tint-1', 'chip-tint-2', 'chip-tint-3', 'chip-tint-4', 'chip-tint-5', 'chip-tint-6'];
function chipTint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return CHIP_TINTS[Math.abs(h) % CHIP_TINTS.length];
}

/**
 * Persistent sidebar (md+), steep-style: a real flex column that PUSHES content — expanded
 * (w-60) or a quiet icon-rail (w-16), toggled by the header panel button / Ctrl+B and
 * persisted (localStorage `pulse_sidebar`). No hover-expand overlay: the rail stays a rail
 * until toggled. Until the user chooses, the default is responsive — expanded at ≥lg, rail
 * on md–lg. <md the sidebar is hidden (MobileHeader + MobileBottomNav take over).
 */
function Sidebar() {
  const isMd = useMediaQuery('(min-width: 768px)');
  const isLg = useMediaQuery('(min-width: 1024px)');
  const { rail, toggle } = useSidebarMode(isLg);

  // Global Ctrl+B / ⌘B toggle. Skipped while typing (input / textarea / contenteditable) and
  // below md (no sidebar to toggle). ⌘K stays with the command palette — no key overlap.
  useEffect(() => {
    if (!isMd) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMd, toggle]);

  return (
    <aside
      aria-label="Боковая панель"
      className={cn(
        // Quiet column on the shared paper canvas: right hairline only, no panel, no shadow.
        // z-30 lets the rail-mode channel dropdown (which overhangs the aside) paint above the
        // sticky Topbar (z-20) while staying under the period scrim (z-40) and modals (z-50).
        'sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-r border-border bg-background md:flex print:hidden',
        'transition-[width] duration-200 motion-reduce:transition-none',
        rail ? 'w-16' : 'w-60',
      )}
    >
      <SidebarHeader rail={rail} onToggle={toggle} />

      <div className="mt-3">
        <ChannelCard rail={rail} />
      </div>

      <nav className="mt-5 flex-1 overflow-y-auto overflow-x-hidden px-3">
        <NavGroup label="Telegram" platform="tg" items={TG_NAV} rail={rail} first />
        <NavGroup label="Instagram" platform="ig" items={IG_NAV} rail={rail} />
      </nav>

      <div className="space-y-1 px-3 pb-4 pt-2">
        {SYSTEM_NAV.map((item) => (
          <NavItem key={item.to} {...item} rail={rail} />
        ))}
        <SidebarStatus rail={rail} />
      </div>
    </aside>
  );
}

/**
 * Sidebar header row (steep-style): brand identity on the left (wordmark hidden in the rail),
 * two quiet ghost icon actions on the right — the panel toggle (Ctrl+B) and search (⌘K, opens
 * the global command palette). In the rail the actions stack vertically under the mark, so the
 * toggle always stays reachable.
 */
function SidebarHeader({ rail, onToggle }: { rail: boolean; onToggle: () => void }) {
  return (
    <div className={cn('flex px-3 pt-4', rail ? 'flex-col items-center gap-1' : 'items-center gap-1')}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-primary" aria-hidden="true">
        <AtlavueMark className="h-5 w-5" />
      </span>
      {!rail && (
        <span className="min-w-0 flex-1 truncate pl-1 text-base font-medium tracking-tight">Atlavue</span>
      )}
      <GhostIconButton
        onClick={onToggle}
        label={rail ? 'Показать панель' : 'Скрыть панель'}
        title={rail ? 'Показать панель · Ctrl+B' : 'Скрыть панель · Ctrl+B'}
        expanded={!rail}
      >
        <Icon name="panel" className="h-4 w-4" />
      </GhostIconButton>
      <GhostIconButton onClick={openCommandPalette} label="Поиск" title="Поиск · ⌘K">
        <Icon name="search" className="h-4 w-4" />
      </GhostIconButton>
    </div>
  );
}

/** Quiet 28px ghost icon button for sidebar chrome (no border, hover fill only). */
function GhostIconButton({
  onClick,
  label,
  title,
  expanded,
  children,
}: {
  onClick: () => void;
  label: string;
  title: string;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      title={title}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground"
    >
      {children}
    </button>
  );
}

/**
 * Labeled nav section (steep's Teams/Entities pattern) — replaces the old boxed platform
 * switcher: both platforms are always visible, each under its own quiet uppercase label.
 * Rail mode: a hairline separator between groups + the platform's tiny brand glyph as the
 * group marker (both nav sets share the same stroke icons, so the glyph disambiguates).
 */
function NavGroup({
  label,
  platform,
  items,
  rail,
  first = false,
}: {
  label: string;
  platform: string;
  items: NavLinkDef[];
  rail: boolean;
  first?: boolean;
}) {
  const color = PLATFORMS.find((p) => p.key === platform)?.color;
  return (
    <div role="group" aria-label={label} className={cn(!first && (rail ? 'mt-3' : 'mt-5'))}>
      {rail ? (
        <div className="flex flex-col items-center gap-2 pb-2" aria-hidden="true">
          {!first && <span className="h-px w-8 bg-border" />}
          <span title={label} style={{ color, opacity: 0.75 }}>
            <PlatformGlyph k={platform} className="h-3.5 w-3.5" />
          </span>
        </div>
      ) : (
        <p aria-hidden="true" className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-ink3">
          {label}
        </p>
      )}
      <div className="space-y-0.5">
        {items.map((item) => (
          <NavItem key={item.to} {...item} rail={rail} />
        ))}
      </div>
    </div>
  );
}

/** Sidebar footer freshness — a status dot + "обновлено <time>" (mono). Rail: dot only,
    the full text moves into the title tooltip. Always the LAST element of the sidebar. */
function SidebarStatus({ rail }: { rail?: boolean }) {
  const { data: history } = useHistory(730);
  const fresh = freshness(latestHistoryDay(history), Date.now());
  if (!fresh) return null;
  return (
    <div
      title={rail ? `обновлено ${fresh.label}` : undefined}
      className={cn(
        'flex items-center gap-2 pt-1 text-2xs text-muted-foreground',
        rail ? 'justify-center' : 'px-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', fresh.stale ? 'bg-status-warn' : 'bg-verdant')}
      />
      {!rail && <span className="truncate font-mono">обновлено {fresh.label}</span>}
    </div>
  );
}

/**
 * Fixed bottom tab bar for mobile (sidebar is hidden below md). Figma 390 shows the four
 * primary views here; system links (Настройки / Админ / Баги) move into the account menu so
 * the bar stays uncrowded. Icon tints via currentColor, so `text-primary` colours the active glyph.
 */
function MobileBottomNav() {
  const nav = usePlatformNav();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden">
      {nav.map((item) => (
        <NavLink
          key={item.label}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center gap-1 py-2.5 text-2xs font-medium transition-colors',
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

/** Sidebar nav row. Active = full-row neutral highlight (bg-hover-row + medium ink) — blue stays
    reserved for links/brand. NavLink emits aria-current="page" on the active row by itself.
    Rail: icon only, centered, with the label as a title tooltip + aria-label. */
function NavItem({ to, label, icon, end, rail }: NavLinkDef & { rail?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={rail ? label : undefined}
      aria-label={rail ? label : undefined}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center rounded text-sm transition-colors',
          rail ? 'justify-center' : 'gap-2.5 px-2',
          isActive
            ? 'bg-hover-row font-medium text-foreground'
            : 'text-ink2 hover:bg-hover-row/60 hover:text-foreground',
        )
      }
    >
      <Icon name={icon} className="h-[18px] w-[18px] shrink-0" />
      {!rail && <span className="truncate whitespace-nowrap">{label}</span>}
    </NavLink>
  );
}

/**
 * Channel card — the workspace-switcher slot under the sidebar header (steep's «Alex ⌄»).
 * Identity = a colored letter-avatar chip (deterministic tint from the channel name; a real
 * profile photo still wins — see ChannelAvatar). Chrome-less row, hairline-free: hover fill
 * only. Rail: just the chip; the dropdown still opens and overhangs the rail to the right.
 */
function ChannelCard({ rail = false }: { rail?: boolean }) {
  const { data } = useChannels();
  const { channelId, setChannelId } = useSelectedChannel();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const channels = data?.channels ?? [];

  // Initialise the selected channel once the list loads (drives X-Channel-Id). Also validates
  // a persisted id (localStorage) against the loaded list: a stale/foreign id falls back to the
  // server's `selected`, then the first channel — otherwise every query would 404 forever.
  useEffect(() => {
    if (!data || channels.length === 0) return;
    if (channelId != null && channels.some((c) => c.id === channelId)) return;
    const serverSelected = channels.find((c) => c.id === data.selected)?.id;
    setChannelId(serverSelected ?? channels[0].id);
  }, [channelId, channels, data, setChannelId]);

  useDismiss(open, setOpen, cardRef);

  const current = channels.find((c) => c.id === channelId) ?? channels[0];
  const name = String(current?.username || current?.title || current?.id || '');
  const handle = current ? `@${name}` : '@—';
  const initial = (name || 'T').slice(0, 1).toUpperCase();
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
    <div ref={cardRef} className={cn('relative', rail ? 'px-2' : 'px-3')}>
      <button
        type="button"
        onClick={() => multi && setOpen((o) => !o)}
        title={rail ? handle : undefined}
        aria-label={rail ? `Канал ${handle}` : undefined}
        className={cn(
          'flex w-full items-center rounded text-left transition-colors',
          rail ? 'justify-center py-1' : 'gap-2.5 px-2 py-1.5',
          multi ? 'cursor-pointer hover:bg-hover-row/60' : 'cursor-default',
        )}
      >
        <ChannelAvatar
          source={current?.source}
          initial={initial}
          tintClassName={chipTint(name)}
          className="h-9 w-9 rounded text-sm"
        />
        {!rail && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{handle}</span>
              <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
            </span>
            {multi && <Icon name="chevron" className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </>
        )}
      </button>

      {open && multi && (
        <div
          className={cn(
            'absolute top-full z-40 mt-1 overflow-hidden rounded border bg-popover p-1',
            // In the rail the popover overhangs the 64px column instead of squeezing into it.
            rail ? 'left-2 w-56' : 'inset-x-3',
          )}
        >
          {channels.map((channel) => {
            const channelName = String(channel.username || channel.title || channel.id);
            return (
              <button
                key={channel.id}
                type="button"
                onClick={() => pick(channel.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                  channel.id === channelId
                    ? 'bg-hover-row font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-hover-row/60 hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded text-2xs font-medium',
                    chipTint(channelName),
                  )}
                >
                  {channelName.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate">@{channelName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Desktop top bar (md+; mobile uses MobileHeader — conditionally, never both mounted). */
function Topbar({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
  const { pathname } = useLocation();
  const title = routeTitle(pathname);
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 backdrop-blur sm:gap-4 sm:px-6 print:hidden">
      {/* min-w-0 lets the title truncate instead of shoving the controls off a narrow screen. */}
      <h1 className="min-w-0 truncate text-lg font-medium">{title}</h1>
      <div className="flex shrink-0 items-center gap-2">
        <PeriodSwitcher />
        <ExportButton />
        <AccountMenu email={email} role={role} avatar={avatar} />
      </div>
    </header>
  );
}

/**
 * Mobile header (md:hidden) — replaces the desktop top bar below md (Figma 390). Row 1: channel
 * identity + account avatar. Row 2: full-width segmented platform switch. Row 3: a compact period
 * strip sitting just above the content (Figma places the period by the KPI hero).
 */
function MobileHeader({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
  return (
    <div className="print:hidden">
      <div className="flex items-center gap-2 border-b py-2 pr-3">
        <div className="min-w-0 flex-1">
          <ChannelCard />
        </div>
        <AccountMenu email={email} role={role} avatar={avatar} />
      </div>
      <div className="border-b px-3 py-2">
        <PlatformNav />
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

/**
 * Account menu — an avatar that opens identity, theme, the system links (Настройки / Админ / Баги),
 * and logout (Claude-style). This is the single home for account + system controls on every
 * breakpoint, so they're out of the sidebar and top bar.
 */
function AccountMenu({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
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
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : initials}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border bg-popover p-1.5 text-sm">
          {/* Identity block: who you are. */}
          {email && (
            <div className="px-2.5 py-1.5">
              <div className="truncate text-xs font-medium text-foreground">{email}</div>
              {role === 'superuser' && (
                <div className="text-2xs text-muted-foreground">Администратор</div>
              )}
            </div>
          )}
          <div className="my-1 border-t" aria-hidden="true" />
          {/* Theme toggle — lives in this menu now (the standalone top-bar toggle is gone). */}
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-4 w-4" />
            {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          </button>
          {/* System links (Настройки / Админ / Баги) — Claude-style, all under the avatar now. */}
          <div>
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
          <div className="my-1 border-t" aria-hidden="true" />
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

const DAY_MS = 86_400_000;
const startOfDayMs = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** How far back the pager may step — the channel_daily archive keeps ~730 days. */
const PAGER_FLOOR_DAYS = 730;

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

  // ‹ › pager (steep pattern): step the active window to the adjacent window of equal
  // length, expressed through the existing custom-range mechanism (preset 30д + ‹ = a
  // custom range covering the previous 30 days; the range button shows «dd.mm–dd.mm»).
  // Stepping forward past "now" returns to the rolling preset; «Всё» has no finite window.
  const today = startOfDayMs(Date.now());
  const winTo = range ? startOfDayMs(range.to) : today;
  const winFrom = range ? startOfDayMs(range.from) : days !== 0 ? today - (days - 1) * DAY_MS : null;
  const lenDays = winFrom != null ? Math.round((winTo - winFrom) / DAY_MS) + 1 : 0;
  const floor = today - PAGER_FLOOR_DAYS * DAY_MS;
  const canPrev = winFrom != null && winFrom - lenDays * DAY_MS >= floor;
  // The rolling window already ends at "now" — only a shifted (custom) window can step forward.
  const canNext = winFrom != null && range !== null;
  const step = (dir: -1 | 1) => {
    if (winFrom == null) return;
    const nextFrom = winFrom + dir * lenDays * DAY_MS;
    const nextTo = winTo + dir * lenDays * DAY_MS;
    if (dir === 1 && nextTo >= today) {
      setDays(days); // caught up with the present → back to the rolling preset window
      return;
    }
    setRange({ from: nextFrom, to: nextTo + DAY_MS - 1 });
  };
  const pagerBtn = (enabled: boolean) =>
    cn(
      'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors',
      enabled ? 'hover:bg-muted/60 hover:text-foreground' : 'opacity-30',
    );

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
        {/* hairline divider before the ‹ › pager (quiet ghost buttons, no boxes) */}
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={!canPrev}
            title="Предыдущий период"
            aria-label="Предыдущий период"
            className={pagerBtn(canPrev)}
          >
            <Icon name="chevron" className="h-3.5 w-3.5 rotate-90" />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={!canNext}
            title="Следующий период"
            aria-label="Следующий период"
            className={pagerBtn(canNext)}
          >
            <Icon name="chevron" className="h-3.5 w-3.5 -rotate-90" />
          </button>
        </div>
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
 * Source/network switcher (Telegram ↔ Instagram) — MOBILE ONLY (<md, MobileHeader context bar).
 * The desktop sidebar now lists both platforms as labeled nav sections instead, but the mobile
 * bottom tab bar still shows one platform's routes at a time, so this segmented control keeps
 * Instagram reachable on phones. Instagram is demo/mock-backed until connected; `mock === true`
 * (not just "no data") avoids a false flag during the initial load.
 */
function PlatformNav() {
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

  // The active half is a calm neutral surface with a thin brand underline; the brand colour lives
  // ONLY on the icon, so Telegram-blue / Instagram-magenta read as identifiers, not UI colour.
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-border bg-border">
      {items.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => navigate(p.to)}
          aria-current={p.active ? 'true' : undefined}
          className={cn(
            'relative flex items-center justify-center gap-2 px-2 py-2 text-sm transition-colors',
            p.active ? 'bg-muted/60 font-medium text-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="shrink-0" style={{ color: p.color, opacity: p.active ? 1 : 0.55 }}>
            <PlatformGlyph k={p.key} className="h-4 w-4" />
          </span>
          <span className="whitespace-nowrap">{p.name}</span>
          {p.demo && (
            <span className="rounded-full bg-status-warn/15 px-1.5 py-0.5 text-2xs font-medium text-status-warn">
              демо
            </span>
          )}
          {p.active && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5" style={{ background: p.color }} />}
        </button>
      ))}
    </div>
  );
}
