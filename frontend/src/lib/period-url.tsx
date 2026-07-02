import { useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { usePeriod } from '@/lib/period';

/** Local-date YYYY-MM-DD for a timestamp (URL serialisation of a range endpoint). */
function toDayParam(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Routes that OWN a period explorer — the only surfaces whose global-provider window is a real,
    user-facing state worth serialising. Everything else (the feed) is per-widget now, so a global
    `?p/from&to` there would be a misleading artifact of the retired topbar switcher. */
function ownsPeriodUrl(pathname: string): boolean {
  return pathname.startsWith('/metrics/') || pathname.startsWith('/reports/');
}

/**
 * One-way state→URL sync for the active period (renders nothing). SCOPED to the period-explorer
 * routes (metric pages / reports) — under the per-widget model the feed has no single global
 * window to serialise, so on every other route this strips any stale `?p/from&to` instead of
 * writing one. Written with `replace` (no history spam; Back keeps navigating routes):
 * - rolling preset ≠ default → ?p=7d|90d|all (the default 30д keeps the URL clean)
 * - shifted/custom window   → ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * The READ side is PeriodProvider's initializer (lib/period), so a shared metric/report link
 * restores the window on load. Unrelated params (?chart, ?grain…) are preserved.
 */
export function PeriodUrlSync() {
  const { days, range } = usePeriod();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const owns = ownsPeriodUrl(pathname);

  useEffect(() => {
    const next = new URLSearchParams(params);
    next.delete('p');
    next.delete('from');
    next.delete('to');
    // Only the period-explorer routes serialise the window; elsewhere we just drop stale params.
    if (owns) {
      if (range) {
        next.set('from', toDayParam(range.from));
        next.set('to', toDayParam(range.to));
      } else if (days !== 30) {
        next.set('p', days === 0 ? 'all' : `${days}d`);
      }
    }
    // Only navigate when something actually changed — otherwise the effect would loop.
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [days, range, owns, params, setParams]);

  return null;
}
