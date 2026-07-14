import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChannels } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useLayerBack } from '@/lib/useLayerBack';
import { fmt, pluralRu } from '@/lib/format';
import { cn } from '@/lib/utils';
import { NETWORKS, NetworkGlyph, networkByKey, routeNetworkOwner, type Network } from '@/lib/networks';
import { setActiveNetwork } from '@/lib/networkStore';
import { Icon } from '@/components/nav-icons';
import { ChannelAvatar } from '@/components/ChannelAvatar';
import { useActiveNetwork } from './nav';
import { useDismiss } from './useDismiss';

/** 6 muted identity tints (see index.css --chip-N-*) picked deterministically from the channel
    name, so a channel keeps its colour across reloads, themes and dropdown rows. */
const CHIP_TINTS = ['chip-tint-1', 'chip-tint-2', 'chip-tint-3', 'chip-tint-4', 'chip-tint-5', 'chip-tint-6'];
function chipTint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return CHIP_TINTS[Math.abs(h) % CHIP_TINTS.length];
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
  const color = networkByKey(network).color;
  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-full border border-border bg-background',
        className,
      )}
      style={{ color }}
      aria-hidden="true"
    >
      <NetworkGlyph k={network} className="h-2.5 w-2.5" />
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
export function SourceSwitcher({ rail = false, mobile = false }: { rail?: boolean; mobile?: boolean }) {
  const { data } = useChannels();
  const { channelId, setChannelId } = useSelectedChannel();
  const network = useActiveNetwork();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const channels = data?.channels ?? [];

  // Initialise / validate the selected channel once the list loads (drives X-Channel-Id). The pair
  // that matters is (channel, ACTIVE NETWORK): the selected channel must expose the active network
  // as a source (registry `hasChannel`), else a TG-only channel left active while the shell is on
  // Instagram would 404 every IG query. A valid pair is preserved; a stale one recovers to the
  // server's `selected`, then the first eligible channel. If no channel exposes the active network
  // (shouldn't happen — the net wouldn't be reachable), fall back to the full list so selection
  // never wedges empty. (Bootstrap moved here from the old ChannelCard.)
  useEffect(() => {
    if (!data || channels.length === 0) return;
    const eligible = channels.filter((c) => networkByKey(network).hasChannel(c));
    if (eligible.length === 0 && network !== NETWORKS[0].key && routeNetworkOwner(pathname) == null) {
      setActiveNetwork(NETWORKS[0].key);
      return;
    }
    const pool = eligible.length ? eligible : channels;
    if (channelId != null && pool.some((c) => c.id === channelId)) return;
    const serverSelected = pool.find((c) => c.id === data.selected)?.id;
    setChannelId(serverSelected ?? pool[0].id);
  }, [channelId, channels, data, network, pathname, setChannelId]);

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
  // Only the default net (TG) has richer channel facts to show; other networks label themselves.
  const subtitle =
    network !== NETWORKS[0].key
      ? networkByKey(network).name
      : count != null && count > 0
        ? count >= 1e4
          ? `${fmt.kpi(count)} подписчиков`
          : `${fmt.num(count)} ${pluralRu(count, ['подписчик', 'подписчика', 'подписчиков'])}`
        : current?.source === 'collector'
          ? 'Локальный сбор'
          : networkByKey(network).name;

  // The dropdown always opens (even with a single channel) — it's how the user crosses NETWORKS,
  // not only how they switch channels.
  const openable = channels.length > 0;

  // Search only when the flat source list gets long (all networks × channels). Mirrors the
  // command palette's simple substring filter.
  const totalRows = channels.length * NETWORKS.length;
  const showSearch = totalRows > 8;

  const pick = (row: SourceRow) => {
    setChannelId(row.channelId);
    // Persist the picked network up front — the destination home route owns it too, but setting it
    // here keeps the shell from flashing the previous network before navigation resolves.
    setActiveNetwork(row.network);
    void queryClient.cancelQueries();
    setOpen(false);
    // The focused row unmounts with the popover — hand focus back to the trigger so a keyboard
    // user switching sources keeps their place instead of restarting from the document top.
    triggerRef.current?.focus();
    navigate(networkByKey(row.network).home);
  };

  const filtered = (net: Network): SourceRow[] => {
    const q = query.trim().toLowerCase();
    return channels
      // Which channels expose this network as a source — the registry predicate (lib/networks).
      // An empty group auto-hides below (rows.length === 0 → null), so unconnected networks get
      // no demo/mock rows here.
      .filter((c) => networkByKey(net).hasChannel(c))
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
        {NETWORKS.map((p) => {
          const net = p.key;
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
            'absolute top-full z-popover mt-1 overflow-hidden rounded border bg-popover p-1',
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
  // The phone's back gesture closes the sheet instead of leaving the page (its whole audience is <md).
  useLayerBack(onClose);
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
      <div className="detail-backdrop-in absolute inset-0 bg-background/70 backdrop-blur-sm backdrop-grayscale" onClick={onClose} aria-hidden="true" />
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
