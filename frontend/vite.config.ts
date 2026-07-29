import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// 3F-3 catover: the new app is now the primary dashboard served at '/', so `base` is
// root — built asset URLs resolve to /assets/*. (Was '/app/' during the strangler-fig
// phase.) The legacy shell stays reachable at /legacy until the B2 cleanup.
export default defineConfig({
  base: '/',
  // Tailwind v4 через first-party Vite-плагин (быстрее PostCSS-пути; postcss.config.js удалён).
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Machine-readable chunk graph for route-level bundle budgets. It is emitted under
    // dist/.vite/manifest.json and never requested by browsers.
    manifest: true,
    rollupOptions: {
      output: {
        // Stable vendor chunk (framework + data layer) separate from app code: it changes
        // only on dependency bumps, so returning users keep it cached across app deploys.
        // The public landing uses native CSS/Web APIs for motion; no animation runtime belongs in
        // this framework/data vendor boundary.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor';
          }
          // react-virtual — нишевая виртуализация длинных таблиц (сегодня только МС-маршрут):
          // в shell-vendor не тащим, пусть живёт в lazy-чанках потребителей.
          if (/[\\/]node_modules[\\/]@tanstack[\\/](react-virtual|virtual-core)[\\/]/.test(id)) return undefined;
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return 'vendor';
          // Validation belongs to API route chunks; public boot/auth probing uses a tiny shape
          // guard and must not preload all of Zod before it knows which route graph is needed.
          if (/[\\/]node_modules[\\/]zod[\\/]/.test(id)) return 'schema-vendor';
          // Do not force every Radix primitive into one manual chunk. That aggregate developed a
          // React/runtime edge and became an eager ~44 KB gzip preload even on public pages that
          // render no dialog/menu at all. Rollup now extracts only UI code genuinely shared by the
          // lazy route that needs it; framework/data caching remains stable in `vendor`.
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
