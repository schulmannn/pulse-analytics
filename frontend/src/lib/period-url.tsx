import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePeriod } from '@/lib/period';

/** Local-date YYYY-MM-DD for a timestamp (URL serialisation of a range endpoint). */
function toDayParam(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * One-way state→URL sync for the active period (renders nothing). The URL is written with
 * `replace` (no history spam; Back keeps navigating routes, not period flips):
 * - rolling preset ≠ default → ?p=7d|90d|all (the default 30д keeps the URL clean)
 * - shifted/custom window   → ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * The READ side is PeriodProvider's initializer (lib/period), so a shared link restores
 * the window on load. Unrelated params (?tab, ?ig…) are preserved. Mounted in the
 * protected shell only — auth/landing URLs stay clean.
 */
export function PeriodUrlSync() {
  const { days, range } = usePeriod();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    const next = new URLSearchParams(params);
    next.delete('p');
    next.delete('from');
    next.delete('to');
    if (range) {
      next.set('from', toDayParam(range.from));
      next.set('to', toDayParam(range.to));
    } else if (days !== 30) {
      next.set('p', days === 0 ? 'all' : `${days}d`);
    }
    // Only navigate when something actually changed — otherwise the effect would loop.
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [days, range, params, setParams]);

  return null;
}
