import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type PeriodDays = 7 | 30 | 90 | 0;

/** Inclusive custom date window (epoch ms). When set, it overrides the `days` preset. */
export interface DateRange {
  from: number;
  to: number;
}

interface PeriodContextValue {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
  range: DateRange | null;
  setRange: (range: DateRange | null) => void;
  /** True if a date is inside the active window (custom range if set, else the `days` preset). */
  inRange: (dateISO: string | null | undefined) => boolean;
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [days, setDaysState] = useState<PeriodDays>(30);
  const [range, setRangeState] = useState<DateRange | null>(null);

  // Picking a preset clears any custom range; picking a range leaves `days` as the fallback.
  const setDays = useCallback((next: PeriodDays) => {
    setRangeState(null);
    setDaysState(next);
  }, []);
  const setRange = useCallback((next: DateRange | null) => {
    setRangeState(next);
  }, []);

  const inRange = useCallback(
    (dateISO: string | null | undefined): boolean => {
      if (range) {
        if (!dateISO) return false;
        const t = Date.parse(dateISO);
        return Number.isFinite(t) && t >= range.from && t <= range.to;
      }
      return inRangeByDays(dateISO, days);
    },
    [range, days],
  );

  const value = useMemo(
    () => ({ days, setDays, range, setRange, inRange }),
    [days, setDays, range, setRange, inRange],
  );

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodContextValue {
  const value = useContext(PeriodContext);
  if (!value) throw new Error('usePeriod must be used within PeriodProvider');
  return value;
}

export function tgLimit(days: PeriodDays): number {
  if (days !== 0 && days <= 7) return 30;
  if (days !== 0 && days <= 30) return 60;
  return 100;
}

/** Fetch limit accounting for a custom range (max posts so any window has enough data). */
export function effectiveLimit(days: PeriodDays, range: DateRange | null): number {
  return range ? 100 : tgLimit(days);
}

export function inRangeByDays(dateISO: string | null | undefined, days: PeriodDays): boolean {
  if (days === 0) return true;
  if (!dateISO) return false;
  const timestamp = Date.parse(dateISO);
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}
