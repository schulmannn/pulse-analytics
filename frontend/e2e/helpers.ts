import type { Page } from '@playwright/test';

// The only authenticated endpoint demo fixtures do NOT cover — stub it so the authed shell renders
// offline. Shape matches MeSchema (all fields optional + passthrough), so this parses fine.
const DEMO_ME = { uid: 999, email: 'demo@pulse.local', role: 'user', avatar: null };

/**
 * Boot the app straight into the authenticated DEMO dashboard: stub /api/auth/me and set the demo
 * flag before load, so the whole Telegram dashboard renders from deterministic client-side fixtures —
 * no backend, no real credentials. Waits for the shell + first widget card, then a short settle so
 * ResizeObserver-driven chart heights are final before we measure them.
 * `opts.theme` pins the pulse_theme preference before load (default: system → the Playwright
 * environment's light) — the contrast gate scans both palettes explicitly.
 */
export async function bootDemo(page: Page, route = '/', opts: { theme?: 'light' | 'dark' } = {}): Promise<void> {
  // Covered demo endpoints resolve inside api/client.ts and never reach the network. Any uncovered
  // optional request (IG/media today, future integrations tomorrow) gets a deterministic response
  // instead of leaking through Vite's proxy to a missing local backend and filling CI with ECONNREFUSED.
  await page.route(/^https?:\/\/[^/]+\/api\//, (r) => {
    const isMe = new URL(r.request().url()).pathname === '/api/auth/me';
    return r.fulfill({
      status: isMe ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(isMe ? DEMO_ME : { error: 'not_available_in_demo' }),
    });
  });
  await page.addInitScript(
    (theme) => {
      localStorage.setItem('pulse_demo', '1');
      localStorage.setItem('pulse_channel', '0');
      if (theme) localStorage.setItem('pulse_theme', theme);
    },
    opts.theme ?? '',
  );
  await page.goto(route);
  // Wait for the authed shell (present on every route incl. an empty /home), then settle so
  // ResizeObserver-driven chart heights are final before any measurement.
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1200);
}

/**
 * Every card body (or any residual scroll container) that overflows its tile — the exact "no inner
 * scrollbars" invariant. Returns [] when clean; each entry names the widget for triage.
 */
export function overflowingCards(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('div.overflow-hidden, div.overflow-y-auto, div.overflow-auto')]
      .filter((el) => el.scrollHeight > el.clientHeight + 1)
      .map((el) => ({
        widget: (el.closest('section')?.querySelector('h3')?.textContent || '(unnamed)').trim(),
        over: el.scrollHeight - el.clientHeight,
      })),
  );
}
