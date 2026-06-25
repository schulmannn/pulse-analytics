import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export type PeriodDays = 7 | 30 | 90 | 365 | 0;

interface PeriodContextValue {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<PeriodDays>(30);

  return <PeriodContext.Provider value={{ days, setDays }}>{children}</PeriodContext.Provider>;
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

export function inRangeByDays(dateISO: string | null | undefined, days: PeriodDays): boolean {
  if (days === 0) return true;
  if (!dateISO) return false;
  const timestamp = Date.parse(dateISO);
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}
