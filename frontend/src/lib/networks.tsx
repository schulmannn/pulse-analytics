import type { IconName } from '@/components/nav-icons';

/** One nav row (sidebar / rail / mobile bar). `end` = exact-match NavLink for index routes. */
export interface NavLinkDef {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

/** The channel fields network predicates read — structural, the API channel object satisfies it. */
export interface ChannelSourceLike {
  source?: string | null;
  ig_connected?: boolean | null;
}

/**
 * NETWORK REGISTRY — the single place a data source (network) is defined. Everything
 * network-shaped in the shell reads THIS list: the sidebar's labelled nav groups, the icon rail
 * and mobile bottom bar (active network's sections), the source switcher's dropdown groups, the
 * mobile network segment, the avatar badges. Adding a future source (YouTube, VK, TikTok, …) is
 * one entry here plus its routes/pages — never a new per-network fork in the shell (owner call:
 * «в будущем будет не только тг или иг»).
 *
 * Section lists follow ONE canonical order (Обзор → Аналитика → контент → аудитория/охват), so
 * the mental model survives crossing networks.
 */
export interface NetworkDef {
  key: string;
  /** Human name — nav group labels, switcher groups, the mobile segment. */
  name: string;
  /** Platform brand colour (platform identity, not the app palette — intentional hex). */
  color: string;
  /** Route the network opens on when switched to. */
  home: string;
  /** Route prefix owning this network's pages. The prefixless FIRST entry is the default network. */
  prefix?: string;
  /** The network's feed sections, canonical order. */
  nav: readonly NavLinkDef[];
  /** Does this workspace channel expose the network as a source? Drives which groups render. */
  hasChannel: (c: ChannelSourceLike) => boolean;
}

export const NETWORKS = [
  {
    key: 'tg',
    name: 'Telegram',
    color: '#229ED9',
    home: '/',
    nav: [
      { to: '/', label: 'Обзор', icon: 'overview', end: true },
      { to: '/analytics', label: 'Аналитика', icon: 'analytics' },
      // «Контент» — the canonical content-units slot, one label across networks (ИА-унификация);
      // the route stays /posts so deep links survive.
      { to: '/posts', label: 'Контент', icon: 'posts' },
      { to: '/mentions', label: 'Упоминания', icon: 'mentions' },
    ],
    // Standalone Instagram/МойСклад sources have no Telegram side.
    hasChannel: (c) => c.source !== 'ig' && c.source !== 'ms',
  },
  {
    key: 'ig',
    name: 'Instagram',
    color: '#E1306C',
    home: '/instagram',
    prefix: '/instagram',
    nav: [
      { to: '/instagram', label: 'Обзор', icon: 'overview', end: true },
      { to: '/instagram/analytics', label: 'Аналитика', icon: 'analytics' },
      { to: '/instagram/content', label: 'Контент', icon: 'posts' },
      { to: '/instagram/audience', label: 'Аудитория', icon: 'audience' },
    ],
    // Instagram is offered ONLY for channels with a linked IG account.
    hasChannel: (c) => !!c.ig_connected,
  },
  {
    // «МойСклад» — первый не-социальный источник (продажи/заказы). Величины (выручка ₽,
    // заказы) — СВОИ, с просмотрами/охватом не смешиваются (канон TG-views ≠ IG-reach).
    key: 'ms',
    name: 'МойСклад',
    color: '#1F7FD0',
    home: '/sklad',
    prefix: '/sklad',
    nav: [
      { to: '/sklad', label: 'Обзор', icon: 'overview', end: true },
      // «Клиенты» — покупательская аналитика архива заказов (новые/повторные, когорты).
      { to: '/sklad/clients', label: 'Клиенты', icon: 'audience' },
    ],
    // Отдельный канал source='ms', создаётся при подключении токена.
    hasChannel: (c) => c.source === 'ms',
  },
] as const satisfies readonly NetworkDef[];

/** Network key union — extends automatically when a registry entry is added. */
export type Network = (typeof NETWORKS)[number]['key'];

/** Look up a network by key; unknown keys fall back to the default (first) network. */
export function networkByKey(key: string): NetworkDef {
  return NETWORKS.find((n) => n.key === key) ?? NETWORKS[0];
}

/** The network owning a pathname — matched by prefix; the prefixless first entry is the default. */
export function networkForPath(pathname: string): Network {
  return (NETWORKS.find((n) => 'prefix' in n && pathname.startsWith(n.prefix)) ?? NETWORKS[0]).key;
}

/**
 * Which network a route EXPLICITLY owns — or `null` when the route is network-agnostic. Unlike
 * networkForPath (which defaults every unowned path to TG), this reports «no opinion» for shared
 * surfaces (/home, /reports, /campaigns/:id, /settings, …) so the network-selection store can keep
 * the last chosen network there instead of snapping back to Telegram. Matching is EXACT, not
 * prefix-based, apart from the /instagram and /metrics families:
 *   /instagram, /instagram/*         → ig
 *   exact /, /analytics, /posts, /mentions → tg
 *   /metrics/ig-*                    → ig; other /metrics/*  → tg
 *   everything else                  → null (agnostic — the store decides)
 */
export function routeNetworkOwner(pathname: string): Network | null {
  if (pathname === '/sklad' || pathname.startsWith('/sklad/')) return 'ms';
  if (pathname === '/instagram' || pathname.startsWith('/instagram/')) return 'ig';
  if (pathname === '/' || pathname === '/analytics' || pathname === '/posts' || pathname === '/mentions') {
    return 'tg';
  }
  if (pathname.startsWith('/metrics/')) {
    return pathname.slice('/metrics/'.length).startsWith('ig-') ? 'ig' : 'tg';
  }
  return null;
}

/** Brand glyph for network chips/badges — draws in currentColor; the call site tints it the
    network's brand colour on a neutral chip (no filled square). A new network adds its glyph here. */
export function NetworkGlyph({ k, className }: { k: string; className?: string }) {
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
  if (k === 'ms') {
    // «МойСклад» — коробка-склад: стилизованный короб с крышкой, в духе stroke-only сета.
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
        <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" strokeLinejoin="round" />
        <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" strokeLinejoin="round" />
      </svg>
    );
  }
  return null;
}
