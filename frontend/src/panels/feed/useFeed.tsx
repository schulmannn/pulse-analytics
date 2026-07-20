import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PAGE_HEADER_SHELL } from '@/lib/pageChrome';

/**
 * The section SHELL shared by every dashboard feed page (TG and IG): a FLAT working surface with the
 * sticky shadcn-style page header ({@link FeedBlock}) and the progressive-disclosure mount guard
 * ({@link LazyBlock}). Both networks' focused pages render through this module (via the feed
 * registry, panels/feed/feeds.tsx), so the section look cannot drift between networks.
 *
 * The scroll-feed engine (useFeed: scrollspy + deep-link anchoring) that used to live here retired
 * when the IG feed moved to focused pages — the reading model is real navigation now for every
 * network.
 */

/**
 * One feed section = the SAME flat canvas as the personal Home (владелец: Обзор/Аналитика/Контент
 * должны быть одной flat рабочей поверхностью, как Главная). No own rounded/bordered/card surface
 * and no extra page padding — the widgets below carry the only card chrome, exactly like Home. The
 * sticky header reuses {@link PAGE_HEADER_SHELL} (shared with Home), so its geometry — canvas
 * bleed, translucent bordered surface and gap to the content — stays in lockstep with Home
 * instead of drifting into a private copy of the classes.
 */
export function FeedBlock({
  section,
  title,
  eager,
  onMount,
  children,
  headerRight,
}: {
  section: string;
  title: string;
  eager: boolean;
  onMount: () => void;
  children: ReactNode;
  /** Optional control aligned to the right of the sticky section header (e.g. a period selector). */
  headerRight?: ReactNode;
}) {
  return (
    <section data-feed-block={section} className="scroll-mt-4">
      {/* Sticky page header (shared geometry with Home): «Обзор» stays put while widgets scroll
          under the translucent, bordered site-header surface. */}
      <div className={cn(PAGE_HEADER_SHELL, 'flex items-center justify-between gap-3')}>
        <h2 className="min-w-0 truncate text-2xl font-medium tracking-tight text-foreground">{title}</h2>
        {headerRight}
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
          <div key={i} className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-4 h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
