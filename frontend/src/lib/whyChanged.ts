// "Why changed" — a deterministic, source-neutral driver summary over a daily FLOW series
// (views / reach / forwards…). It answers "what moved between this period and the previous one"
// with EVIDENCE, not causation: every driver is a measured observation ("this one day carried 38%
// of the drop"), never an invented cause ("the algorithm changed"). The Comparison tab and the
// Overview "what changed / why" block render these drivers; the prose narrative engine
// (lib/narrative) stays the weekly-digest voice — this is the structured, generic counterpart.
//
// Honesty gates mirror the rest of the codebase: two equal windows must both hold data, and a
// change below MIN_MEANINGFUL_PCT is reported as "flat" with no drivers rather than dressed up.

import { fmt } from './format';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Below this |percent| the period is "flat": we emit no drivers rather than narrate noise. */
export const MIN_MEANINGFUL_PCT = 3;

/** A single day must carry at least this share of the total change to be called out on its own. */
const PEAK_MIN_SHARE = 0.25;

/** Difference in silent (zero-activity) days between windows before it is worth surfacing. */
const QUIET_MIN_DELTA = 2;

export type ChangeDirection = 'up' | 'down' | 'flat';

/**
 * Every driver is one of: `peak-day` (a single dominant day present in one window, absent in the
 * other), `quiet-days` (more/fewer days with no activity), or `broad-shift` (the move is spread
 * across the window with no single dominant day). `certainty` is deliberately limited to
 * `observed` — we only ever state what the numbers show. `share` is this driver's fraction of the
 * absolute change (0..1) when cleanly computable.
 */
export interface ChangeDriver {
  kind: 'peak-day' | 'quiet-days' | 'broad-shift';
  certainty: 'observed';
  share?: number;
  /** Signed contribution in metric units when a clean attribution exists. */
  contribution?: number;
  detail: Record<string, number | string>;
}

export interface WhyChanged {
  direction: ChangeDirection;
  /** Signed percent change vs the previous window; null when the previous window summed to 0. */
  pct: number | null;
  current: number;
  previous: number;
  drivers: ChangeDriver[];
  /** True when the windows are too sparse to compare — caller shows an insufficient-data state. */
  insufficient: boolean;
}

interface WindowStats {
  points: { day: string; v: number }[];
  sum: number;
  silent: number;
  peak: { day: string; v: number } | null;
  maxV: number;
}

function windowStats(points: { day: string; v: number }[]): WindowStats {
  let sum = 0;
  let silent = 0;
  let peak: { day: string; v: number } | null = null;
  for (const p of points) {
    sum += p.v;
    if (p.v === 0) silent += 1;
    if (!peak || p.v > peak.v) peak = p;
  }
  return { points, sum, silent, peak, maxV: peak ? peak.v : 0 };
}

/** UTC calendar day-key (YYYY-MM-DD) for a timestamp — ISO date strings sort chronologically. */
const utcDayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/**
 * Fill every UTC day of a window with an explicit 0 so a channel that does not post daily still
 * gets honest quiet-day and coverage accounting (the sparse callers only emit rows for days that
 * had a post). Days that precede `dataStartKey` — the first day the collector ever saw — are left
 * out: they are UNKNOWN history, not silent, and must never be fabricated as zero.
 */
function fillWindow(map: Map<string, number>, windowStart: number, days: number, dataStartKey: string): void {
  for (let i = 0; i < days; i += 1) {
    const key = utcDayKey(windowStart + i * DAY_MS);
    if (key < dataStartKey) continue;
    if (!map.has(key)) map.set(key, 0);
  }
}

const mapToPoints = (map: Map<string, number>): { day: string; v: number }[] =>
  [...map.entries()].map(([day, v]) => ({ day, v }));

const sumPoints = (points: { day: string; v: number }[]): number =>
  points.reduce((a, b) => a + b.v, 0);

/**
 * Explain the change in a daily flow series between the current window [now−days, now] and the
 * previous window [now−2·days, now−days]. `series` is any set of {day, v} rows (ISO day, daily
 * increment) — order-independent. Returns structured drivers sorted by share desc.
 *
 * Insufficient when: days<3, either window empty, or fewer than half of each window's days carry a
 * data point (a channel that only posted twice can't have its swing "explained").
 */
export function explainChange(
  series: { day: string; v: number }[],
  days: number,
  now = Date.now(),
): WhyChanged {
  const insufficientResult = (current = 0, previous = 0): WhyChanged => ({
    direction: 'flat',
    pct: null,
    current,
    previous,
    drivers: [],
    insufficient: true,
  });

  if (!Number.isFinite(days) || days < 3) return insufficientResult();

  const currentStart = now - days * DAY_MS;
  const previousStart = now - days * 2 * DAY_MS;

  // Bucket the sparse rows into their window by UTC day, and track archive coverage (`dataStartKey`
  // = the earliest day any data exists for) so filling never invents quiet days before the channel
  // was collected. Same-day rows are summed so an album/multi-post day is one bucket.
  const curMap = new Map<string, number>();
  const prevMap = new Map<string, number>();
  let dataStartKey: string | null = null;
  for (const row of series) {
    const ts = Date.parse(row.day);
    if (!Number.isFinite(ts) || ts > now) continue;
    const v = Number(row.v);
    if (!Number.isFinite(v)) continue;
    const key = utcDayKey(ts);
    if (dataStartKey === null || key < dataStartKey) dataStartKey = key;
    if (ts >= currentStart) curMap.set(key, (curMap.get(key) ?? 0) + v);
    else if (ts >= previousStart) prevMap.set(key, (prevMap.get(key) ?? 0) + v);
  }

  if (dataStartKey === null) return insufficientResult();

  fillWindow(curMap, currentStart, days, dataStartKey);
  fillWindow(prevMap, previousStart, days, dataStartKey);

  const curPoints = mapToPoints(curMap);
  const prevPoints = mapToPoints(prevMap);

  // Coverage now counts KNOWN days (real posts + filled quiet days), so a channel that posts
  // twice a week is analysable — only a window mostly predating the archive stays insufficient.
  const minCoverage = Math.max(2, Math.floor(days / 2));
  if (curPoints.length < minCoverage || prevPoints.length < minCoverage) {
    return insufficientResult(sumPoints(curPoints), sumPoints(prevPoints));
  }

  const c = windowStats(curPoints);
  const p = windowStats(prevPoints);
  const change = c.sum - p.sum;
  const absChange = Math.abs(change);
  const pct = p.sum > 0 ? (change / p.sum) * 100 : null;
  const direction: ChangeDirection =
    pct != null && Math.abs(pct) < MIN_MEANINGFUL_PCT
      ? 'flat'
      : change > 0
        ? 'up'
        : change < 0
          ? 'down'
          : 'flat';

  const drivers: ChangeDriver[] = [];
  if (direction !== 'flat' && absChange > 0) {
    // Peak-day: the dominant day of the LARGER window, unmatched by the smaller window's max.
    // Down → a previous peak that didn't recur; up → a new spike with no prior equal.
    const [rich, lean] = change < 0 ? [p, c] : [c, p];
    if (rich.peak && rich.peak.v > lean.maxV) {
      const contribution = rich.peak.v - lean.maxV;
      const share = Math.min(1, contribution / absChange);
      if (share >= PEAK_MIN_SHARE) {
        drivers.push({
          kind: 'peak-day',
          certainty: 'observed',
          share,
          contribution: change < 0 ? -contribution : contribution,
          detail: { day: rich.peak.day, value: rich.peak.v, sharePct: Math.round(share * 100) },
        });
      }
    }

    // Quiet-days: a shift in how many days had zero activity. An observation about cadence,
    // deliberately without a unit contribution (silence has no single value to attribute).
    const silentDelta = c.silent - p.silent;
    if (Math.abs(silentDelta) >= QUIET_MIN_DELTA) {
      drivers.push({
        kind: 'quiet-days',
        certainty: 'observed',
        detail: { current: c.silent, previous: p.silent, delta: silentDelta },
      });
    }

    // Broad-shift: nothing dominant explained it — the move is spread across the window.
    if (!drivers.some((d) => d.kind === 'peak-day')) {
      drivers.push({
        kind: 'broad-shift',
        certainty: 'observed',
        detail: {
          currentDays: c.points.length,
          previousDays: p.points.length,
        },
      });
    }
  }

  drivers.sort((a, b) => (b.share ?? 0) - (a.share ?? 0));

  return { direction, pct, current: c.sum, previous: p.sum, drivers, insufficient: false };
}

export interface ChangeDescription {
  /** One-line headline: metric, direction, magnitude. Empty pct → magnitude omitted honestly. */
  headline: string;
  /** Human evidence lines — observations, never asserted causes. Empty when flat/insufficient. */
  evidence: string[];
  /** Standing caveat that frames the evidence as observations, not established causation. */
  caveat: string | null;
}

// Unsigned magnitude: the direction is already carried by the noun ("рост"/"снижение"), so a signed
// "+42%" after "на" reads awkwardly ("рост на +42%") and would double the sign. One decimal below
// 10% (a 3% move deserves precision), whole percent above.
const magPct = (pct: number): string => {
  const a = Math.abs(pct);
  return `${a < 10 ? a.toFixed(1) : Math.round(a)}%`;
};

/**
 * Presentation layer for {@link explainChange}: turns the structured drivers into honest Russian
 * copy the Comparison/Overview "почему изменилось" block renders. Deliberately uses OBSERVATION
 * language ("основной вклад", "судя по данным") and a standing caveat — it never claims a cause the
 * data can't prove. `metricLabel` is the caller's series name ("Просмотры", "Охват").
 */
export function describeChange(result: WhyChanged, metricLabel: string): ChangeDescription {
  if (result.insufficient) {
    return {
      headline: `${metricLabel}: недостаточно данных для сравнения периодов`,
      evidence: [],
      caveat: null,
    };
  }
  if (result.direction === 'flat') {
    return {
      headline: `${metricLabel} без заметных изменений к прошлому периоду`,
      evidence: [],
      caveat: null,
    };
  }

  // Noun phrasing ("Просмотры: рост на 42% …") avoids subject-verb agreement bugs — a verb would
  // need "вырос"/"выросли"/"вырос" to match the metric noun's gender/number, which the caller's
  // label doesn't carry. Nouns stay correct for "Просмотры", "Охват", "Реакции" alike.
  const dirNoun = result.direction === 'up' ? 'рост' : 'снижение';
  const mag = result.pct != null ? ` на ${magPct(result.pct)}` : '';
  const headline = `${metricLabel}: ${dirNoun}${mag} к прошлому периоду`;

  const evidence: string[] = [];
  for (const d of result.drivers) {
    if (d.kind === 'peak-day') {
      const day = fmt.day(String(d.detail.day));
      const sharePct = Number(d.detail.sharePct);
      evidence.push(
        `Основной вклад в сдвиг — один день, ${day}: около ${sharePct}% разницы (${fmt.short(Number(d.detail.value))}).`,
      );
    } else if (d.kind === 'quiet-days') {
      evidence.push(
        `Дней без публикаций: ${d.detail.current} против ${d.detail.previous} в прошлом периоде.`,
      );
    } else if (d.kind === 'broad-shift') {
      evidence.push('Сдвиг распределён по периоду — единственного дня-драйвера нет.');
    }
  }

  return {
    headline,
    evidence,
    caveat: evidence.length ? 'Это наблюдения по данным, а не установленные причины.' : null,
  };
}
