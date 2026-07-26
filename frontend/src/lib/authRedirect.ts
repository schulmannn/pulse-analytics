import { isDemoMode } from '@/lib/demo';

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === status
  );
}

/** Raw AuthGate owns the public probe, so every TanStack 401 belongs to protected work. */
export function shouldRedirectOnUnauthorized(
  error: unknown,
  pathname: string,
  demoMode: boolean,
): boolean {
  if (!hasStatus(error, 401) || demoMode) return false;
  if (pathname === '/login') return false;
  return true;
}

interface BrowserUnauthorizedDeps {
  pathname: string;
  demoMode: boolean;
  assign: (path: string) => void;
}

/**
 * Shared boundary for direct fetches and TanStack caches. Dependency injection keeps the policy
 * unit-testable without jsdom while production callers use the real browser state.
 */
export function redirectBrowserOnUnauthorized(
  error: unknown,
  deps: BrowserUnauthorizedDeps = {
    pathname: window.location.pathname,
    demoMode: isDemoMode(),
    assign: (path) => window.location.assign(path),
  },
): boolean {
  if (!shouldRedirectOnUnauthorized(error, deps.pathname, deps.demoMode)) return false;
  deps.assign('/login');
  return true;
}
