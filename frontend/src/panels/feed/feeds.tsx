import { Suspense, lazy } from 'react';
import type { ComponentType } from 'react';
import { Navigate } from 'react-router-dom';
import { networkByKey, type Network } from '@/lib/networks';
import { PagePeriodProvider } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';
import { FeedBlock } from '@/panels/feed/useFeed';
import { TgSectionLayout, TgPagePeriodControl } from '@/panels/TgFeed';
import { Overview } from '@/panels/Overview';
import { Analytics } from '@/panels/AnalyticsTabs';
import { Posts } from '@/panels/Posts';
import { Mentions } from '@/panels/Mentions';

/**
 * FEED REGISTRY — the second layer over the network registry (lib/networks): where lib/networks
 * declares WHICH sections a network has (routes, labels, icons — the nav), this module declares
 * what each section RENDERS. One declaration shape and ONE page renderer ({@link FeedSectionPage})
 * serve every network, so a new source never grows its own feed fork: register the network
 * (lib/networks), map its section bodies here, done — the shell, section chrome, period control
 * placement and route wiring are shared code (the «unified feed architecture» roadmap card).
 *
 * Section paths/titles are NOT repeated here — they're derived from the network's nav, so a label
 * or route change in lib/networks flows to the sidebar, the mobile bar, the page headers and the
 * routes from one edit.
 */

/** What a section contributes beyond its nav row: the body + optional header-right control. */
interface SectionParts {
  /** Self-contained section body. Network-wide data arrives via the feed shell (context), not props. */
  Body: ComponentType;
  /** Control aligned right in the sticky section header (period chips). Rendered under its own
      null-fallback Suspense, so a lazy control never blanks the header. */
  HeaderRight?: ComponentType;
}

export interface FeedSectionDef extends SectionParts {
  /** URL segment under the network's prefix ('' = the entry route). */
  section: string;
  /** Fat sticky header title — the nav label, by construction. */
  title: string;
}

export interface NetworkFeedDef {
  /** Layout-route element: owns the network's shared chrome (providers, gates, account header)
      and renders the addressed section через <Outlet/>. */
  Shell: ComponentType;
  sections: FeedSectionDef[];
}

/** React.lazy over a NAMED export (the IG cluster exports everything by name). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyFrom<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

// The IG side stays a SINGLE async chunk (bundle discipline: a logged-in TG-only user never pays
// for it) — everything lazies out of the same barrel, exactly like the old IgFeed route did.
const igLoad = () => import('@/panels/instagram/ig-cluster');
const IgShell = lazyFrom(igLoad, 'IgShell');
const IgOverviewPage = lazyFrom(igLoad, 'IgOverviewPage');
const IgAnalyticsPage = lazyFrom(igLoad, 'IgAnalyticsPage');
const IgContentPage = lazyFrom(igLoad, 'IgContentPage');
const IgAudiencePage = lazyFrom(igLoad, 'IgAudiencePage');
const IgPeriodControl = lazyFrom(igLoad, 'IgPeriodControl');

/** The lazy IG shell still needs a Suspense above it — same content-area scaffold as the other
    lazy routes, drawn here so the registry stays self-contained. PagePeriodProvider sits ABOVE
    the shell (TgSectionLayout parity): IgShell's own useIgData call reads the page period, and
    the header chips (IgPeriodControl in the section headers) drive the same value — one period
    system for both networks. */
function IgShellRoute() {
  return (
    <PagePeriodProvider>
      <Suspense fallback={<SectionSkeleton />}>
        <IgShell />
      </Suspense>
    </PagePeriodProvider>
  );
}

/** Layout-matching section scaffold (never a spinner): title + two card ghosts. */
function SectionSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-48" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <Skeleton className="h-3 w-1/3" />
            {/* Steep card anatomy (number bottom-left, chart right) — no outline jump on load. */}
            <div className="mt-4 flex items-end gap-4">
              <div className="shrink-0">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="mt-2 h-3 w-16" />
              </div>
              <Skeleton className="h-36 min-w-0 flex-1" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Per-network section bodies, keyed by URL segment ─────────────────────────
// Посты/Упоминания are LISTS (no windowed metric cards), so no period control; every windowed
// section carries its network's period chips in the sticky header — one placement rule everywhere.

const TG_PARTS: Record<string, SectionParts> = {
  '': { Body: Overview, HeaderRight: TgPagePeriodControl },
  analytics: { Body: Analytics, HeaderRight: TgPagePeriodControl },
  posts: { Body: Posts },
  mentions: { Body: Mentions },
};

const IG_PARTS: Record<string, SectionParts> = {
  '': { Body: IgOverviewPage, HeaderRight: IgPeriodControl },
  analytics: { Body: IgAnalyticsPage, HeaderRight: IgPeriodControl },
  content: { Body: IgContentPage, HeaderRight: IgPeriodControl },
  audience: { Body: IgAudiencePage, HeaderRight: IgPeriodControl },
};

/** Zip the network's nav (paths + labels — the single source of truth) with the body map. A nav
    row without a body is skipped defensively rather than crashing the whole feed. */
function buildSections(net: Network, parts: Record<string, SectionParts>): FeedSectionDef[] {
  const def = networkByKey(net);
  return def.nav.flatMap((item) => {
    const section = item.to === def.home ? '' : item.to.slice((def.prefix ?? '').length).replace(/^\//, '');
    const part = parts[section];
    return part ? [{ section, title: item.label, ...part }] : [];
  });
}

export const FEEDS: Record<Network, NetworkFeedDef> = {
  tg: { Shell: TgSectionLayout, sections: buildSections('tg', TG_PARTS) },
  ig: { Shell: IgShellRoute, sections: buildSections('ig', IG_PARTS) },
};

/**
 * THE feed page — every network's every section renders through this one component: the section
 * shell (rounded card + sticky fat header, {@link FeedBlock}) + the declared body. Focused pages
 * for both networks (the TG model); the IG scroll-феed retired with this.
 */
export function FeedSectionPage({ net, section }: { net: Network; section: string }) {
  const def = FEEDS[net].sections.find((s) => s.section === section);
  if (!def) return <Navigate to={networkByKey(net).home} replace />;
  const { Body, HeaderRight } = def;
  return (
    <FeedBlock
      section={def.section}
      title={def.title}
      eager
      onMount={() => {}}
      headerRight={
        HeaderRight ? (
          <Suspense fallback={null}>
            <HeaderRight />
          </Suspense>
        ) : undefined
      }
    >
      <Suspense fallback={<SectionSkeleton />}>
        <Body />
      </Suspense>
    </FeedBlock>
  );
}
