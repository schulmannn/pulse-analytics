import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import { redirectBrowserOnUnauthorized } from '@/lib/authRedirect';
import { purgeLegacySession } from '@/lib/session';
import { ThemeProvider } from '@/lib/theme';
import { installGlobalErrorReporter } from '@/lib/crashReporting';
import '@/index.css';

// Client-cache defaults: dedupe in-flight requests, serve stale-then-revalidate, and
// DON'T refetch on window focus — the legacy dashboard re-hammered a rate-limited API on
// every focus/timeframe flip, which is exactly the class of bug TanStack Query removes.
function handleUnauthorized(error: unknown): void {
  redirectBrowserOnUnauthorized(error);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // Central cookie-auth policy: any protected request that returns 401 lands on
    // /login. The HttpOnly session is cleared server-side when invalid/revoked.
    onError: handleUnauthorized,
  }),
  // Mutations use a separate TanStack cache; without this mirror, a 401 from settings/connect/
  // logout would stay inside the stale protected shell while query 401s redirected correctly.
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Never retry client-side failures (4xx, schema drift) — a 401/404 won't heal on
      // retry. Keep one retry for 5xx/network flake; network failures are ApiError with
      // .network (human message), so the flag — not the status — keeps their retry.
      retry: (failureCount, error) =>
        !(
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          (error as { network?: unknown }).network !== true &&
          typeof (error as { status?: unknown }).status === 'number' &&
          (error as { status: number }).status < 500
        ) && failureCount < 1,
    },
  },
});

// Arm the window-level crash net (uncaught errors + unhandled promise rejections) before the first
// render, so a throw anywhere — even outside React's render tree — reaches telemetry, not just the
// console. React error boundaries only catch throws during render; this covers the rest.
installGlobalErrorReporter();

function bootstrap(): void {
  // Мост до-cookie-сессии снят (его срок истёк в июле): осталась синхронная уборка ключей из
  // localStorage — ждать её нечего, сети она не трогает.
  purgeLegacySession();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter basename="/">
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

bootstrap();
