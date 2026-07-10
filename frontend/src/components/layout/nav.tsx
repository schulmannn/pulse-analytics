import { useLocation } from 'react-router-dom';
import type { IconName } from '@/components/nav-icons';
import { METRIC_DEFS } from '@/lib/metricDefs';
import { networkByKey, networkForPath, type Network } from '@/lib/networks';

export interface NavLinkDef {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

// Per-network feed sections live in the NETWORK REGISTRY (lib/networks) — the shell never
// hardcodes a platform list. Only the network-AGNOSTIC rows are declared here:
// «Отчёты» — per-USER (not per-channel), trails the network groups in every net.
export const AGNOSTIC_NAV: NavLinkDef[] = [{ to: '/reports', label: 'Отчёты', icon: 'report' }];
// «Главная» — the personal pinned-widget board. Per-USER, like Отчёты, so it leads the nav.
export const HOME_NAV: NavLinkDef = { to: '/home', label: 'Главная', icon: 'home', end: true };

export const SUPER_NAV: NavLinkDef[] = [
  { to: '/admin', label: 'Админ', icon: 'admin' },
  { to: '/bugs', label: 'Баги', icon: 'bugs' },
];

/** The active network, derived purely from the URL — the single source of truth that survives
    deep-links and reloads. Prefix-matched against the registry; the default net is the fallback. */
export function useActiveNetwork(): Network {
  const { pathname } = useLocation();
  return networkForPath(pathname);
}

/** The nav set for the active network — Главная + its feed views + Отчёты. Drives BOTH the
    sidebar's icon rail AND the mobile bottom bar (same routes, denser form). Both nets are 6 tabs
    wide today (MobileBottomNav's grid-cols follows nav.length). */
export function useActiveNetworkNav(): NavLinkDef[] {
  return [HOME_NAV, ...networkByKey(useActiveNetwork()).nav, ...AGNOSTIC_NAV];
}

export const TITLES: Record<string, string> = {
  '/home': 'Главная',
  '/': 'Обзор',
  '/analytics': 'Аналитика',
  '/posts': 'Контент',
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
export const FEED_ROUTES = [
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
export function routeTitle(pathname: string): string {
  const exact = TITLES[pathname];
  if (exact) return exact;
  if (pathname.startsWith('/metrics/')) {
    const key = pathname.split('/')[2] as keyof typeof METRIC_DEFS;
    return METRIC_DEFS[key]?.term ?? 'Метрика';
  }
  if (pathname.startsWith('/reports/')) return 'Отчёт';
  return pathname.startsWith('/instagram') ? 'Instagram' : 'Atlavue';
}
