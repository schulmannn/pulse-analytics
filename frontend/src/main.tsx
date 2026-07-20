import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import { ApiError } from '@/api/client';
import { ChannelProvider } from '@/lib/channel-context';
import { DemoProvider } from '@/lib/demo-context';
import { isDemoMode } from '@/lib/demo';
import { PeriodProvider } from '@/lib/period';
import { clearSessionToken, getSessionToken } from '@/lib/session';
import { ThemeProvider } from '@/lib/theme';
import { installGlobalErrorReporter } from '@/lib/crashReporting';
import '@fontsource-variable/geist';
import '@/index.css';

// Client-cache defaults: dedupe in-flight requests, serve stale-then-revalidate, and
// DON'T refetch on window focus — the legacy dashboard re-hammered a rate-limited API on
// every focus/timeframe flip, which is exactly the class of bug TanStack Query removes.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // Central 401 policy: an expired/invalidated session (token present, server says 401)
    // clears the stored session and lands on /login. Guards: no token → this is the normal
    // logged-out flow (the login gate handles it, no redirect loop since we just cleared
    // the token); demo mode → fixtures don't auth; already on /login → nothing to do.
    onError: (error) => {
      if (!(error instanceof ApiError) || error.status !== 401) return;
      if (isDemoMode() || !getSessionToken()) return;
      clearSessionToken();
      if (window.location.pathname !== '/login') window.location.assign('/login');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Never retry client-side failures (4xx, schema drift) — a 401/404 won't heal on
      // retry. Keep one retry for 5xx/network flake.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 1,
    },
  },
});

// Arm the window-level crash net (uncaught errors + unhandled promise rejections) before the first
// render, so a throw anywhere — even outside React's render tree — reaches telemetry, not just the
// console. React error boundaries only catch throws during render; this covers the rest.
installGlobalErrorReporter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ChannelProvider>
        <ThemeProvider>
          <PeriodProvider>
            <BrowserRouter basename="/">
              <DemoProvider>
                <App />
              </DemoProvider>
            </BrowserRouter>
          </PeriodProvider>
        </ThemeProvider>
      </ChannelProvider>
    </QueryClientProvider>
  </StrictMode>,
);
