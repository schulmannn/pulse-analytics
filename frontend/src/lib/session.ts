const TOKEN_KEY = 'pulse_token';
const TOKEN_EXP = 'pulse_token_exp';
// Mirrors the server's SESSION_TTL (index.js). The server slides it forward on activity via the
// X-Session-Refresh response header (see api/client.ts); this is the idle window, not a hard cap.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read the legacy session token from localStorage. The new app is served same-origin as
 * the legacy dashboard ('/'), so it shares localStorage — a user logged in at '/' is
 * already authenticated here. Mirrors the legacy getToken(): null if missing or expired.
 */
export function getSessionToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    const exp = parseInt(localStorage.getItem(TOKEN_EXP) || '0', 10);
    if (!t || exp < Date.now()) return null;
    return t;
  } catch {
    return null;
  }
}

export function setSessionToken(token: string, ttlMs = DEFAULT_TTL_MS): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_EXP, String(Date.now() + ttlMs));
  } catch {
    /* localStorage may be unavailable; the next auth check will surface it */
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP);
  } catch {
    /* localStorage may be unavailable */
  }
}
