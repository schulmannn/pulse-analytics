'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { registerIgOauthRoutes } = require('../server/routes/ig-oauth');

const AUTH_SECRET = 'test-auth-secret';
const IG_GRAPH = 'https://graph.instagram.com/v20.0';
const LONG_TOKEN = 'LONG-SECRET-TOKEN-value';
const AUTH_CODE = 'authcode-SECRET-abc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reproduces routes/ig-oauth signIgState with the same domain-separated subkey, so the callback's
// HMAC verification accepts our test state (and a tampered sig is genuinely rejected).
function signState(payload, secret = AUTH_SECRET) {
  const key = crypto.createHmac('sha256', secret).update('ig-state').digest();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}
const validState = (over = {}) =>
  signState({ uid: 1, channelId: 42, ns: 0, nonce: 'n', exp: Date.now() + 60_000, ...over });

const okJson = (obj) => ({ ok: true, json: async () => obj });
function happyFetch(url) {
  if (url.startsWith('https://api.instagram.com')) return Promise.resolve(okJson({ access_token: 'short-tok', user_id: '999' }));
  if (url.includes('/access_token?')) return Promise.resolve(okJson({ access_token: LONG_TOKEN, expires_in: 5_184_000 }));
  if (url.includes('/me?')) return Promise.resolve(okJson({ id: 'igid123', username: 'creator', account_type: 'BUSINESS' }));
  return Promise.resolve(okJson({}));
}

function makeHarness(over = {}) {
  const handlers = new Map();
  const app = {
    post: (p, ...h) => handlers.set(`POST ${p}`, h[h.length - 1]),
    get: (p, ...h) => handlers.set(`GET ${p}`, h[h.length - 1]),
    delete: (p, ...h) => handlers.set(`DELETE ${p}`, h[h.length - 1]),
  };
  const logs = [];
  const audits = [];
  const saved = [];
  const db = {
    enabled: true,
    getUserById: async (uid) => (uid === 1 ? { id: 1, role: 'user', email: 'u@test', status: 'active' } : null),
    getChannel: async (id) => (id === 42 ? { id: 42, owner_uid: 1 } : null),
    saveIgAccount: async (channelId, acc) => { saved.push({ channelId, acc }); },
    findIgChannelByIgUser: async () => null,
    createIgChannel: async ({ username }) => ({ id: 77, username }),
    ...(over.db || {}),
  };
  registerIgOauthRoutes({
    app,
    db,
    requireAuth: (_req, _res, next) => next(),
    audit: async (req, action, meta) => { audits.push({ action, meta }); },
    log: (level, event, meta) => { logs.push({ level, event, meta }); },
    fetchWithTimeout: over.fetch || ((url) => happyFetch(url)),
    asyncHandler: (fn) => fn,
    appBase: () => 'https://app.test',
    cache: new Map(),
    igConfigured: () => true,
    igCrypto: { configured: () => true, encrypt: (t) => `enc(${t})` },
    AUTH_SECRET,
    IG_GRAPH,
    IG_CLIENT_ID: 'cid',
    IG_CLIENT_SECRET: 'csecret',
    oauthMaxInFlight: over.maxInFlight ?? 8,
    oauthAcquireTimeoutMs: over.acquireTimeoutMs ?? 2000,
  });
  const callback = handlers.get('GET /api/ig/oauth/callback');
  return { callback, logs, audits, saved };
}

function makeRes() {
  return {
    redirects: [],
    redirect(code, url) { this.redirects.push({ code, url }); },
    get last() { return this.redirects[this.redirects.length - 1]; },
  };
}
const run = (callback, query) => {
  const res = makeRes();
  return Promise.resolve(callback({ query, headers: {} }, res)).then(() => res);
};

test('happy path: exchanges the code, stores the ENCRYPTED long token, bounces ig=connected', async () => {
  let calls = 0;
  const h = makeHarness({ fetch: (url) => { calls += 1; return happyFetch(url); } });
  const res = await run(h.callback, { state: validState(), code: AUTH_CODE });

  assert.match(res.last.url, /\/instagram\?ig=connected&ch=42$/);
  assert.equal(calls, 3, 'three dependent exchanges ran (code→short→long→/me), in order');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].channelId, 42);
  assert.equal(h.saved[0].acc.access_token_enc, `enc(${LONG_TOKEN})`, 'token persisted encrypted');
  assert.notEqual(h.saved[0].acc.access_token_enc, LONG_TOKEN, 'raw token never stored');

  // No secret (long token or authorization code) may appear in logs, audit, or the redirect URL.
  const blob = JSON.stringify({ logs: h.logs, audits: h.audits, redirects: res.redirects });
  assert.ok(!blob.includes(LONG_TOKEN), 'long token must not leak');
  assert.ok(!blob.includes(AUTH_CODE), 'authorization code must not leak');
  const connected = h.audits.find((a) => a.action === 'ig_oauth_connected');
  assert.ok(connected && connected.meta.channelId === 42);
  assert.equal(connected.meta.access_token, undefined);
});

test('overload: the (N+1)th concurrent callback fails fast with ig_error=busy and makes NO provider call', async () => {
  let calls = 0;
  let release1;
  const hold = new Promise((r) => { release1 = r; });
  const fetch = async (url) => {
    calls += 1;
    if (url.startsWith('https://api.instagram.com')) { await hold; } // first callback pins the only slot
    return happyFetch(url);
  };
  const h = makeHarness({ fetch, maxInFlight: 1, acquireTimeoutMs: 30 });

  const res1 = makeRes();
  const p1 = Promise.resolve(h.callback({ query: { state: validState(), code: AUTH_CODE }, headers: {} }, res1));
  await sleep(5);                       // cb1 has acquired the permit and is blocked in the short-token fetch
  const callsBeforeBusy = calls;        // == 1
  assert.equal(callsBeforeBusy, 1);

  const res2 = await run(h.callback, { state: validState(), code: 'other-code' });
  assert.equal(res2.last.url, 'https://app.test/instagram?ig_error=busy');
  assert.equal(calls, callsBeforeBusy, 'the rejected attempt made no external provider call');
  assert.ok(h.logs.some((l) => l.event === 'ig_oauth_busy'), 'overload is logged as busy, not an exchange error');

  release1();                            // let cb1 finish; the slot is returned
  await p1;
  assert.match(res1.last.url, /ig=connected&ch=42$/);
  assert.equal(calls, 3);
});

test('permit is released after a thrown fetch — a later callback still gets in (no leak)', async () => {
  let first = true;
  const fetch = (url) => {
    if (first) { first = false; return Promise.reject(new Error('socket hang up')); }
    return happyFetch(url);
  };
  const h = makeHarness({ fetch, maxInFlight: 1, acquireTimeoutMs: 30 });

  const res1 = await run(h.callback, { state: validState(), code: AUTH_CODE });
  assert.equal(res1.last.url, 'https://app.test/instagram?ig_error=exchange');

  // If the permit had leaked on the throw, this second call would time out as busy.
  const res2 = await run(h.callback, { state: validState(), code: AUTH_CODE });
  assert.match(res2.last.url, /ig=connected&ch=42$/);
});

test('invalid OAuth state is rejected before admission — no provider call, no slot consumed', async () => {
  let calls = 0;
  const h = makeHarness({ fetch: (url) => { calls += 1; return happyFetch(url); }, maxInFlight: 1, acquireTimeoutMs: 30 });

  const tampered = validState().slice(0, -2) + 'xx';   // corrupt the signature
  const resBad = await run(h.callback, { state: tampered, code: AUTH_CODE });
  assert.equal(resBad.last.url, 'https://app.test/instagram?ig_error=state');
  assert.equal(calls, 0, 'no external call for an unverifiable state');

  // The slot was never taken, so a valid callback right after still succeeds immediately.
  const resOk = await run(h.callback, { state: validState(), code: AUTH_CODE });
  assert.match(resOk.last.url, /ig=connected&ch=42$/);
});

test('tenant isolation preserved: a callback for a channel the user cannot access → ig_error=channel', async () => {
  let calls = 0;
  const h = makeHarness({
    fetch: (url) => { calls += 1; return happyFetch(url); },
    db: { getChannel: async () => null },   // no access to the target channel
  });
  const res = await run(h.callback, { state: validState({ channelId: 42 }), code: AUTH_CODE });
  assert.equal(res.last.url, 'https://app.test/instagram?ig_error=channel');
  assert.equal(calls, 0, 'ownership is re-checked before any token exchange');
});

test('a signed state cannot outlive an admin-role downgrade', async () => {
  let calls = 0;
  const h = makeHarness({
    fetch: (url) => { calls += 1; return happyFetch(url); },
    db: { getChannel: async () => ({ id: 42, owner_uid: 2, member_role: 'member' }) },
  });
  const res = await run(h.callback, { state: validState({ channelId: 42 }), code: AUTH_CODE });
  assert.equal(res.last.url, 'https://app.test/instagram?ig_error=channel');
  assert.equal(calls, 0, 'downgraded member cannot exchange or replace the workspace credential');
  assert.equal(h.saved.length, 0);
});
