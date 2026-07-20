import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 3F-3 catover: the new app is now the primary dashboard served at '/', so `base` is
// root — built asset URLs resolve to /assets/*. (Was '/app/' during the strangler-fig
// phase.) The legacy shell stays reachable at /legacy until the B2 cleanup.
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunk (framework + data layer) separate from app code: it changes
        // only on dependency bumps, so returning users keep it cached across app deploys.
        // framer-motion is deliberately NOT listed — only the lazy-loaded Landing imports
        // it, so Rollup places it in the Landing async chunk (never in the entry).
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor';
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return 'vendor';
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return 'vendor';
          // shadcn primitives are copied into the app, while their accessible interaction runtime
          // comes from Radix. Keep that stable runtime out of the frequently-changing app entry;
          // menus, dialogs, selects and tooltips can share one long-lived browser cache.
          if (
            /[\\/]node_modules[\\/](@radix-ui|@floating-ui|lucide-react|class-variance-authority|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar)[\\/]/.test(
              id,
            )
          ) {
            return 'ui-vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    // Dev only: proxy API calls to the local Express server (run `npm run dev` in repo root).
    proxy: { '/api': 'http://localhost:3000' },
  },
});
