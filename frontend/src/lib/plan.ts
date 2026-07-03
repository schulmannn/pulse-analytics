import { useSyncExternalStore } from 'react';

/**
 * Client-side subscription plan flag (`pulse_plan`). Billing is UI-preview only for now —
 * no payments, no server enforcement: picking a plan flips this local flag so plan-gated
 * SURFACES (e.g. team members) can render, while access to data stays unchanged.
 */
export type PlanId = 'free' | 'pro' | 'max';

export const PLAN_LABEL: Record<PlanId, string> = { free: 'Free', pro: 'Pro', max: 'Max' };

const KEY = 'pulse_plan';
const listeners = new Set<() => void>();

export function getPlan(): PlanId {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'pro' || v === 'max') return v;
  } catch {
    /* storage blocked — default plan */
  }
  return 'free';
}

export function setPlan(plan: PlanId) {
  try {
    if (plan === 'free') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, plan);
  } catch {
    /* storage blocked — the picker is a nicety */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function usePlan(): PlanId {
  return useSyncExternalStore(subscribe, getPlan, () => 'free' as const);
}

/** Paid plans unlock plan-gated UI (team members etc.). */
export function isPaidPlan(plan: PlanId): boolean {
  return plan !== 'free';
}
