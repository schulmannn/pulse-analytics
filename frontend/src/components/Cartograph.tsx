import { cn } from '@/lib/utils';

/**
 * Cartograph — the one source of line-art illustration for Atlavue's error / empty / 404 states
 * (Atlavue = atlas + view, so the empty and the broken speak cartography). Stroke-only like the
 * nav icons, one blue accent (--primary), everything else on --border / --muted-foreground, so it
 * themes for free (near-black ↔ warm-paper). Ambient motion is subtle and auto-disabled under
 * prefers-reduced-motion (see index.css .cartograph-* classes).
 *
 *   compass       — lost bearings → the app-shell crash (ErrorBoundary)
 *   off-map       — a route off the edge of the map → 404 (NotFound)
 *   broken-route  — a route with a gap → load / fetch failure (ErrorState)
 *   terra         — uncharted blank territory → empty state (EmptyState)
 *   globe         — graticule sphere, a broken meridian → alternate crash motif
 */
export type CartographName = 'compass' | 'off-map' | 'broken-route' | 'terra' | 'globe';

interface CartographProps {
  name: CartographName;
  /** Size + spacing via Tailwind (e.g. "h-28 w-auto"). Aspect comes from the viewBox. */
  className?: string;
  /** Ambient motion (default on; always off under prefers-reduced-motion). */
  animate?: boolean;
}

const VIEWBOX: Record<CartographName, string> = {
  compass: '0 0 160 160',
  globe: '0 0 160 160',
  'off-map': '0 0 220 150',
  'broken-route': '0 0 200 110',
  terra: '0 0 72 72',
};

export function Cartograph({ name, className, animate = true }: CartographProps) {
  return (
    <svg
      viewBox={VIEWBOX[name]}
      className={cn('cartograph block h-32 w-auto', className)}
      fill="none"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'compass' && <Compass animate={animate} />}
      {name === 'globe' && <Globe animate={animate} />}
      {name === 'off-map' && <OffMap animate={animate} />}
      {name === 'broken-route' && <BrokenRoute animate={animate} />}
      {name === 'terra' && <Terra animate={animate} />}
    </svg>
  );
}

const tick = 'stroke-border';
const faint = 'stroke-border opacity-50';

function Compass({ animate }: { animate: boolean }) {
  return (
    <>
      <circle cx="80" cy="80" r="62" className={tick} />
      <circle cx="80" cy="80" r="50" className={faint} strokeDasharray="1 6" />
      <path d="M80 46 96 80 80 114 64 80Z" className={faint} />
      <line x1="80" y1="20" x2="80" y2="32" className={tick} />
      <line x1="80" y1="128" x2="80" y2="140" className={tick} />
      <line x1="20" y1="80" x2="32" y2="80" className={tick} />
      <line x1="128" y1="80" x2="140" y2="80" className={tick} />
      <line x1="111" y1="49" x2="117" y2="43" className={faint} />
      <line x1="43" y1="49" x2="49" y2="43" className={faint} />
      <line x1="111" y1="111" x2="117" y2="117" className={faint} />
      <line x1="43" y1="111" x2="49" y2="117" className={faint} />
      <g className={animate ? 'cartograph-needle' : undefined}>
        <polygon points="80,42 88,80 72,80" className="fill-primary" />
        <polygon points="72,80 88,80 80,118" className="fill-muted-foreground" />
      </g>
      <circle cx="80" cy="80" r="4.5" className="fill-card" />
      <circle cx="80" cy="80" r="1.8" className="fill-primary" />
      <text x="80" y="14" textAnchor="middle" className="fill-muted-foreground font-mono" style={{ fontSize: '11px' }}>N</text>
      <text x="80" y="153" textAnchor="middle" className="fill-muted-foreground font-mono" style={{ fontSize: '9px' }}>S</text>
      <text x="9" y="83" className="fill-muted-foreground font-mono" style={{ fontSize: '9px' }}>W</text>
      <text x="146" y="83" className="fill-muted-foreground font-mono" style={{ fontSize: '9px' }}>E</text>
    </>
  );
}

function Globe({ animate }: { animate: boolean }) {
  return (
    <>
      <circle cx="80" cy="80" r="60" className={tick} />
      <ellipse cx="80" cy="80" rx="26" ry="60" className={faint} />
      <ellipse cx="80" cy="80" rx="50" ry="60" className={faint} />
      <line x1="20" y1="80" x2="140" y2="80" className={faint} />
      <line x1="27" y1="52" x2="133" y2="52" className={faint} />
      <line x1="27" y1="108" x2="133" y2="108" className={faint} />
      <path d="M80 20 V140" className="stroke-primary" strokeDasharray="4 6" />
      <circle cx="80" cy="80" r="3" className={cn('fill-primary', animate && 'cartograph-orbit')} />
    </>
  );
}

function OffMap({ animate }: { animate: boolean }) {
  return (
    <>
      <rect x="14" y="20" width="150" height="112" rx="4" className={tick} />
      <line x1="64" y1="20" x2="64" y2="132" className={faint} />
      <line x1="114" y1="20" x2="114" y2="132" className={faint} />
      <line x1="14" y1="57" x2="164" y2="57" className={faint} />
      <line x1="14" y1="94" x2="164" y2="94" className={faint} />
      <circle cx="54" cy="104" r="3.5" className="fill-primary" />
      <path d="M54 104 C 84 92 96 118 122 94 S 172 66 198 52" className="stroke-primary opacity-50" strokeDasharray="3 5" />
      {animate && <circle r="2.6" className="fill-primary cartograph-travel" />}
      <path d="M198 38c9 0 13 10 0 22-13-12-9-22 0-22Z" className="fill-primary" />
      <circle cx="198" cy="47" r="3.4" className="fill-card" />
      <ellipse cx="198" cy="64" rx="7" ry="2" className={faint} />
      <text x="208" y="34" className="fill-muted-foreground font-mono" style={{ fontSize: '11px' }}>?</text>
    </>
  );
}

function BrokenRoute({ animate }: { animate: boolean }) {
  return (
    <>
      <circle cx="42" cy="70" r="4" className={cn('fill-primary', animate && 'cartograph-pulse')} />
      <circle cx="158" cy="46" r="4" className={cn('fill-muted-foreground', animate && 'cartograph-pulse-2')} />
      <path d="M42 70 C 66 58 82 60 90 62" className="stroke-primary opacity-50" strokeDasharray="3 5" />
      <path d="M110 58 C 130 54 146 50 158 48" className="stroke-muted-foreground opacity-50" strokeDasharray="3 5" />
      <line x1="98" y1="52" x2="102" y2="68" className="stroke-muted-foreground" />
      <line x1="104" y1="50" x2="108" y2="66" className="stroke-muted-foreground" />
    </>
  );
}

function Terra({ animate }: { animate: boolean }) {
  return (
    <>
      <rect x="10" y="16" width="52" height="44" rx="3" className={faint} strokeDasharray="3 4" />
      <line x1="27" y1="16" x2="27" y2="60" className={faint} />
      <line x1="44" y1="16" x2="44" y2="60" className={faint} />
      <line x1="10" y1="31" x2="62" y2="31" className={faint} />
      <line x1="10" y1="45" x2="62" y2="45" className={faint} />
      <g className={animate ? 'cartograph-flag' : undefined}>
        <line x1="42" y1="24" x2="42" y2="47" className="stroke-primary" />
        <path d="M42 24 54 28 42 32Z" className="fill-primary" />
      </g>
      <circle cx="42" cy="47" r="2" className="fill-primary" />
    </>
  );
}
