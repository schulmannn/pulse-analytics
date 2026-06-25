import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The new app is served by Express under /app (strangler-fig migration), so `base`
// must match that mount path — built asset URLs resolve to /app/assets/*.
export default defineConfig({
  base: '/app/',
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
