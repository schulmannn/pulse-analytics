// Demo mode — a client-side flag that makes the API layer serve bundled sample data instead of
// hitting the server, so a brand-new user can explore a fully-populated dashboard without
// connecting anything. Read synchronously by the API client (api/client.ts); toggled through the
// DemoProvider (lib/demo-context) which also clears the query cache + navigates.

const DEMO_KEY = 'pulse_demo';
const CHANNEL_KEY = 'pulse_channel';
export const DEMO_MODE_CHANGE_EVENT = 'pulse:demo-mode-change';
// Same-tab source of truth when storage is blocked (privacy mode / sandboxed iframe). Undefined
// means "no local decision yet" and still allows a persisted flag to be read on first boot.
let memoryDemoFlag: boolean | undefined;

// Synthetic channel id for the demo workspace. Real channel ids are SERIAL ≥ 1, so 0 never
// collides; it's also falsy server-side, so any request that does reach the backend during demo
// is treated as "no channel" (→ mock / env), never another tenant's data.
export const DEMO_CHANNEL_ID = 0;

export function isDemoMode(): boolean {
  if (memoryDemoFlag !== undefined) return memoryDemoFlag;
  try {
    return localStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoFlag(on: boolean): void {
  memoryDemoFlag = on;
  try {
    if (on) localStorage.setItem(DEMO_KEY, '1');
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    /* localStorage unavailable — demo just won't persist across reloads */
  }
}

function announceDemoChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(DEMO_MODE_CHANGE_EVENT));
  }
}

/**
 * Public demo entry runs before ChannelProvider exists. Persist the synthetic source first so the
 * protected graph reads channel 0 on its very first render, then notify AuthGate to swap graphs.
 */
export function enableDemoMode(): void {
  try {
    localStorage.setItem(CHANNEL_KEY, String(DEMO_CHANNEL_ID));
  } catch {
    /* localStorage unavailable — the provider will still attempt its in-memory fallback */
  }
  setDemoFlag(true);
  announceDemoChange();
}

/** Leave the demo graph and make AuthGate perform a real session probe again. */
export function disableDemoMode(): void {
  setDemoFlag(false);
  announceDemoChange();
}
