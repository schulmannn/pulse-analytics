import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The reading-model scroll engine shared by every dashboard feed (TG and IG). It turns a set of
 * ordered blocks into ONE scrollable page: each block opens with a fat header, blocks below the
 * fold mount lazily (the D4 progressive-disclosure lesson — no wall of charts on first paint), and
 * a scrollspy keeps the URL / sidebar / topbar in sync with the block under the reader. Every old
 * per-view route stays valid — they all resolve to this feed scrolled to the right block.
 *
 * Both feeds consume THIS module so the 150-line engine (subtle re-anchor timing + frame-starved
 * fallbacks) lives in one place and cannot drift between TG and IG.
 */

export interface FeedBlockDef<S extends string = string> {
  /** The URL-visible section segment ('' = the feed's entry route). */
  section: S;
  /** The full path this block owns — the scrollspy navigates here (replace) as it scrolls in. */
  path: string;
  /** The fat header shown atop the block. */
  title: string;
}

export interface FeedController<S extends string> {
  /** The active (validated) section derived from the URL; '' when the raw param is unknown/absent. */
  section: S;
  /** The BLOCKS index of {@link section}. */
  targetIndex: number;
  /** Ref to attach to the feed container (the scroll queries scope to it). */
  containerRef: RefObject<HTMLDivElement>;
  /** Highest block index mounted so far (one-way). Feed passes `eager={i <= mountedUpTo}`. */
  mountedUpTo: number;
  /** A block reports it has mounted, so the ones above stay eager on the next deep link. */
  markMounted: (index: number) => void;
  /** True when the raw URL param is a non-empty value that is NOT a known section (caller redirects). */
  unknownSection: boolean;
}

/**
 * Wire the scroll engine for a fixed set of blocks. Reads `useParams().section`, validates it, and
 * owns the deep-link scroll, the scrollspy, the wheel/touch hand-back, and manual scroll restoration.
 * The caller renders the blocks (via {@link FeedBlock}) and decides what an unknown section does.
 */
export function useFeed<S extends string>(
  blocks: readonly FeedBlockDef<S>[],
  /** False while the feed body is gated behind a loading skeleton (IG waits on useIgData): the
   *  container isn't mounted yet, so the deep-link scroll must WAIT and re-run when it flips true —
   *  otherwise a cold reload of /instagram/analytics lands at the top. Defaults true (TG renders
   *  its container on first paint). */
  ready: boolean = true,
): FeedController<S> {
  const { section: rawSection } = useParams();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  // While a programmatic scroll (sidebar click / deep link) is in flight the spy stays muted until
  // the TARGET block reaches the reading line — a timeout can't know how long a long smooth scroll
  // takes. User input (wheel/touch) cancels the flight.
  const pendingTarget = useRef<string | null>(null);
  // The path the spy last reported — navigation to the same value must not re-scroll.
  const spyPath = useRef<string | null>(null);

  const sections = blocks.map((b) => b.section) as readonly string[];
  const raw = rawSection ?? '';
  const section: S = (sections.includes(raw) ? raw : '') as S;
  const targetIndex = blocks.findIndex((b) => b.section === section);
  const unknownSection = Boolean(rawSection) && !sections.includes(rawSection as string);

  // The feed anchors scroll itself — the browser's async restoration would land on stale offsets
  // (lazy blocks change the page height after load) and fight the deep-link jump.
  useEffect(() => {
    const prev = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = prev;
    };
  }, []);

  // Deep links below the first block need everything above the target mounted at real height,
  // otherwise the initial scroll lands short.
  const [mountedUpTo, setMountedUpTo] = useState(targetIndex);
  const markMounted = (index: number) => setMountedUpTo((prev) => Math.max(prev, index));

  // Scroll to the addressed block on path changes that did NOT originate from the spy.
  const firstScroll = useRef(true);
  useEffect(() => {
    // The body is still a loading skeleton — the container isn't in the DOM yet. Do nothing and
    // let this effect re-run once `ready` flips (it's in the deps), then perform the deep-link jump.
    if (!ready) return;
    const path = blocks[targetIndex]?.path ?? blocks[0]?.path ?? '/';
    if (spyPath.current === path) {
      spyPath.current = null;
      return;
    }
    setMountedUpTo((prev) => Math.max(prev, targetIndex));
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-feed-block="${section}"]`);
    if (!el) return;
    if (firstScroll.current && targetIndex === 0) {
      firstScroll.current = false;
      return; // landing on the top block — nothing to scroll
    }
    const wasFirst = firstScroll.current;
    firstScroll.current = false;
    pendingTarget.current = section;
    el.scrollIntoView({ behavior: wasFirst ? 'auto' : 'smooth', block: 'start' });
    // Blocks above the target mount right after the jump and inflate the page, pushing the anchor
    // away — re-anchor a few times (deep links: quickly; clicks: once the smooth scroll has mostly
    // finished), then release the spy regardless.
    const delays = wasFirst ? [150, 450, 900] : [900, 1500];
    const timers = delays.map((d) =>
      window.setTimeout(() => {
        if (pendingTarget.current === section) el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }, d),
    );
    const release = window.setTimeout(() => {
      if (pendingTarget.current === section) pendingTarget.current = null;
    }, (delays[delays.length - 1] ?? 0) + 400);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      clearTimeout(release);
    };
  }, [blocks, section, targetIndex, ready]);

  // User input takes the wheel back — an interrupted programmatic scroll re-enables the spy.
  useEffect(() => {
    const cancel = () => {
      pendingTarget.current = null;
    };
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchstart', cancel, { passive: true });
    return () => {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
    };
  }, []);

  // Scrollspy: the active block is the LAST one whose top sits above the reading line (a bit below
  // the sticky topbar). URL updates via replace, so history stays clean. Plain time-throttling (no
  // rAF/IO) — those never tick in frame-starved environments.
  useEffect(() => {
    let lastRun = 0;
    const onScroll = () => {
      const root = containerRef.current;
      if (!root) return;
      // In-flight programmatic scroll: stay muted until the target hits the reading line.
      if (pendingTarget.current != null) {
        const target = root.querySelector<HTMLElement>(`[data-feed-block="${pendingTarget.current}"]`);
        const top = target?.getBoundingClientRect().top;
        if (top != null && Math.abs(top - 88) < 170) pendingTarget.current = null;
        else return;
      }
      const now = Date.now();
      if (now - lastRun < 150) return;
      lastRun = now;
      const readingLine = 140; // sticky topbar + breathing room
      let active: FeedBlockDef<S> = blocks[0];
      for (const block of blocks) {
        const el = root.querySelector<HTMLElement>(`[data-feed-block="${block.section}"]`);
        if (el && el.getBoundingClientRect().top <= readingLine) active = block;
      }
      if (active.section !== section) {
        spyPath.current = active.path;
        navigate({ pathname: active.path, search: window.location.search }, { replace: true });
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [blocks, navigate, section]);

  return { section, targetIndex, containerRef, mountedUpTo, markMounted, unknownSection };
}

/**
 * One block surface (steep Home): a rounded panel a shade apart from the canvas, fat header, then
 * the lazily-mounted content. Light theme uses the full card white (a /50 mix over near-white paper
 * is imperceptible); dark keeps the half-mix so the canvas→surface→widget layering reads.
 */
export function FeedBlock({
  section,
  title,
  eager,
  onMount,
  children,
}: {
  section: string;
  title: string;
  eager: boolean;
  onMount: () => void;
  children: ReactNode;
}) {
  return (
    <section
      data-feed-block={section}
      className="scroll-mt-20 rounded-2xl border border-border bg-card dark:bg-card/50 px-3 py-4 sm:p-7"
    >
      <div className="mb-6">
        <h2 className="text-2xl font-medium tracking-tight text-foreground">{title}</h2>
      </div>
      <LazyBlock eager={eager} onMount={onMount}>
        {children}
      </LazyBlock>
    </section>
  );
}

/**
 * Mounts children when the placeholder approaches the viewport (one-way). Keeps the feed's first
 * paint light — the D4 lesson survives the single-page model. Hoisted out of TgFeed so both feeds
 * share the exact same progressive-disclosure guard.
 */
export function LazyBlock({ eager, onMount, children }: { eager: boolean; onMount: () => void; children: ReactNode }) {
  const [visible, setVisible] = useState(eager);
  const holderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (eager) setVisible(true);
  }, [eager]);

  useEffect(() => {
    if (visible) return;
    const el = holderRef.current;
    if (!el) {
      setVisible(true);
      return;
    }
    const nearViewport = () => el.getBoundingClientRect().top < window.innerHeight + 1200;
    if (nearViewport()) {
      setVisible(true);
      return;
    }
    // IO is the cheap path; the scroll fallback covers environments where observers never fire
    // (frame-starved headless) and doubles as a belt-and-braces check.
    const show = () => setVisible(true);
    const obs =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) show();
            },
            { rootMargin: '1200px 0px' },
          )
        : null;
    obs?.observe(el);
    let lastRun = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - lastRun < 200) return;
      lastRun = now;
      if (nearViewport()) show();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      obs?.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [visible]);

  useEffect(() => {
    if (visible) onMount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (visible) return <>{children}</>;
  return (
    <div ref={holderRef} className="space-y-6" style={{ minHeight: 560 }}>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-4 h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
