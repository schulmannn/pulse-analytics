const LEGACY_TOKEN_KEY = 'pulse_token';
const LEGACY_TOKEN_EXP_KEY = 'pulse_token_exp';
const MAX_LEGACY_TOKEN_LENGTH = 4096;
const MIGRATION_TIMEOUT_MS = 5000;

/** Remove the pre-cookie bearer transport. Safe to call repeatedly. */
export function purgeLegacySession(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_EXP_KEY);
  } catch {
    /* localStorage may be unavailable */
  }
}

/**
 * One-release bridge for users signed in before HttpOnly-cookie auth shipped.
 * It runs before the first auth probe, sends X-Session-Token only to the narrow
 * migration endpoint, and purges both browser-readable keys on every outcome.
 *
 * `false` is intentionally non-fatal: a valid cookie may already exist, while a
 * missing/expired/invalid legacy token should simply fall through to the normal
 * cookie auth gate.
 */
export async function migrateLegacySession(): Promise<boolean> {
  let token: string | null = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIGRATION_TIMEOUT_MS);
  try {
    const stored = localStorage.getItem(LEGACY_TOKEN_KEY);
    const expiresAt = Number.parseInt(
      localStorage.getItem(LEGACY_TOKEN_EXP_KEY) ?? '',
      10,
    );
    if (
      stored &&
      stored.length <= MAX_LEGACY_TOKEN_LENGTH &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now()
    ) {
      token = stored;
    }
  } catch {
    // The finally purge below is best-effort too; continue without migration.
  }

  try {
    if (!token) return false;
    const response = await fetch('/api/auth/migrate-cookie', {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Session-Token': token,
      },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    purgeLegacySession();
  }
}
