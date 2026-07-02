import { useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useIgProfile, useLogout, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { openCommandPalette } from '@/lib/command-palette';
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
import { ChannelAvatar } from '@/components/ChannelAvatar';

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
  { to: '/reports', label: 'Отчёты', icon: 'report' },
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
  '/reports': 'Отчёты',
  '/settings': 'Настройки',
  '/admin': 'Админ',
  '/bugs': 'Баги',
  '/connect': 'Подключение данных',
  '/instagram': 'Instagram',
};

/** TG feed routes open with their own block header carrying the same name — a topbar h1 there
    reads twice («Обзор» in the corner AND on the page), so these routes render no topbar title. */
const FEED_ROUTES = ['/', '/analytics', '/posts', '/mentions'];

/** Topbar h1 for the current route; metric pages resolve to the metric's display name. */
function routeTitle(pathname: string): string {
  const exact = TITLES[pathname];
  if (exact) return exact;
  if (pathname.startsWith('/metrics/')) {
    const key = pathname.split('/')[2] as keyof typeof METRIC_DEFS;
    return METRIC_DEFS[key]?.term ?? 'Метрика';
  }
  if (pathname.startsWith('/reports/')) return 'Отчёт';
  return pathname.startsWith('/instagram') ? 'Instagram' : 'Atlavue';
}

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

/** App shell: left sidebar (channel + nav + user row) and a top bar (title + period). The brand
    wordmark lives on the Landing page only — no logo inside the shell. */
export function DashboardLayout({ email, role, avatar }: DashboardLayoutProps) {
  // ONE header at a time. The old `hidden md:flex` + `md:hidden` pair mounted BOTH headers
  // simultaneously — every control (period switcher, account menu, channel card) ran its
  // hooks/effects twice. Conditional render keeps a single instance per breakpoint.
  const isMd = useMediaQuery('(min-width: 768px)');
  // Widget customisation follows the account (user_prefs), not the browser.
  useWidgetPrefsSync();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar email={email} role={role} avatar={avatar} />
      <div className="flex min-w-0 flex-1 flex-col">
        {isMd ? (
          <Topbar />
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
function Sidebar({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
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
        // z-30 lets the overhanging popovers (rail-mode channel dropdown, user-row menu) paint
        // above the sticky Topbar (z-20) while staying under the period scrim (z-40) and modals (z-50).
        'sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-r border-border bg-background md:flex print:hidden',
        'transition-[width] duration-200 motion-reduce:transition-none',
        rail ? 'w-16' : 'w-60',
      )}
    >
      <SidebarActions rail={rail} onToggle={toggle} />

      <div className="mt-2">
        <ChannelCard rail={rail} />
        <div className={rail ? 'px-2' : 'px-3'}>
          <SidebarStatus rail={rail} />
        </div>
      </div>

      <nav className="mt-5 flex-1 overflow-y-auto overflow-x-hidden px-3">
        <NavGroup label="Telegram" platform="tg" items={TG_NAV} rail={rail} first />
        <NavGroup label="Instagram" platform="ig" items={IG_NAV} rail={rail} />
      </nav>

      <SidebarUserRow rail={rail} email={email} role={role} avatar={avatar} />
    </aside>
  );
}

/**
 * Sidebar utility strip — the panel toggle (Ctrl+B) and search (⌘K, opens the global command
 * palette) as quiet ghost actions. No brand block here (the wordmark stays on the Landing page),
 * so the strip is LEFT-aligned chrome (owner call) and the channel card below is the sidebar's
 * first real content. In the rail the actions stack centered, so the toggle always stays reachable.
 */
function SidebarActions({ rail, onToggle }: { rail: boolean; onToggle: () => void }) {
  return (
    <div className={cn('flex px-3 pt-3', rail ? 'flex-col items-center gap-1' : 'items-center justify-start gap-1')}>
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

/** Data-freshness line — a status dot + "обновлено <time>" (mono), sitting directly under the
    channel card. Rail: dot only, the full text moves into the title tooltip. */
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
  // Column count follows the platform nav (TG has 5 routes since «Отчёты», IG has 4) —
  // a hardcoded count wraps the extra tab onto a second row / leaves a dead column.
  return (
    <nav
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 grid border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden',
        nav.length === 5 ? 'grid-cols-5' : 'grid-cols-4',
      )}
    >
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

/** Desktop top bar (md+; mobile uses MobileHeader — conditionally, never both mounted).
    Account controls live in the sidebar user row on md+, so the bar holds title + period only. */
function Topbar() {
  const { pathname } = useLocation();
  // Feed routes carry their own block header — no h1 here (see FEED_ROUTES).
  const title = FEED_ROUTES.includes(pathname) ? null : routeTitle(pathname);
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 backdrop-blur sm:gap-4 sm:px-6 print:hidden">
      {/* min-w-0 lets the title truncate instead of shoving the controls off a narrow screen;
          the empty span keeps justify-between pushing the controls right when there's no title. */}
      {title ? <h1 className="min-w-0 truncate text-lg font-medium">{title}</h1> : <span aria-hidden="true" />}
      <div className="flex shrink-0 items-center gap-2">
        <ExportButton />
      </div>
    </header>
  );
}

/**
 * Mobile header (md:hidden) — replaces the desktop top bar below md (Figma 390). Row 1: channel
 * identity + account avatar. Row 2: full-width segmented platform switch. The global period strip
 * is gone — period is now per-widget (each card carries its own 7д/30д/90д/Всё control).
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
    </div>
  );
}

/** Export the active channel's Telegram posts to CSV. Shown only on TG data views. The global
    period switcher is gone (period is per-widget), so the export ships ALL fetched posts — the
    wide max-window fetch (limit 100 = server cap), same payload the feed widgets filter from. */
function ExportButton() {
  const { pathname } = useLocation();
  const { data } = useTgFull(0);
  if (!['/', '/analytics', '/posts'].includes(pathname)) return null;
  const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {});
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

/** Letter-badge fallback for the account avatar — first two letters of the mailbox name. */
const avatarInitials = (email?: string) =>
  (email ? email.replace(/@.*/, '').replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase() : '') || '?';

/**
 * Shared account-menu body — identity, theme toggle, the system links (Настройки / Админ / Баги),
 * and logout (Claude-style). Rendered inside two popover shells: the mobile-header avatar menu
 * (opens downward) and the sidebar user row on md+ (opens upward).
 */
function AccountMenuContent({ email, role, onClose }: { email?: string; role?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();
  const logoutMutation = useLogout();
  const handleLogout = () =>
    logoutMutation.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });

  return (
    <>
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
      {/* System links (Настройки / Админ / Баги) — Claude-style, all under the account now. */}
      <div>
        {(role === 'superuser' ? [...SYSTEM_NAV, ...SUPER_NAV] : SYSTEM_NAV).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onClose}
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
    </>
  );
}

/**
 * Account menu — an avatar that opens the shared account-menu body downward. MOBILE ONLY now
 * (<md, MobileHeader): on md+ the account moved into the sidebar user row (SidebarUserRow).
 */
function AccountMenu({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, menuRef);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Аккаунт"
        aria-expanded={open}
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : avatarInitials(email)}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border bg-popover p-1.5 text-sm">
          <AccountMenuContent email={email} role={role} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * User row pinned to the sidebar bottom (steep-style): avatar + truncated email + up-chevron,
 * separated from the scrollable nav by a hairline. Opens the SAME account menu as the mobile
 * avatar, but UPWARD (anchored bottom-left) since the trigger sits at the viewport edge —
 * hairline + paper (border-border bg-card), no shadow. Rail: avatar only, the popover overhangs
 * the rail to the right (same trick as the channel dropdown).
 */
function SidebarUserRow({
  rail,
  email,
  role,
  avatar,
}: {
  rail: boolean;
  email?: string;
  role?: string;
  avatar?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, rowRef);

  return (
    <div ref={rowRef} className={cn('relative border-t border-border py-2', rail ? 'px-2' : 'px-3')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Аккаунт"
        aria-expanded={open}
        title={rail ? email : undefined}
        className={cn(
          'flex w-full items-center rounded text-left transition-colors hover:bg-hover-row/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          rail ? 'justify-center py-1' : 'gap-2.5 px-2 py-1.5',
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2">
          {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : avatarInitials(email)}
        </span>
        {!rail && (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{email ?? 'Аккаунт'}</span>
            <Icon name="chevron" className="h-4 w-4 shrink-0 rotate-180 text-muted-foreground" />
          </>
        )}
      </button>
      {open && (
        <div
          className={cn(
            'absolute bottom-full z-40 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-card p-1.5 text-sm',
            rail ? 'left-2' : 'left-3',
          )}
        >
          <AccountMenuContent email={email} role={role} onClose={() => setOpen(false)} />
        </div>
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
