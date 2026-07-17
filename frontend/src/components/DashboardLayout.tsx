import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useChannels, useIgProfile } from '@/api/queries';
import { useDemo } from '@/lib/demo-context';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useWidgetPrefsSync } from '@/lib/widgetPrefsStore';
import { cn } from '@/lib/utils';
import { NETWORKS, NetworkGlyph } from '@/lib/networks';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileBottomNav, MobileHeader } from '@/components/layout/MobileNav';
import { FEED_ROUTES, routeTitle, useActiveNetwork } from '@/components/layout/nav';

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
  const { pathname } = useLocation();
  const isDesktopMetricRoute = isMd && pathname.startsWith('/metrics/');
  // Widget customisation follows the account (user_prefs), not the browser.
  useWidgetPrefsSync();
  return (
    // Desktop shell — inset-панель («завершение области», владелец/Kimi-референс): контент живёт
    // в скруглённом окне с зазором от краёв вьюпорта и СОБСТВЕННЫМ скроллом, так что нижняя
    // кромка панели видна всегда, а не убегает за экран. Sticky-шапки страниц липнут к верху
    // панели. Мобильный поток (<md) нетронут: оконный скролл, без рамки.
    <div className="flex min-h-screen bg-background text-foreground md:h-screen md:gap-2.5 md:overflow-hidden md:p-2.5">
      <Sidebar email={email} role={role} avatar={avatar} />
      <div className="flex min-w-0 flex-1 flex-col md:overflow-y-auto md:rounded-2xl md:border md:border-border">
        {isMd ? (
          isDesktopMetricRoute ? null : <Topbar />
        ) : (
          <MobileHeader email={email} role={role} avatar={avatar} platformNav={<PlatformNav />} />
        )}
        {/* Extra bottom padding on mobile clears the fixed bottom nav; md+ navigates via the sidebar. */}
        <main
          className={cn(
            'flex-1 px-4 pb-24 sm:px-6 md:pb-5',
            isDesktopMetricRoute ? 'pt-3' : 'pt-5',
          )}
        >
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
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm">
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
      <span className="text-foreground">Демо-режим — данные примерные, для ознакомления.</span>
      <button
        type="button"
        onClick={exitDemo}
        className="btn-pill ml-auto shrink-0 border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        Выйти из демо
      </button>
    </div>
  );
}

/** Desktop top bar (md+; mobile uses MobileHeader — conditionally, never both mounted).
    Feed and metric routes own their page chrome, so the layout does not mount this bar there.
    It remains for utility pages such as admin, bugs and reports. */
function Topbar() {
  const { pathname } = useLocation();
  const title = FEED_ROUTES.includes(pathname) ? null : routeTitle(pathname);
  if (!title) return null;
  return (
    <header data-dashboard-topbar className="sticky top-0 z-sticky flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:gap-4 sm:px-6 print:hidden">
      <h1 className="min-w-0 truncate text-lg font-medium tracking-tight">{title}</h1>
    </header>
  );
}

/**
 * Network switcher segment — MOBILE ONLY (<md, MobileHeader context bar). The desktop sidebar
 * lists the networks as labeled nav groups instead, but the mobile bottom tab bar shows one
 * network's routes at a time, so this segmented control keeps the other nets reachable on phones.
 * REGISTRY-driven and gated like the sidebar groups: only networks the workspace actually has
 * (all while loading / in demo); with a single network there is nothing to switch — no bar at
 * all. Instagram is demo/mock-backed until connected; `mock === true` (not just "no data")
 * avoids a false flag during the initial load.
 */
function PlatformNav() {
  const navigate = useNavigate();
  const activeKey = useActiveNetwork();
  const igProfile = useIgProfile();
  const igDemo = igProfile.data?.mock === true;
  const { data } = useChannels();
  const { demo } = useDemo();
  const channels = data?.channels ?? [];
  const nets = NETWORKS.filter((n) => !data || demo || channels.some((c) => n.hasChannel(c)));
  if (nets.length < 2) return null;

  // Segment count follows the connected-network count (same trick as MobileBottomNav's columns).
  const GRID_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' };

  // The active segment is a calm neutral surface with a thin brand underline; the brand colour
  // lives ONLY on the icon, so TG-blue / IG-magenta read as identifiers, not UI colour.
  return (
    <div className="border-b px-3 py-2">
      <div className={cn('grid gap-px overflow-hidden rounded border border-border bg-border', GRID_COLS[nets.length] ?? 'grid-cols-2')}>
        {nets.map((p) => {
          const active = p.key === activeKey;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => navigate(p.home)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'relative flex items-center justify-center gap-2 px-2 py-2 text-sm transition-colors',
                active ? 'bg-muted/60 font-medium text-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="shrink-0" style={{ color: p.color, opacity: active ? 1 : 0.55 }}>
                <NetworkGlyph k={p.key} className="h-4 w-4" />
              </span>
              <span className="whitespace-nowrap">{p.name}</span>
              {p.key === 'ig' && igDemo && (
                <span className="rounded-full bg-status-warn/15 px-1.5 py-0.5 text-2xs font-medium text-status-warn">
                  демо
                </span>
              )}
              {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5" style={{ background: p.color }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
