import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useChannels, useHistory, useTgQrStatus } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { openCommandPalette } from '@/lib/command-palette';
import { sidebarHealth } from '@/lib/connectionHealth';
import { PLAN_LABEL, usePlan } from '@/lib/plan';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useSidebarMode } from '@/lib/sidebar';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { cn } from '@/lib/utils';
import { Icon, PanelToggleGlyph } from '@/components/nav-icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SourceSwitcher } from './SourceSwitcher';
import { AccountMenuContent, avatarInitials } from './AccountMenu';
import { useActiveNetworkNav, type NavLinkDef } from './nav';

/**
 * Persistent sidebar (md+), steep-style: a real flex column that PUSHES content — expanded
 * (w-60) or a quiet icon-rail (w-16), toggled by the header panel button / Ctrl+B and
 * persisted (localStorage `pulse_sidebar`). No hover-expand overlay: the rail stays a rail
 * until toggled. Until the user chooses, the default is responsive — expanded at ≥lg, rail
 * on md–lg. <md the sidebar is hidden (MobileHeader + MobileBottomNav take over).
 */
export function Sidebar({ email, role, avatar }: { email?: string; role?: string; avatar?: string | null }) {
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
      data-rail={rail ? 'true' : 'false'}
      className={cn(
        // FLAT canvas strip (steep — owner call): no floating card, no hairline, no inset — the
        // sidebar is just the canvas itself; the content's cards carry all the surface contrast.
        // z-nav lets the overhanging popovers (rail dropdown, user-row menu) paint above the
        // sticky Topbar (z-sticky), under scrim/modals.
        // h-full (не h-screen): на md+ оболочка — inset-панель с паддингом корня, экранная
        // высота вылезала бы за нижний зазор.
        // `sidebar-shell` owns the width→motion (asymmetric collapse/expand off [data-rail]) and, via
        // its descendant rules, the copy/heading masking — so nothing inside pops while width moves.
        'sidebar-shell sticky top-0 z-nav hidden h-full shrink-0 flex-col bg-background md:flex print:hidden',
        rail ? 'w-16' : 'w-60',
      )}
    >
      <SidebarActions rail={rail} onToggle={toggle} />

      <div className="mt-2">
        <SourceSwitcher rail={rail} />
        <div className="px-3">
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
 * so Search stays on the left navigation axis and the toggle marks the moving outer edge. The
 * channel card below remains the sidebar's first real content; in the rail the actions stack.
 */
function SidebarActions({ rail, onToggle }: { rail: boolean; onToggle: () => void }) {
  return (
    // Kimi-style edge-led chrome: the toggle rides the sidebar's OUTER edge — pinned to the right in
    // the expanded panel, sliding back onto the 32px rail axis as the surface collapses — while Search
    // holds the stable left axis (top when open, below the toggle in the rail). Both actions are
    // absolutely placed and animate their transform on the one shared collapse/expand beat, so the
    // strip travels with the width instead of re-flowing a flex row into a column in a single frame.
    <div className="sidebar-actions relative mt-3">
      <SidebarToggle rail={rail} onToggle={onToggle} />
      <GhostIconButton
        onClick={openCommandPalette}
        label="Поиск"
        title="Поиск · ⌘K"
        className="sidebar-action sidebar-action-search"
      >
        <Icon name="search" className="h-4 w-4" />
      </GhostIconButton>
    </div>
  );
}

/**
 * Sidebar panel toggle — the morphing glyph + a CSS-only tooltip beside it. The glyph reveals a
 * directional chevron on hover/focus (see `PanelToggleGlyph`); the tooltip (a separate, pointer-events
 * none layer to the right) carries the Russian action label plus discrete `Ctrl`/`B` key chips. Both
 * the icon morph and the tooltip open on :hover AND :focus-visible via `index.css` — no hover React
 * state, no timers, so the CSS transitions stay interruptible. `aria-describedby` links the tooltip
 * (role="tooltip") to the button for AT; there is no native `title`, so the hint is never duplicated.
 */
function SidebarToggle({ rail, onToggle }: { rail: boolean; onToggle: () => void }) {
  const label = rail ? 'Показать панель' : 'Скрыть панель';
  const tipId = useId();
  return (
    <div className="sidebar-action sidebar-action-toggle">
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        aria-expanded={!rail}
        aria-describedby={tipId}
        className="sidebar-toggle-btn flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground focus-visible:bg-hover-row focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <PanelToggleGlyph rail={rail} className="sidebar-toggle-glyph h-4 w-4" />
      </button>
      <span
        id={tipId}
        role="tooltip"
        data-sidebar-tooltip
        className="sidebar-tooltip rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground"
      >
        <span className="whitespace-nowrap">{label}</span>
        <kbd className="sidebar-key font-mono text-2xs">Ctrl</kbd>
        <kbd className="sidebar-key font-mono text-2xs">B</kbd>
      </span>
    </div>
  );
}

/** Quiet 28px ghost icon button for sidebar chrome (no border, hover fill only). */
function GhostIconButton({
  onClick,
  label,
  title,
  expanded,
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  title: string;
  expanded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      title={title}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover-row hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Sidebar nav = the ACTIVE source's sections only (owner call after trying nested groups AND an
 * accordion: with 10+ sources on the roadmap, any per-source expansion turns the sidebar into a
 * wall — «то как было в целом ок»). The cross-network confusion that once motivated nesting is
 * solved at the STRUCTURE level now — every network exposes the same canonical section shape from
 * the registry — so a flat list stays legible however many sources exist. Crossing networks is one
 * click on the NetworkStrip above; crossing sources is the switcher dropdown. «Главная» leads,
 * «Отчёты» trails — per-user rows, not per-network.
 */
function SidebarNav({ rail }: { rail: boolean }) {
  const items = useActiveNetworkNav();
  const home = items.filter((item) => item.to === '/home');
  const reports = items.filter((item) => item.to === '/reports');
  const workspace = items.filter((item) => item.to !== '/home' && item.to !== '/reports');
  return (
    <nav className="mt-5 flex-1 overflow-y-auto overflow-x-hidden px-3">
      <SidebarNavGroup items={home} rail={rail} />
      <SidebarNavGroup label="Анализ источника" items={workspace} rail={rail} />
      <SidebarNavGroup label="Рабочие документы" items={reports} rail={rail} />
    </nav>
  );
}

/** Visual sections only: routes remain one flat list and sources still live exclusively in the switcher. */
function SidebarNavGroup({ label, items, rail }: { label?: string; items: NavLinkDef[]; rail: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className={cn('sidebar-nav-group space-y-0.5', label && 'sidebar-nav-group-labelled')}>
      {/* The heading stays mounted and collapses (opacity + max-height) instead of unmounting, so it
          slides away with the width rather than popping. aria-hidden in the rail keeps AT quiet. */}
      {label && (
        <div aria-hidden={rail} className="sidebar-section-label px-2 pb-1 text-2xs font-medium text-ink3">{label}</div>
      )}
      {items.map((item) => <NavItem key={item.to} {...item} rail={rail} />)}
    </div>
  );
}

/**
 * One-click network crossing for the current workspace — a quiet strip of brand glyphs, one per
 * CONNECTED network (registry-gated: all while the channel list loads / in demo; unconnected nets
 * live behind «Подключить источник» in the switcher). Scales flat: 10 sources are one wrapping row
 * of 28px chips, not ten nav groups. Hidden with a single network — nothing to cross to. Brand


/** Data-freshness line — a status dot + "обновлено <time>" (mono), sitting directly under the
    channel card. Rail: dot only, the full text moves into the title tooltip. */
function SidebarStatus({ rail }: { rail?: boolean }) {
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const current = channelsData?.channels.find((channel) => channel.id === channelId) ?? channelsData?.channels[0];
  const isQr = current?.source === 'qr';
  const isCentral = current?.source === 'central';
  const { data: qrStatus } = useTgQrStatus(isQr || isCentral);
  const centralOwner = isCentral ? !!qrStatus?.central_owner : false;
  const managed = isQr || (isCentral && centralOwner);
  const { data: history } = useHistory(730);
  const fresh = freshness(latestHistoryDay(history), Date.now());
  const health = sidebarHealth({
    source: current?.source,
    connectionState: managed ? qrStatus?.connection_state ?? null : null,
    fresh,
    centralOwner,
  });
  // Reserve this row's height even before freshness resolves — the same flex row with a muted dot and
  // an invisible (but same-metrics) label — so the nav below doesn't jump down when it appears. That
  // pop-in was the shell-wide layout shift measured on every route (see e2e/layout-shift.spec.ts).
  // The dot stays anchored at the left gutter in both modes; the label is always mounted and rides the
  // shared `.sidebar-copy` mask (faded + collapsed) in the rail rather than unmounting.
  const rowClass = 'grid grid-cols-[40px_minmax(0,1fr)] items-center pt-1 text-2xs text-muted-foreground';
  if (!health) {
    return (
      <div aria-hidden="true" className={rowClass}>
        <span className="flex justify-center">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
        </span>
        <span className="sidebar-copy sidebar-copy-placeholder block truncate pl-2 font-mono">обновлено —</span>
      </div>
    );
  }
  const dotClass = health.tone === 'error' ? 'bg-ember' : health.tone === 'warn' ? 'bg-status-warn' : 'bg-verdant';
  return (
    <div title={rail ? health.label : undefined} className={rowClass}>
      <span aria-hidden="true" className="flex justify-center">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />
      </span>
      <span aria-hidden={rail} className="sidebar-copy block truncate pl-2 font-mono">{health.label}</span>
    </div>
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
          // The first grid track is exactly the rail's available width (64px − 2 × 12px nav inset),
          // so every glyph remains centred on x=32 in both modes while only the copy track collapses.
          'sidebar-nav-item relative grid h-9 grid-cols-[40px_minmax(0,1fr)] items-center overflow-hidden rounded-xl text-sm transition-colors',
          isActive
            ? 'sidebar-nav-item-active font-medium text-foreground'
            : 'text-ink2 hover:bg-hover-row/60 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden="true"
              className="sidebar-rail-active absolute left-0 top-1/2 h-4 w-[3px] rounded-full bg-foreground"
            />
          )}
          <span className="flex justify-center">
            <Icon name={icon} className="h-[18px] w-[18px] shrink-0" />
          </span>
          <span aria-hidden={rail} className="sidebar-copy block truncate whitespace-nowrap pl-2.5">{label}</span>
        </>
      )}
    </NavLink>
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

  return (
    <div className="border-t border-border px-3 py-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Аккаунт"
            title={rail ? email : undefined}
            className="grid w-full grid-cols-[40px_minmax(0,1fr)] items-center overflow-hidden rounded py-1.5 text-left transition-colors hover:bg-hover-row/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center justify-self-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2">
              {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : avatarInitials(email)}
            </span>
            {/* Identity + chevron stay mounted and mask out in the rail (aria-hidden there) rather than
                unmounting, so they slide away with the width instead of popping. */}
            <span aria-hidden={rail} className="sidebar-copy flex min-w-0 items-center gap-2.5 pl-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{email ?? 'Аккаунт'}</span>
                <span className="block truncate text-2xs text-muted-foreground">План {PLAN_LABEL[plan]}</span>
              </span>
              <Icon name="chevron" aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={4}
          className={cn(
            'w-64',
            !rail && 'w-[var(--radix-dropdown-menu-trigger-width)]',
          )}
        >
          <AccountMenuContent email={email} role={role} avatar={avatar} onClose={() => setOpen(false)} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
