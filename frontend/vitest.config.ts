import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // e2e/ holds Playwright specs (run via `npm run test:e2e`), not vitest — keep them out of the
    // unit run so vitest doesn't try to execute @playwright/test files.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
