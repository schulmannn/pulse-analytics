const TOKEN_KEY = 'pulse_token';
const TOKEN_EXP = 'pulse_token_exp';

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
