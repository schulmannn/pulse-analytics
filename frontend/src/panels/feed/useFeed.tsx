import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The section SHELL shared by every dashboard feed page (TG and IG): the rounded block surface
 * with the sticky fat header ({@link FeedBlock}) and the progressive-disclosure mount guard
 * ({@link LazyBlock}). Both networks' focused pages render through this module (via the feed
 * registry, panels/feed/feeds.tsx), so the section look cannot drift between networks.
 *
 * The scroll-feed engine (useFeed: scrollspy + deep-link anchoring) that used to live here retired
 * when the IG feed moved to focused pages — the reading model is real navigation now for every
 * network.
 */

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
    <section
      data-feed-block={section}
      className="scroll-mt-4 rounded-2xl border border-border bg-card dark:bg-card/50 px-3 py-4 sm:p-7"
    >
      {/* Sticky section title (steep): «Обзор» stays put while the widgets scroll under it. It
          spans the card width (negative margins cancel the section padding) and rounds to match the
          card top. Фон — .feed-head-surface (index.css): РОВНО тот же цвет, что тело секции,
          непрозрачный. Полупрозрачный blur-фон прошлой итерации читался как более светлая полоса
          с «серой линией» на стыке (владелец) — теперь шапка неотличима от секции, пока контент
          не подъедет под неё, и просто срезает его без видимого шва. Отступ до виджетов ужат
          mb-6→mb-2 + pb-3→pb-1.5 (steep-плотность). top-0 (не top-2): на фид-роутах топбара нет,
          а 8px-зазор над заголовком просвечивал заезжающий контент — прижимаем к самому верху
          (баг «полоса пропускает текст сверху»). z-10 keeps it under widget menus (z-popover). */}
      <div className="feed-head-surface sticky top-0 z-10 -mx-3 -mt-4 mb-2 flex items-center justify-between gap-3 rounded-t-2xl px-3 pb-1.5 pt-4 sm:-mx-7 sm:-mt-7 sm:px-7 sm:pt-7">
        <h2 className="text-2xl font-medium tracking-tight text-foreground">{title}</h2>
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
