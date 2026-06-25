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
  server: {
    port: 5173,
    // Dev only: proxy API calls to the local Express server (run `npm run dev` in repo root).
    proxy: { '/api': 'http://localhost:3000' },
  },
});
