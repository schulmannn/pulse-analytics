import { defineConfig, devices } from '@playwright/test';

/**
 * Visual / regression-gate e2e. Runs the app in DEMO MODE (client-side deterministic fixtures, no
 * backend/Postgres — see e2e/helpers.ts) across four breakpoints, asserting the invariants recent
 * work established: no inner scrollbars in dashboard tiles, no horizontal page scroll, no runaway
 * card heights; plus detail open/back and edit-mode entry/exit. Screenshots are attached per route ×
 * viewport for visual review (no pixel-diff baseline — demo dates are relative to now, so a strict
 * snapshot would be non-deterministic).
 */
const VIEWPORTS = [
  { name: 'mobile-430', width: 430, height: 932 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mid-900', width: 900, height: 1400 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

// Порт параметризован: с reuseExistingServer чужой vite на дефолтном 5173 (другой worktree
// этого же репо) молча подсовывает e2e СТАРЫЙ код. E2E_PORT=5174 изолирует прогон.
const PORT = process.env.E2E_PORT || '5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'line',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: VIEWPORTS.map((v) => ({
    name: v.name,
    use: { ...devices['Desktop Chrome'], viewport: { width: v.width, height: v.height } },
  })),
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
