// Demo mode — a client-side flag that makes the API layer serve bundled sample data instead of
// hitting the server, so a brand-new user can explore a fully-populated dashboard without
// connecting anything. Read synchronously by the API client (api/client.ts); toggled through the
// DemoProvider (lib/demo-context) which also clears the query cache + navigates.

const DEMO_KEY = 'pulse_demo';

// Synthetic channel id for the demo workspace. Real channel ids are SERIAL ≥ 1, so 0 never
// collides; it's also falsy server-side, so any request that does reach the backend during demo
// is treated as "no channel" (→ mock / env), never another tenant's data.
export const DEMO_CHANNEL_ID = 0;

export function isDemoMode(): boolean {
  try {
    return localStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEMO_KEY, '1');
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    /* localStorage unavailable — demo just won't persist across reloads */
  }
}
