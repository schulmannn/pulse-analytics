import { useSyncExternalStore } from 'react';
import type { PlanId } from '@/lib/plan';

/**
 * Client-side team roster (`pulse_team`) — the members UI is a plan-gated PREVIEW: invites
 * live in localStorage, no email is sent, no server access is granted. The owner (current
 * account) is implicit and never stored; the roster holds invited members only.
 */
export type TeamRole = 'editor' | 'viewer';

export interface TeamMember {
  email: string;
  role: TeamRole;
}

export const ROLE_LABEL: Record<TeamRole, string> = {
  editor: 'Редактор',
  viewer: 'Наблюдатель',
};

/** Invited-member cap per plan (owner not counted). Free has no team surface at all. */
export const TEAM_LIMIT: Record<PlanId, number> = { free: 0, pro: 3, max: 10 };

const KEY = 'pulse_team';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const isMember = (x: unknown): x is TeamMember =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as TeamMember).email === 'string' &&
  ((x as TeamMember).role === 'editor' || (x as TeamMember).role === 'viewer');

// Cache the parsed roster by raw string so useSyncExternalStore gets a STABLE snapshot
// (a fresh array every getTeam() would loop the store).
let cacheRaw: string | null = null;
let cacheVal: TeamMember[] = [];

export function getTeam(): TeamMember[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  if (raw === cacheRaw) return cacheVal;
  let parsed: TeamMember[] = [];
  try {
    const val: unknown = JSON.parse(raw ?? 'null');
    if (Array.isArray(val)) parsed = val.filter(isMember);
  } catch {
    /* garbage in storage — empty roster */
  }
  cacheRaw = raw;
  cacheVal = parsed;
  return parsed;
}

function saveTeam(team: TeamMember[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(team));
  } catch {
    /* storage blocked — the roster is a nicety */
  }
  notify();
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

/** Add an invite. Returns an error string (already present / invalid) or null on success. */
export function addMember(email: string, role: TeamRole): string | null {
  const norm = normalizeEmail(email);
  if (!isValidEmail(norm)) return 'Похоже, это не email';
  if (getTeam().some((m) => m.email === norm)) return 'Уже в списке';
  saveTeam([...getTeam(), { email: norm, role }]);
  return null;
}

export function removeMember(email: string) {
  saveTeam(getTeam().filter((m) => m.email !== email));
}

export function setMemberRole(email: string, role: TeamRole) {
  saveTeam(getTeam().map((m) => (m.email === email ? { ...m, role } : m)));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useTeam(): TeamMember[] {
  return useSyncExternalStore(subscribe, getTeam, () => cacheVal);
}
