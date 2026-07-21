import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/nav-icons';
import { SourceSwitcher } from './SourceSwitcher';
import { AccountMenu } from './AccountMenu';
import { useActiveNetworkNav } from './nav';

/**
 * Fixed bottom tab bar for mobile (sidebar is hidden below md). Figma 390 shows the four
 * primary views here; system links (Настройки / Админ / Баги) move into the account menu so
 * the bar stays uncrowded. Icon tints via currentColor, so `text-primary` colours the active glyph.
 */
export function MobileBottomNav() {
  const nav = useActiveNetworkNav();
  // Column count follows the active-network nav so the tabs fill the bar exactly (a hardcoded
  // count wraps the extra tab onto a second row / leaves a dead column). Both nets now carry the
  // «Главная» leader + «Отчёты» tail, so both are 6 wide — but keep this length-driven in case a
  // network's feed set changes.
  const GRID_COLS: Record<number, string> = { 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6' };
  return (
    <nav
      className={cn(
        'fixed inset-x-0 bottom-0 z-nav grid border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:hidden print:hidden',
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

/**
 * Mobile header (md:hidden) — replaces the desktop top bar below md (Figma 390). Row 1: channel
 * identity + account avatar. Row 2: full-width segmented platform switch. The global period strip
 * is gone — period is now per-widget (each card carries its own 7д/30д/90д/Всё control).
 */
export function MobileHeader({ email, role, avatar, platformNav }: { email?: string; role?: string; avatar?: string | null; platformNav: ReactNode }) {
  return (
    <div className="print:hidden">
      <div className="flex items-center gap-2 border-b py-2 pr-3">
        <div className="min-w-0 flex-1">
          <SourceSwitcher mobile />
        </div>
        <AccountMenu email={email} role={role} avatar={avatar} />
      </div>
      {platformNav}
    </div>
  );
}
