import { useLocation } from 'react-router-dom';
import type { IconName } from '@/components/nav-icons';
import { NETWORKS, networkByKey, type Network } from '@/lib/networks';
import { useNetworkSelection } from '@/lib/networkStore';

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

/** The active network: a route that owns a network wins immediately (and is persisted); a
    network-agnostic route (/home, /reports, /campaigns/:id, …) keeps the last chosen network
    instead of snapping back to Telegram. Backed by the reactive selection store. */
export function useActiveNetwork(): Network {
  const { pathname } = useLocation();
  return useNetworkSelection(pathname);
}

/** The nav set for the active network — Главная + its feed views + Отчёты. Drives BOTH the
    sidebar's icon rail AND the mobile bottom bar (same routes, denser form). Both nets are 6 tabs
    wide today (MobileBottomNav's grid-cols follows nav.length). */
export function useActiveNetworkNav(): NavLinkDef[] {
  const net = networkByKey(useActiveNetwork());
  return [HOME_NAV, ...net.nav, ...AGNOSTIC_NAV];
}


export const TITLES: Record<string, string> = {
  '/home': 'Главная',
  '/': 'Обзор',
  '/analytics': 'Аналитика',
  '/posts': 'Контент',
  '/mentions': 'Упоминания',
  '/reports': 'Отчёты',
  '/admin': 'Админ',
  '/bugs': 'Баги',
  '/connect': 'Подключение данных',
};

/** Feed routes open with their own header (the block header on TG; the «Instagram · @handle»
    account header + block headers on IG) — a topbar h1 there reads twice (the name in the corner
    AND on the page), so these routes render no topbar title. Covers both feeds' section paths. */
/**
 * Поверхности, которые НЕСУТ СОБСТВЕННЫЙ заголовок, поэтому общий topbar над ними не монтируется.
 *
 * Здесь только то, что не принадлежит ни одной сети: префиксная часть выводится из реестра (см.
 * isFeedRoute). Ручной список и был багом — TG/IG в нём были, «МойСклад» дописали после того, как
 * дубль уехал в прод, «Метрику» после этого, а СДЭК повторил всё заново: над «Обзором» висела
 * надпись «Atlavue» с полосой (владелец, скриншот). Новый источник теперь закрыт самим фактом
 * регистрации префикса.
 */
export const OWN_HEADER_ROUTES = ['/home', '/connect', '/settings'];

/** Ленты сети БЕЗ префикса (Telegram — сеть по умолчанию, её страницы живут в корне). */
export const DEFAULT_FEED_ROUTES = ['/', '/analytics', '/posts', '/mentions'];

/** Совокупный список — остаётся экспортом ради читаемости тестов и отладки. */
export const FEED_ROUTES = [...OWN_HEADER_ROUTES, ...DEFAULT_FEED_ROUTES];

/**
 * Страница сама рисует свой заголовок? Тогда общий topbar (h1 + hairline) не нужен.
 * Любой путь под префиксом зарегистрированной сети считается её лентой.
 */
export function isFeedRoute(pathname: string): boolean {
  if (FEED_ROUTES.includes(pathname)) return true;
  return NETWORKS.some(
    (net) => 'prefix' in net && (pathname === net.prefix || pathname.startsWith(`${net.prefix}/`)),
  );
}

/**
 * Topbar h1 для текущего маршрута.
 *
 * СТРАНИЦЫ МЕТРИК СВОЙ ЗАГОЛОВОК НЕ ОТДАЮТ СЮДА: топбар на них не монтируется вовсе
 * (DashboardLayout, isDesktopExplorerRoute — на md+ его нет, а ниже md вместо него MobileHeader,
 * который routeTitle не читает). Раньше эта ветка звала getMetric и тянула ВЕСЬ каталог метрик
 * (4.4KB gzip) в чанк оболочки — ради строки, которую никто не рисует. Заголовок метрики рисует
 * сама страница, из своего реестра.
 */
export function routeTitle(pathname: string): string {
  const exact = TITLES[pathname];
  if (exact) return exact;
  if (pathname.startsWith('/metrics/') || pathname.startsWith('/widgets/')) return 'Метрика';
  if (pathname.startsWith('/reports/')) return 'Отчёт';
  if (pathname.startsWith('/campaigns/')) return 'Кампания';
  return pathname.startsWith('/instagram') ? 'Instagram' : 'Atlavue';
}
