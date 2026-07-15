'use strict';

// Pure unit tests for the public /api/tg/qr/status mapper (route-testing is heavy — this isolates
// the state mapping + the "never leak session_enc" guarantee).

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicConnectionState, toPublicQrStatus } = require('../server/lib/tgSessionStatus');

test('publicConnectionState: healthy/unknown/legacy → connected; reauth_required/degraded explicit', () => {
  assert.equal(publicConnectionState('healthy'), 'connected');
  assert.equal(publicConnectionState('unknown'), 'connected');
  assert.equal(publicConnectionState(null), 'connected');           // pre-017 rows
  assert.equal(publicConnectionState(undefined), 'connected');
  assert.equal(publicConnectionState('reauth_required'), 'reauth_required');
  assert.equal(publicConnectionState('degraded'), 'degraded');
});

test('toPublicQrStatus: server not ready', () => {
  assert.deepEqual(toPublicQrStatus(null, { serverReady: false }), { server_ready: false, connected: false, central_owner: false });
  // a stray session object must not leak when the server is not configured
  assert.deepEqual(toPublicQrStatus({ session_enc: 'SECRET' }, { serverReady: false }), { server_ready: false, connected: false, central_owner: false });
});

test('toPublicQrStatus: ready but no session', () => {
  assert.deepEqual(toPublicQrStatus(null, { serverReady: true }), { server_ready: true, connected: false, central_owner: false });
});

test('toPublicQrStatus: central_owner is a safe server-derived boolean, present in every branch', () => {
  // Present + true only when explicitly owner; coerced from any input; never depends on client data.
  assert.equal(toPublicQrStatus(null, { serverReady: false, centralOwner: true }).central_owner, true);
  assert.equal(toPublicQrStatus(null, { serverReady: true, centralOwner: true }).central_owner, true);
  assert.equal(
    toPublicQrStatus({ username: 'u', connection_state: 'reauth_required' }, { serverReady: true, centralOwner: true }).central_owner,
    true,
  );
  // Absent/omitted → false (never undefined) so the UI can rely on it without a null dance.
  assert.equal(toPublicQrStatus(null, { serverReady: true }).central_owner, false);
  assert.equal(toPublicQrStatus({ username: 'u' }, { serverReady: true }).central_owner, false);
});

test('toPublicQrStatus: default/unknown row maps to connected', () => {
  const out = toPublicQrStatus(
    { username: 'u', connected_at: '2026-07-15T10:00:00', connection_state: 'unknown', session_enc: 'SECRET' },
    { serverReady: true },
  );
  assert.equal(out.connected, true);
  assert.equal(out.connection_state, 'connected');
  assert.equal(out.username, 'u');
  assert.equal(out.last_attempt_at, null);
});

test('toPublicQrStatus: reauth_required stays explicit and carries health fields', () => {
  const out = toPublicQrStatus(
    {
      username: 'u',
      connected_at: '2026-07-15T10:00:00',
      connection_state: 'reauth_required',
      last_attempt_at: '2026-07-15T11:00:00+00:00',
      last_success_at: '2026-07-10T09:00:00+00:00',
      last_error_code: 'session_unauthorized',
      last_error_at: '2026-07-15T11:00:00+00:00',
      session_enc: 'SECRET',
    },
    { serverReady: true },
  );
  assert.equal(out.connection_state, 'reauth_required');
  assert.equal(out.last_error_code, 'session_unauthorized');
  assert.equal(out.last_success_at, '2026-07-10T09:00:00+00:00');
});

test('toPublicQrStatus: NEVER returns session_enc', () => {
  const out = toPublicQrStatus(
    { username: 'u', connection_state: 'healthy', session_enc: 'SECRET', session: 'ALSO_SECRET' },
    { serverReady: true },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'session_enc'), false);
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
});
