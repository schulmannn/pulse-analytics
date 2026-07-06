import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useIgProfile, useLogout } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useDemo } from '@/lib/demo-context';
import { openCommandPalette } from '@/lib/command-palette';
import { useTheme } from '@/lib/theme';
import { PLAN_LABEL, usePlan } from '@/lib/plan';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useSidebarMode } from '@/lib/sidebar';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useWidgetPrefsSync } from '@/components/ChartWidget';
import { fmt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { METRIC_DEFS } from '@/lib/metricDefs';
import { Icon, type IconName } from '@/components/nav-icons';
import { ChannelAvatar } from '@/components/ChannelAvatar';

/** Close a popover/dropdown on Escape, and (when a ref is given) on outside mousedown.
    Outside-click via a document listener instead of a scrim avoids stacking-context traps.
    `triggerRef` (optional) gets focus back on Escape — the focused popover content unmounts, and
    without the restore a keyboard user re-Tabs from the top of the shell. On outside mousedown the
    restore fires only when focus is INSIDE the popover (never steal from the clicked target). */
function useDismiss(
  active: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  ref?: RefObject<HTMLElement | null>,
  triggerRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef?.current?.focus();
      }
    };
    const onDown = ref
      ? (e: MouseEvent) => {
          if (ref.current && !ref.current.contains(e.target as Node)) {
            setOpen(false);
            if (triggerRef?.current && ref.current.contains(document.activeElement)) triggerRef.current.focus();
          }
        }
      : null;
    document.addEventListener('keydown', onKey);
    if (onDown) document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [active, setOpen, ref, triggerRef]);
}

interface NavLinkDef {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

// Telegram's dashboard is split into routes… Отчёты is network-agnostic (reports are per-USER,
// not per-channel) so it rides along with the TG set AND is appended to IG below — it must stay
// reachable in either network. The four feed views (Обзор/Аналитика/Посты/Упоминания) are the
// network-specific part.
const TG_FEED_NAV: NavLinkDef[] = [
  { to: '/', label: 'Обзор', icon: 'overview', end: true },
  { to: '/analytics', label: 'Аналитика', icon: 'analytics' },
  { to: '/posts', label: 'Посты', icon: 'posts' },
  { to: '/mentions', label: 'Упоминания', icon: 'mentions' },
];
// …and Instagram into its own parallel set (Обзор / Аналитика / Контент / Аудитория).
const IG_FEED_NAV: NavLinkDef[] = [
  { to: '/instagram', label: 'Обзор', icon: 'overview', end: true },
  { to: '/instagram/analytics', label: 'Аналитика', icon: 'analytics' },
  { to: '/instagram/content', label: 'Контент', icon: 'posts' },
  { to: '/instagram/audience', label: 'Аудитория', icon: 'audience' },
];
// Network-agnostic route(s) shown after the active network's feed views in BOTH nets.
const AGNOSTIC_NAV: NavLinkDef[] = [{ to: '/reports', label: 'Отчёты', icon: 'report' }];
// «Главная» — the personal pinned-widget board. Per-USER (not per-channel), like Отчёты, so it
// leads BOTH nets at the very top of the nav.
const HOME_NAV: NavLinkDef = { to: '/home', label: 'Главная', icon: 'home', end: true };

// Full nav sets = Главная + active network's feed views + the agnostic tail. These drive both the
// desktop sidebar list and the mobile bottom bar. Adding «Главная» makes both nets 6 tabs wide
// (MobileBottomNav's grid-cols follows nav.length).
const TG_NAV: NavLinkDef[] = [HOME_NAV, ...TG_FEED_NAV, ...AGNOSTIC_NAV];
const IG_NAV: NavLinkDef[] = [HOME_NAV, ...IG_FEED_NAV, ...AGNOSTIC_NAV];

const SUPER_NAV: NavLinkDef[] = [
  { to: '/admin', label: 'Админ', icon: 'admin' },
  { to: '/bugs', label: 'Баги', icon: 'bugs' },
];

type Network = 'tg' | 'ig';

/** The active network, derived purely from the URL — the single source of truth that survives
    deep-links and reloads. /instagram* = Instagram, everything else = Telegram. */
function useActiveNetwork(): Network {
  const { pathname } = useLocation();
  return pathname.startsWith('/instagram') ? 'ig' : 'tg';
}

/** The nav set for the active network — feed views + Отчёты. Drives BOTH the desktop sidebar's
    single adaptive list AND the mobile bottom bar (they read the same active-network route set). */
function useActiveNetworkNav(): NavLinkDef[] {
  return useActiveNetwork() === 'ig' ? IG_NAV : TG_NAV;
}

const TITLES: Record<string, string> = {
  '/home': 'Главная',
  '/': 'Обзор',
  '/analytics': 'Аналитика',
  '/posts': 'Посты',
  '/mentions': 'Упоминания',
  '/reports': 'Отчёты',
  '/settings': 'Настройки',
  '/admin': 'Админ',
  '/bugs': 'Баги',
  '/connect': 'Подключение данных',
};

/** Feed routes open with their own header (the block header on TG; the «Instagram · @handle»
    account header + block headers on IG) — a topbar h1 there reads twice (the name in the corner
    AND on the page), so these routes render no topbar title. Covers both feeds' section paths. */
const FEED_ROUTES = [
  // Home renders its own «Главная» header, so suppress the topbar h1 (a duplicate otherwise).
  '/home',
  '/',
  '/analytics',
  '/posts',
  '/mentions',
  '/instagram',
  '/instagram/analytics',
  '/instagram/content',
  '/instagram/audience',
];

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
        // Floating panel (Claude-style): inset 0.5rem all round, rounded, a full hairline, on the
        // card surface so it reads a shade apart from the canvas — no shadow (DS restraint; the
        // surface contrast + inset carry the float). z-30 lets the overhanging popovers (rail
        // dropdown, user-row menu) paint above the sticky Topbar (z-20), under scrim/modals.
        'sticky top-2 z-30 m-2 hidden h-[calc(100vh-1rem)] shrink-0 flex-col rounded-xl border border-border bg-card dark:border-white/[0.06] md:flex print:hidden',
        'transition-[width] duration-200 motion-reduce:transition-none',
        rail ? 'w-16' : 'w-60',
      )}
    >
      <SidebarActions rail={rail} onToggle={toggle} />

      <div className="mt-2">
        <SourceSwitcher rail={rail} />
        <div className={rail ? 'px-2' : 'px-3'}>
          <SidebarStatus rail={rail} />
        </div>
      </div>

      <SidebarNav rail={rail} />

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
 * The single adaptive nav — ONE flat list of the ACTIVE network's routes (no platform label,
 * no group markers). The source switcher above carries the network identity, so the nav itself
 * is just "the current source's views": TG → Обзор/Аналитика/Посты/Упоминания/Отчёты, IG →
 * Обзор/Аналитика/Контент/Аудитория/Отчёты. Switching network (via the switcher) re-derives the
 * set from the URL, so the same list drives desktop and (via useActiveNetworkNav) the mobile bar.
 */
function SidebarNav({ rail }: { rail: boolean }) {
  const items = useActiveNetworkNav();
  return (
    <nav className="mt-5 flex-1 overflow-y-auto overflow-x-hidden px-3">
      <div className="space-y-0.5">
        {items.map((item) => (
          <NavItem key={item.to} {...item} rail={rail} />
        ))}
      </div>
    </nav>
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
  const nav = useActiveNetworkNav();
  // Column count follows the active-network nav so the tabs fill the bar exactly (a hardcoded
  // count wraps the extra tab onto a second row / leaves a dead column). Both nets now carry the
  // «Главная» leader + «Отчёты» tail, so both are 6 wide — but keep this length-driven in case a
  // network's feed set changes.
  const GRID_COLS: Record<number, string> = { 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6' };
  return (
    <nav
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 grid border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden',
        GRID_COLS[nav.length] ?? 'grid-cols-5',
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
          'relative flex h-9 items-center rounded text-sm transition-colors',
          rail ? 'justify-center' : 'gap-2.5 px-2',
          isActive
            ? // Rail (collapsed): no heavy filled square — a thin left indicator pill (below) + the
              // active glyph reads lighter. Expanded: the full-row neutral highlight stays.
              rail
              ? 'font-medium text-foreground'
              : 'bg-hover-row font-medium text-foreground'
            : 'text-ink2 hover:bg-hover-row/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {rail && isActive && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-foreground"
            />
          )}
          <Icon name={icon} className="h-[18px] w-[18px] shrink-0" />
          {!rail && <span className="truncate whitespace-nowrap">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

/** A source = (channel, network). The switcher lists one row per (channel × network). */
interface SourceRow {
  channelId: number;
  network: Network;
  name: string;
}

/** Small network glyph overlaid on the source avatar (and used as each dropdown row's marker),
    tinted with the network's brand colour on a tiny paper chip so TG-blue / IG-magenta read as
    identifiers, not UI colour. */
function NetworkBadge({ network, className }: { network: Network; className?: string }) {
  const color = PLATFORMS.find((p) => p.key === network)?.color;
  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-full border border-border bg-background',
        className,
      )}
      style={{ color }}
      aria-hidden="true"
    >
      <PlatformGlyph k={network} className="h-2.5 w-2.5" />
    </span>
  );
}

/**
 * Source switcher — the workspace-switcher slot under the sidebar header, replacing the old
 * ChannelCard. A "source" is (channel, network): the channel is the selected channelId, the
 * network is derived from the URL. The trigger shows the active source (avatar + a small network
 * badge + @handle + subtitle + chevron). The dropdown groups sources by NETWORK — «Telegram» and
 * «Instagram», each listing every channel (every channel is reachable on both; IG shows demo/mock
 * until connected) — plus a «Подключить источник» action. Picking a Telegram source selects the
 * channel and navigates to /; an Instagram source selects it and navigates to /instagram.
 *
 * This component OWNS the channel bootstrap effect (moved from the old ChannelCard): it validates
 * the persisted id against the loaded list and falls back to the server's `selected` → first
 * channel. That effect is load-bearing — without it every channel-scoped query 404s forever.
 */
function SourceSwitcher({ rail = false, mobile = false }: { rail?: boolean; mobile?: boolean }) {
  const { data } = useChannels();
  const { channelId, setChannelId } = useSelectedChannel();
  const network = useActiveNetwork();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const channels = data?.channels ?? [];

  // Initialise / validate the selected channel once the list loads (drives X-Channel-Id). A
  // stale/foreign persisted id falls back to the server's `selected`, then the first channel —
  // otherwise every query would 404 forever. (Moved here from the old ChannelCard.)
  useEffect(() => {
    if (!data || channels.length === 0) return;
    if (channelId != null && channels.some((c) => c.id === channelId)) return;
    const serverSelected = channels.find((c) => c.id === data.selected)?.id;
    setChannelId(serverSelected ?? channels[0].id);
  }, [channelId, channels, data, setChannelId]);

  // Desktop dropdown dismisses on Escape + outside-mousedown (cardRef wraps trigger + popover). The
  // mobile bottom sheet is portaled with its own backdrop + focus trap (SourceSheet), so it opts out
  // of the outside-mousedown path here (the trigger sits behind the backdrop, un-tappable while open).
  useDismiss(open && !mobile, setOpen, cardRef, triggerRef);
  // Reset the filter whenever the dropdown closes, so it reopens clean.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const channelName = (c: { username?: string | null; title?: string | null; id: number }) =>
    String(c.username || c.title || c.id);

  const current = channels.find((c) => c.id === channelId) ?? channels[0];
  const name = current ? channelName(current) : '';
  const handle = current ? `@${name}` : '@—';
  const initial = (name || 'T').slice(0, 1).toUpperCase();
  const count = current?.memberCount;
  // Subtitle names the ACTIVE network so the trigger reads as "this source", not just "this channel".
  const subtitle =
    network === 'ig'
      ? 'Instagram'
      : count != null && count > 0
        ? `${fmt.short(count)} подписчиков`
        : current?.source === 'collector'
          ? 'Локальный сбор'
          : 'Telegram';

  // The dropdown always opens (even with a single channel) — it's how the user crosses NETWORKS,
  // not only how they switch channels.
  const openable = channels.length > 0;

  // Search only when the flat source list gets long (both networks × channels). Mirrors the
  // command palette's simple substring filter.
  const totalRows = channels.length * PLATFORMS.length;
  const showSearch = totalRows > 8;

  const pick = (row: SourceRow) => {
    setChannelId(row.channelId);
    void queryClient.cancelQueries();
    setOpen(false);
    // The focused row unmounts with the popover — hand focus back to the trigger so a keyboard
    // user switching sources keeps their place instead of restarting from the document top.
    triggerRef.current?.focus();
    navigate(row.network === 'ig' ? '/instagram' : '/');
  };

  const filtered = (net: Network): SourceRow[] => {
    const q = query.trim().toLowerCase();
    return channels
      // Instagram is offered ONLY for channels with a linked IG account (ig_connected). An empty
      // IG group auto-hides below (rows.length === 0 → null), so unconnected workspaces show
      // Telegram only — no more demo/mock IG for every channel.
      .filter((c) => net !== 'ig' || !!c.ig_connected)
      // Standalone Instagram sources (source='ig') have no Telegram side — never list them
      // under the Telegram group.
      .filter((c) => net !== 'tg' || c.source !== 'ig')
      .map((c) => ({ channelId: c.id, network: net, name: channelName(c) }))
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true));
  };

  // Grouped source rows (Telegram / Instagram) + the «Подключить источник» action — shared by the
  // desktop dropdown (compact rows) and the mobile bottom sheet (`touch` → ≥44px rows for the thumb).
  const renderGroups = (touch: boolean) => {
    const rowBase = 'flex w-full items-center gap-2 rounded px-2 text-left text-sm transition-colors';
    const rowSize = touch ? 'min-h-11 py-2' : 'py-1.5';
    return (
      <>
        {PLATFORMS.map((p) => {
          const net = p.key as Network;
          const rows = filtered(net);
          if (rows.length === 0) return null;
          return (
            <div key={net} role="group" aria-label={p.name} className="pt-1 first:pt-0">
              <p aria-hidden="true" className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-ink3">
                {p.name}
              </p>
              {rows.map((row) => {
                const active = row.channelId === channelId && net === network;
                return (
                  <button
                    key={`${net}:${row.channelId}`}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => pick(row)}
                    className={cn(
                      rowBase,
                      rowSize,
                      active
                        ? 'bg-hover-row font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-hover-row/60 hover:text-foreground',
                    )}
                  >
                    <span className="relative shrink-0">
                      <span
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded text-2xs font-medium',
                          chipTint(row.name),
                        )}
                      >
                        {row.name.slice(0, 1).toUpperCase()}
                      </span>
                      <NetworkBadge network={net} className="absolute -bottom-1 -right-1 h-3 w-3" />
                    </span>
                    <span className="truncate">@{row.name}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {/* «Подключить источник» — add a channel / connect IG lives on the connect flow. */}
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/connect');
            }}
            className={cn(rowBase, rowSize, 'text-muted-foreground hover:bg-hover-row/60 hover:text-foreground')}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-border text-sm leading-none">
              +
            </span>
            <span className="truncate">Подключить источник</span>
          </button>
        </div>
      </>
    );
  };

  const searchInput = showSearch ? (
    <input
      // Desktop dropdown autofocuses the filter; the mobile sheet does NOT — autofocus there pops the
      // on-screen keyboard over the list before the user has even scanned it.
      autoFocus={!mobile}
      aria-label="Поиск источника"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder="Поиск источника…"
      className="mb-1 w-full rounded bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
    />
  ) : null;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => openable && setOpen((o) => !o)}
      title={rail ? handle : undefined}
      aria-label={rail || mobile ? `Источник ${handle}` : undefined}
      aria-haspopup={mobile && openable ? 'dialog' : undefined}
      aria-expanded={openable ? open : undefined}
      className={cn(
        'flex w-full items-center rounded text-left transition-colors',
        rail ? 'justify-center py-1' : 'gap-2.5 px-2 py-1.5',
        openable ? 'cursor-pointer hover:bg-hover-row/60' : 'cursor-default',
      )}
    >
      <span className="relative shrink-0">
        <ChannelAvatar
          source={current?.source}
          initial={initial}
          tintClassName={chipTint(name)}
          className="h-9 w-9 rounded text-sm"
        />
        {/* Network badge overlays the avatar's bottom-right — identifies the active source's net. */}
        <NetworkBadge network={network} className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5" />
      </span>
      {!rail && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{handle}</span>
            <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
          </span>
          {openable && <Icon name="chevron" className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </>
      )}
    </button>
  );

  // Mobile (<md): the trigger opens a bottom SHEET (portal + backdrop + focus trap) instead of an
  // absolute dropdown — one-thumb reachable, safe-area padded, Escape/backdrop dismissable.
  if (mobile) {
    return (
      <div className="relative px-3">
        {trigger}
        {open && openable && (
          <SourceSheet title={`Источник ${handle}`} onClose={() => setOpen(false)}>
            {searchInput}
            {renderGroups(true)}
          </SourceSheet>
        )}
      </div>
    );
  }

  // Desktop sidebar (md+): the trigger + an absolute dropdown, anchored under the source card.
  return (
    <div ref={cardRef} className={cn('relative', rail ? 'px-2' : 'px-3')}>
      {trigger}
      {open && openable && (
        <div
          className={cn(
            'absolute top-full z-40 mt-1 overflow-hidden rounded border bg-popover p-1',
            // In the rail the popover overhangs the 64px column instead of squeezing into it.
            rail ? 'left-2 w-60' : 'inset-x-3',
          )}
        >
          {searchInput}
          <div className="max-h-[60vh] overflow-y-auto">{renderGroups(false)}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Mobile bottom sheet for the source switcher (<md). A portaled dialog: a fade-in backdrop (tap to
 * close) + a slide-up panel pinned to the bottom edge, focus-trapped (useFocusTrap restores the
 * trigger on close), Escape-dismissable, body-scroll-locked, with a bottom safe-area pad so the last
 * row clears the home indicator. z-50 sits above the fixed bottom nav (z-30). The desktop sidebar
 * keeps its absolute dropdown — this is the phone-reachable variant the Mobile-nav card calls for.
 */
function SourceSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef);
  useEffect(() => {
    // Capture-phase Escape (mirrors DetailShell): close THIS sheet before any nested handler runs.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="detail-backdrop-in absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        tabIndex={-1}
        className="sheet-in relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-xl border-t border-border bg-popover pb-[env(safe-area-inset-bottom)] focus:outline-none"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-2.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-ink3">Источник</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="-mr-1 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Desktop top bar (md+; mobile uses MobileHeader — conditionally, never both mounted).
    Feed routes carry their own block header + sticky section titles, so the bar is suppressed
    there entirely (no empty strip eating vertical space — steep). It renders ONLY on the
    routes that have a real h1 (metric pages, admin, bugs, reports). */
function Topbar() {
  const { pathname } = useLocation();
  const title = FEED_ROUTES.includes(pathname) ? null : routeTitle(pathname);
  if (!title) return null;
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:gap-4 sm:px-6 print:hidden">
      <h1 className="min-w-0 truncate text-lg font-medium">{title}</h1>
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
          <SourceSwitcher mobile />
        </div>
        <AccountMenu email={email} role={role} avatar={avatar} />
      </div>
      <div className="border-b px-3 py-2">
        <PlatformNav />
      </div>
    </div>
  );
}

/** Letter-badge fallback for the account avatar — first two letters of the mailbox name. */
const avatarInitials = (email?: string) =>
  (email ? email.replace(/@.*/, '').replace(/[^\p{L}]/gu, '').slice(0, 2).toUpperCase() : '') || '?';

/** Popover shell shared by both account menus — Claude-style card: 12px radius, hairline,
    paper popover surface, 4px inner padding. No shadow (governance). */
const ACCOUNT_MENU_SHELL = 'overflow-hidden rounded-xl border border-border bg-popover p-1 text-sm';

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
function AccountMenuContent({
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
function AccountMenu({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
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
        <div className={cn('absolute right-0 top-full z-40 mt-1 w-64', ACCOUNT_MENU_SHELL)}>
          <AccountMenuContent email={email} role={role} avatar={avatar} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * User row pinned to the sidebar bottom (steep-style): avatar + truncated email + a chevron
 * (down at rest, flips up while the menu is open, standard dropdown affordance),
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
  const plan = usePlan();
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, rowRef, triggerRef);

  return (
    <div ref={rowRef} className={cn('relative border-t border-border py-2', rail ? 'px-2' : 'px-3')}>
      <button
        ref={triggerRef}
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
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{email ?? 'Аккаунт'}</span>
              <span className="block truncate text-2xs text-muted-foreground">План {PLAN_LABEL[plan]}</span>
            </span>
            <Icon name="chevron" className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </>
        )}
      </button>
      {open && (
        <div
          className={cn(
            'absolute bottom-full z-40 mb-1',
            rail ? 'left-2 w-64' : 'inset-x-3',
            ACCOUNT_MENU_SHELL,
          )}
        >
          <AccountMenuContent email={email} role={role} avatar={avatar} onClose={() => setOpen(false)} />
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
