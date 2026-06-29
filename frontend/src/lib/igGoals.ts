// Per-browser Instagram goals (localStorage-backed; no backend). The user sets targets for
// followers / ER / period reach and the panel renders progress bars. goalPct is pure/tested.

export interface IgGoals {
  followers: number;
  er: number;
  reach: number;
}

// Scoped per IG account (single env account today; ready for multi-account later).
const storeKey = (accountKey?: string) => `pulse_ig_goals:${accountKey || 'default'}`;

export function loadIgGoals(defaults: IgGoals, accountKey?: string): IgGoals {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storeKey(accountKey)) : null;
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<IgGoals>;
    return {
      followers: Number(parsed.followers) || defaults.followers,
      er: Number(parsed.er) || defaults.er,
      reach: Number(parsed.reach) || defaults.reach,
    };
  } catch {
    return defaults;
  }
}

export function saveIgGoals(goals: IgGoals, accountKey?: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(storeKey(accountKey), JSON.stringify(goals));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/** Progress toward a target, clamped to 0–100. Non-positive/invalid target → 0. */
export function goalPct(current: number, target: number): number {
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.min(100, (current / target) * 100));
}
