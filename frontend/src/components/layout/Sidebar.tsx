import { useEffect, useRef, useState } from 'react';
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
import { Icon } from '@/components/nav-icons';
import { SourceSwitcher } from './SourceSwitcher';
import { AccountMenuContent, ACCOUNT_MENU_SHELL, avatarInitials } from './AccountMenu';
import { useActiveNetworkNav, type NavLinkDef } from './nav';
import { useDismiss } from './useDismiss';

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
      className={cn(
        // FLAT canvas strip (steep — owner call): no floating card, no hairline, no inset — the
        // sidebar is just the canvas itself; the content's cards carry all the surface contrast.
        // z-nav lets the overhanging popovers (rail dropdown, user-row menu) paint above the
        // sticky Topbar (z-sticky), under scrim/modals.
        'sticky top-0 z-nav hidden h-screen shrink-0 flex-col bg-background md:flex print:hidden',
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
    <div className={cn('space-y-0.5', label && (rail ? 'mt-3 border-t border-border pt-3' : 'mt-4'))}>
      {label && !rail && (
        <div className="px-2 pb-1 text-2xs font-medium text-ink3">{label}</div>
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
  const rowClass = cn('flex items-center gap-2 pt-1 text-2xs text-muted-foreground', rail ? 'justify-center' : 'px-2');
  if (!health) {
    return (
      <div aria-hidden="true" className={rowClass}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted" />
        {!rail && <span className="truncate font-mono opacity-0">обновлено —</span>}
      </div>
    );
  }
  const dotClass = health.tone === 'error' ? 'bg-ember' : health.tone === 'warn' ? 'bg-status-warn' : 'bg-verdant';
  return (
    <div title={rail ? health.label : undefined} className={rowClass}>
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)}
      />
      {!rail && <span className="truncate font-mono">{health.label}</span>}
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
            'absolute bottom-full z-popover mb-1',
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
