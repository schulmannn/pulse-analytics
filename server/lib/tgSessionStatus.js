'use strict';

// Public shape of GET /api/tg/qr/status. Built from a raw tg_sessions row but NEVER carries the
// session material (session_enc stays server-side) — only the non-secret connection-health fields.
//
// Internal connection_state (healthy | reauth_required | degraded | unknown) is mapped to a
// client-facing value:
//   - healthy / unknown / null (pre-017 rows)  → 'connected' (a live, usable session)
//   - reauth_required                          → 'reauth_required' (explicit reconnect CTA)
//   - degraded                                 → 'degraded' (transient; NOT a reconnect CTA)
function publicConnectionState(state) {
  switch (state) {
    case 'reauth_required': return 'reauth_required';
    case 'degraded': return 'degraded';
    default: return 'connected';
  }
}

// Build the full public status payload from a raw tg_sessions row (or null when disconnected).
// Backwards-compatible top-level fields (server_ready/connected/username/connected_at) are preserved
// verbatim so existing clients keep working; the health fields are additive.
// `central_owner` is a safe, server-derived boolean: is the caller the owner of the managed central
// channel? It gates the honest owner-only central repair signal on the client and is present in EVERY
// branch (incl. server-not-ready / disconnected) so the UI can rely on it without a null dance.
function toPublicQrStatus(session, { serverReady, centralOwner } = {}) {
  const central_owner = !!centralOwner;
  if (!serverReady) return { server_ready: false, connected: false, central_owner };
  if (!session) return { server_ready: true, connected: false, central_owner };
  return {
    server_ready: true,
    connected: true,
    username: session.username || null,
    connected_at: session.connected_at || null,
    connection_state: publicConnectionState(session.connection_state),
    last_attempt_at: session.last_attempt_at || null,
    last_success_at: session.last_success_at || null,
    last_error_code: session.last_error_code || null,
    last_error_at: session.last_error_at || null,
    central_owner,
  };
}

module.exports = { publicConnectionState, toPublicQrStatus };
