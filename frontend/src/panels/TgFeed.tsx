import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useChannels } from '@/api/queries';
import { Overview } from '@/panels/Overview';
import { Analytics } from '@/panels/AnalyticsTabs';
import { Posts } from '@/panels/Posts';
import { Mentions } from '@/panels/Mentions';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * TG feed — the steep-Home reading model (owner call): Обзор → Аналитика → Посты →
 * Упоминания as ONE scrollable page. Each block opens with a bold header and generous
 * spacing, blocks below the fold mount lazily (the D4 progressive-disclosure lesson —
 * no 20-chart wall on first paint), and a scrollspy keeps the URL / sidebar / topbar in
 * sync with the block under the reader. The four old routes stay valid: they all resolve
 * to this feed scrolled to the right block, so every existing deep link works.
 */

const BLOCKS = [
  { section: '', path: '/', title: 'Обзор' },
  { section: 'analytics', path: '/analytics', title: 'Аналитика' },
  { section: 'posts', path: '/posts', title: 'Посты' },
  { section: 'mentions', path: '/mentions', title: 'Упоминания' },
] as const;
type FeedSection = (typeof BLOCKS)[number]['section'];

const SECTIONS: readonly string[] = BLOCKS.map((b) => b.section);

function renderBlock(section: FeedSection): ReactNode {
  switch (section) {
    case '':
      return <Overview />;
    case 'analytics':
      return <Analytics />;
    case 'posts':
      return <Posts />;
    case 'mentions':
      return <Mentions />;
  }
}

export function TgFeed() {
  const { section: rawSection } = useParams();
  const navigate = useNavigate();
  const { data: channelsData } = useChannels();
  const containerRef = useRef<HTMLDivElement>(null);
  // While a programmatic scroll (sidebar click / deep link) is in flight the spy stays
  // muted until the TARGET block reaches the reading line — a timeout can't know how long
  // a long smooth scroll takes. User input (wheel/touch) cancels the flight.
  const pendingTarget = useRef<string | null>(null);
  // The path the spy last reported — navigation to the same value must not re-scroll.
  const spyPath = useRef<string | null>(null);

  const section: FeedSection = SECTIONS.includes(rawSection ?? '') ? ((rawSection ?? '') as FeedSection) : '';
  const targetIndex = BLOCKS.findIndex((b) => b.section === section);

  // The feed anchors scroll itself — the browser's async restoration would land on stale
  // offsets (lazy blocks change the page height after load) and fight the deep-link jump.
  useEffect(() => {
    const prev = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = prev;
    };
  }, []);

  // Deep links below the first block need everything above the target mounted at real
  // height, otherwise the initial scroll lands short.
  const [mountedUpTo, setMountedUpTo] = useState(targetIndex);

  // Scroll to the addressed block on path changes that did NOT originate from the spy.
  const firstScroll = useRef(true);
  useEffect(() => {
    const path = BLOCKS[targetIndex]?.path ?? '/';
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
    // Blocks above the target mount right after the jump and inflate the page, pushing the
    // anchor away — re-anchor a few times (deep links: quickly; clicks: once the smooth
    // scroll has mostly finished), then release the spy regardless.
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
  }, [section, targetIndex]);

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

  // Scrollspy: the active block is the LAST one whose top sits above the reading line
  // (a bit below the sticky topbar). URL updates via replace, so history stays clean.
  // Plain time-throttling (no rAF/IO) — those never tick in frame-starved environments.
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
      let active: (typeof BLOCKS)[number] = BLOCKS[0];
      for (const block of BLOCKS) {
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
  }, [navigate, section]);

  if (rawSection && !SECTIONS.includes(rawSection)) return <Navigate to="/" replace />;

  // Without a single channel the Overview shows the GetStarted onboarding — the rest of
  // the feed would be empty-state noise below it.
  const noChannels = channelsData !== undefined && (channelsData.channels?.length ?? 0) === 0;
  if (noChannels) return <Overview />;

  return (
    <div ref={containerRef} className="space-y-10">
      {BLOCKS.map((block, i) => (
        <section
          key={block.section}
          data-feed-block={block.section}
          // One giant widget surface per block (steep Home): a rounded panel a shade apart
          // from the canvas, with the widget cards layered on top of it. Light theme uses the
          // full card white (a /50 mix over near-white paper is imperceptible); dark keeps the
          // half-mix so the canvas→surface→widget layering reads. Mobile trims the side inset —
          // the surface adds a padding ring on top of the shell + widget cards.
          className="scroll-mt-20 rounded-2xl border border-border bg-card dark:bg-card/50 px-3 py-4 sm:p-7"
        >
          <div className="mb-6">
            <h2 className="text-2xl font-medium tracking-tight text-foreground">{block.title}</h2>
          </div>
          <LazyBlock eager={i <= Math.max(mountedUpTo, 0)} onMount={() => setMountedUpTo((prev) => Math.max(prev, i))}>
            {renderBlock(block.section)}
          </LazyBlock>
        </section>
      ))}
    </div>
  );
}

/**
 * Mounts children when the placeholder approaches the viewport (one-way). Keeps the feed's
 * first paint light — the D4 lesson survives the single-page model.
 */
function LazyBlock({ eager, onMount, children }: { eager: boolean; onMount: () => void; children: ReactNode }) {
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
    // IO is the cheap path; the scroll fallback covers environments where observers
    // never fire (frame-starved headless) and doubles as a belt-and-braces check.
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
