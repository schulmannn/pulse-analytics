import type { Locator, Page } from '@playwright/test';

// The only authenticated endpoint demo fixtures do NOT cover — stub it so the authed shell renders
// offline. Shape matches MeSchema (all fields optional + passthrough), so this parses fine.
const DEMO_ME = { uid: 999, email: 'demo@pulse.local', role: 'user', avatar: null };
const DAY_MS = 86_400_000;

const igDays = Array.from({ length: 60 }, (_, index) =>
  new Date(Date.now() - (59 - index) * DAY_MS).toISOString(),
);

function igMetric(name: string, valueAt: (index: number) => number) {
  return {
    name,
    period: 'day',
    values: igDays.map((end_time, index) => ({ end_time, value: valueAt(index) })),
  };
}

function demoIgPayload(path: string): unknown | undefined {
  if (path === '/api/ig/profile') {
    return { mock: true, username: 'demo_channel', name: 'Demo Instagram', followers_count: 12_840, synced_at: Date.now() };
  }
  if (path === '/api/ig/insights') {
    const wave = (index: number, size: number) => ((index % 7) - 3) * size;
    return {
      mock: true,
      data: [
        igMetric('reach', (i) => 2_900 + i * 18 + wave(i, 85)),
        igMetric('views', (i) => 4_800 + i * 24 + wave(i, 120)),
        igMetric('total_interactions', (i) => 250 + i * 2 + wave(i, 8)),
        igMetric('likes', (i) => 172 + i + wave(i, 5)),
        igMetric('saves', (i) => 36 + Math.floor(i / 5) + wave(i, 1)),
        igMetric('comments', (i) => 18 + Math.floor(i / 8) + Math.abs(wave(i, 1))),
        igMetric('shares', (i) => 24 + Math.floor(i / 6) + Math.abs(wave(i, 1))),
        igMetric('follows', (i) => 27 + Math.floor(i / 10) + Math.abs(wave(i, 1))),
        igMetric('unfollows', (i) => 11 + Math.abs(wave(i, 1))),
        igMetric('follower_count', (i) => 12_300 + i * 9),
      ],
    };
  }
  if (path === '/api/ig/posts') {
    return {
      mock: true,
      data: Array.from({ length: 8 }, (_, index) => ({
        id: `demo-ig-${index + 1}`,
        timestamp: new Date(Date.now() - (index + 1) * DAY_MS).toISOString(),
        media_type: index % 3 === 0 ? 'VIDEO' : 'IMAGE',
        media_product_type: index % 3 === 0 ? 'REELS' : 'FEED',
        reach: 4_900 - index * 280,
        views: 7_200 - index * 310,
        like_count: 260 - index * 14,
        comments_count: 31 - index,
        saved: 58 - index * 3,
        shares: 37 - index * 2,
        total_interactions: 386 - index * 20,
        caption: `Demo publication ${index + 1}`,
      })),
    };
  }
  if (path === '/api/ig/breakdowns') return { mock: true, data: [] };
  if (path === '/api/ig/online') return { mock: true, data: [] };
  if (path === '/api/ig/stories') return { mock: true, data: [] };
  if (path === '/api/ig/tags') return { mock: true, data: [] };
  if (path === '/api/ig/oauth/status') return { connected: true, server_ready: true, env_fallback: false };
  return undefined;
}

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
    const path = new URL(r.request().url()).pathname;
    const isMe = path === '/api/auth/me';
    const igPayload = demoIgPayload(path);
    return r.fulfill({
      status: isMe || igPayload !== undefined ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(isMe ? DEMO_ME : igPayload ?? { error: 'not_available_in_demo' }),
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

/** A card that owns the generic ?detail= overlay rather than drilling to a dedicated metric page. */
export function detailOverlayOpener(page: Page): Locator {
  return page.getByRole('button', { name: 'Развернуть виджет «Лучшие публикации»' });
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
