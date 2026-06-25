import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import '@/index.css';

// Client-cache defaults: dedupe in-flight requests, serve stale-then-revalidate, and
// DON'T refetch on window focus — the legacy dashboard re-hammered a rate-limited API on
// every focus/timeframe flip, which is exactly the class of bug TanStack Query removes.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
