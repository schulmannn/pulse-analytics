'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { registerIgOauthRoutes } = require('../server/routes/ig-oauth');
const { createMemoryCache } = require('../server/infrastructure/memoryCache');

const AUTH_SECRET = 'test-auth-secret';
const IG_GRAPH = 'https://graph.instagram.com/v20.0';
const LONG_TOKEN = 'LONG-SECRET-TOKEN-value';
const AUTH_CODE = 'authcode-SECRET-abc';
const STATE_COOKIE = 'atlavue_ig_oauth_state';
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

function seedPending(store, nonce = 'n', over = {}) {
  store.set(nonce, {
    exp: Date.now() + 60_000,
    uid: 1,
    channelId: 42,
    ns: 0,
    ...over,
  });
}

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
  const deleted = [];
  const oauthStateStore = over.oauthStateStore || new Map();
  if (over.seedDefaultState !== false && !oauthStateStore.has('n')) seedPending(oauthStateStore);
  const db = {
    enabled: true,
    getUserById: async (uid) => (uid === 1 ? { id: 1, role: 'user', email: 'u@test', status: 'active' } : null),
    getChannel: async (id) => (id === 42 ? { id: 42, owner_uid: 1 } : null),
    saveIgAccount: async (channelId, acc) => { saved.push({ channelId, acc }); },
    findIgChannelByIgUser: async () => null,
    createIgChannel: async ({ username }) => ({ id: 77, username }),
    getIgAccount: async (channelId) => (channelId === 42 ? { ig_user_id: 'igid123', username: 'creator' } : null),
    deleteIgAccount: async (channelId) => { deleted.push(channelId); return true; },
    ...(over.db || {}),
  };
  // Exercise the REAL production cache (createMemoryCache), not a bare Map — the prior harness
  // used `new Map()`, which masked that the production contract lacked keys()/delete() and made
  // igCachePurge throw in prod. Sweep never started (start() is not called), so no timer leaks.
  const cache = over.cache || createMemoryCache({ maxEntries: 50, ttlMs: 60_000 });
  registerIgOauthRoutes({
    app,
    db,
    requireAuth: (_req, _res, next) => next(),
    audit: async (req, action, meta) => { audits.push({ action, meta }); },
    log: (level, event, meta) => { logs.push({ level, event, meta }); },
    fetchWithTimeout: over.fetch || ((url) => happyFetch(url)),
    asyncHandler: (fn) => fn,
    appBase: () => 'https://app.test',
    cache,
    igConfigured: () => true,
    igCrypto: { configured: () => true, encrypt: (t) => `enc(${t})` },
    AUTH_SECRET,
    IG_GRAPH,
    IG_CLIENT_ID: 'cid',
    IG_CLIENT_SECRET: 'csecret',
    oauthMaxInFlight: over.maxInFlight ?? 8,
    oauthAcquireTimeoutMs: over.acquireTimeoutMs ?? 2000,
    oauthStateStore,
  });
  const start = handlers.get('POST /api/ig/oauth/start');
  const callback = handlers.get('GET /api/ig/oauth/callback');
  const disconnect = handlers.get('DELETE /api/ig/oauth');
  return { start, callback, disconnect, logs, audits, saved, deleted, cache, oauthStateStore };
}

function makeRes() {
  return {
    redirects: [],
    headers: new Map(),
    setHeader(name, value) { this.headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return this.headers.get(String(name).toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(code, url) { this.redirects.push({ code, url }); },
    get last() { return this.redirects[this.redirects.length - 1]; },
  };
}
const run = (callback, query, { cookie } = {}) => {
  const res = makeRes();
  let nonce = '';
  try {
    nonce = JSON.parse(Buffer.from(String(query.state || '').split('.')[0], 'base64url').toString('utf8')).nonce || '';
  } catch { /* invalid state intentionally has no usable nonce */ }
  const cookieValue = cookie === undefined ? nonce : cookie;
  const headers = cookieValue ? { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookieValue)}` } : {};
  return Promise.resolve(callback({ query, headers }, res)).then(() => res);
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
  seedPending(h.oauthStateStore, 'n2');

  const res1 = makeRes();
  const p1 = Promise.resolve(h.callback({
    query: { state: validState(), code: AUTH_CODE },
    headers: { cookie: `${STATE_COOKIE}=n` },
  }, res1));
  await sleep(5);                       // cb1 has acquired the permit and is blocked in the short-token fetch
  const callsBeforeBusy = calls;        // == 1
  assert.equal(callsBeforeBusy, 1);

  const res2 = await run(h.callback, { state: validState({ nonce: 'n2' }), code: 'other-code' });
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

  // OAuth state is one-time even on an upstream failure, so a real retry starts a fresh flow.
  // If the permit had leaked on the throw, this second state would time out as busy.
  seedPending(h.oauthStateStore, 'n2');
  const res2 = await run(h.callback, { state: validState({ nonce: 'n2' }), code: AUTH_CODE });
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

test('OAuth start binds a one-time state to a secure host-only browser cookie', async () => {
  const h = makeHarness({ seedDefaultState: false });
  const startRes = makeRes();
  await h.start({
    query: { channel: '42' },
    headers: {},
    user: { uid: 1, role: 'user', email: 'u@test' },
  }, startRes);

  const authorize = new URL(startRes.body.authorize_url);
  const state = authorize.searchParams.get('state');
  const payload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf8'));
  const setCookie = startRes.getHeader('set-cookie');
  assert.match(setCookie, new RegExp(`^${STATE_COOKIE}=${payload.nonce};`));
  assert.match(setCookie, /Path=\/api\/ig\/oauth\/callback/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=600/);
  assert.match(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /Domain=/, 'cookie stays host-only');
  assert.ok(h.oauthStateStore.has(payload.nonce), 'nonce is registered server-side for atomic consume');

  const callbackRes = await run(h.callback, { state, code: AUTH_CODE }, { cookie: payload.nonce });
  assert.match(callbackRes.last.url, /ig=connected&ch=42$/);
  assert.equal(h.oauthStateStore.has(payload.nonce), false, 'callback consumes the nonce');
  assert.match(callbackRes.getHeader('set-cookie'), /Max-Age=0/, 'browser binding is cleared');
});

test('a leaked signed state without the initiating browser cookie cannot bind an account', async () => {
  let calls = 0;
  const h = makeHarness({ fetch: (url) => { calls += 1; return happyFetch(url); } });
  const res = await run(h.callback, { state: validState(), code: AUTH_CODE }, { cookie: '' });

  assert.equal(res.last.url, 'https://app.test/instagram?ig_error=state');
  assert.equal(calls, 0, 'no provider exchange happens without the browser binding');
  assert.equal(h.saved.length, 0);
  assert.ok(h.oauthStateStore.has('n'), 'an attacker without the cookie cannot consume the victim state');
});

test('OAuth state is atomically one-time even when a caller replays the cookie', async () => {
  let calls = 0;
  const h = makeHarness({ fetch: (url) => { calls += 1; return happyFetch(url); } });
  const state = validState();

  const first = await run(h.callback, { state, code: AUTH_CODE });
  assert.match(first.last.url, /ig=connected&ch=42$/);
  assert.equal(calls, 3);

  const replay = await run(h.callback, { state, code: 'fresh-attacker-code' }, { cookie: 'n' });
  assert.equal(replay.last.url, 'https://app.test/instagram?ig_error=state');
  assert.equal(calls, 3, 'replay is rejected before any provider call');
  assert.equal(h.saved.length, 1, 'only the original account persistence completed');
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

// ── Targeted cache purge against the REAL createMemoryCache ──────────────────
// Regression guard: production injects createMemoryCache, whose contract must expose
// keys()/delete() so igCachePurge can run. A bare Map used to mask this — with the real cache a
// missing method would throw inside the callback (falsely redirecting ig_error=exchange after the
// account was already persisted) and inside disconnect (500 after the row was already deleted).

// The identity in the happy path is igid123; seed sibling keys to prove segment-aware purging.
function seedIgCache(cache) {
  cache.set('ig:media:igid123', 'own');
  cache.set('ig:insights:igid123:reach', 'own-param');
  cache.set('ig:media:igid1234', 'sibling');   // superstring id — must survive
  cache.set('ig:media:9igid123', 'other');      // id embedded mid-segment — must survive
  cache.set('ig:insights:other-account:igid123', 'param-collision'); // same value outside account slot
  cache.set('other:igid123', 'non-ig');         // non-ig namespace — must survive
}

test('callback with the real cache: only the exact account segment is purged; persist+audit+redirect complete', async () => {
  const cache = createMemoryCache({ maxEntries: 50, ttlMs: 60_000 });
  seedIgCache(cache);
  const h = makeHarness({ cache });
  const res = await run(h.callback, { state: validState(), code: AUTH_CODE });

  // Success path fully completes (would have redirected ig_error=exchange if igCachePurge threw).
  assert.match(res.last.url, /\/instagram\?ig=connected&ch=42$/);
  assert.equal(h.saved.length, 1, 'account persisted');
  assert.ok(h.audits.some((a) => a.action === 'ig_oauth_connected'), 'connect audited');

  assert.equal(cache.get('ig:media:igid123'), null, 'exact account key purged');
  assert.equal(cache.get('ig:insights:igid123:reach'), null, 'account key with trailing param purged');
  assert.equal(cache.get('ig:media:igid1234'), 'sibling', 'superstring-id sibling untouched');
  assert.equal(cache.get('ig:media:9igid123'), 'other', 'mid-segment match untouched');
  assert.equal(cache.get('ig:insights:other-account:igid123'), 'param-collision', 'only account slot matches');
  assert.equal(cache.get('other:igid123'), 'non-ig', 'non-ig namespace untouched');
});

test('disconnect with the real cache: deletes the row, purges only its segment, audits, and returns ok', async () => {
  const cache = createMemoryCache({ maxEntries: 50, ttlMs: 60_000 });
  seedIgCache(cache);
  const h = makeHarness({ cache });

  const res = makeRes();
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.body = body; return this; };
  await Promise.resolve(h.disconnect({ query: { channel: '42' }, headers: {}, user: { uid: 1, role: 'user' } }, res));

  assert.deepEqual(res.body, { ok: true, removed: true }, 'success response returned (no 500)');
  assert.deepEqual(h.deleted, [42], 'account row deleted');
  assert.ok(h.audits.some((a) => a.action === 'ig_oauth_disconnected'), 'disconnect audited');

  assert.equal(cache.get('ig:media:igid123'), null, 'exact account key purged');
  assert.equal(cache.get('ig:insights:igid123:reach'), null, 'account key with trailing param purged');
  assert.equal(cache.get('ig:media:igid1234'), 'sibling', 'superstring-id sibling untouched');
  assert.equal(cache.get('ig:insights:other-account:igid123'), 'param-collision', 'parameter collision untouched');
  assert.equal(cache.get('other:igid123'), 'non-ig', 'non-ig namespace untouched');
});

test('the production cache contract exposes keys()/delete() used by igCachePurge', () => {
  const cache = createMemoryCache({ maxEntries: 8, ttlMs: 60_000 });
  cache.set('a', 1); cache.set('b', 2);
  assert.equal(typeof cache.keys, 'function');
  assert.equal(typeof cache.delete, 'function');
  assert.deepEqual(cache.keys().sort(), ['a', 'b']);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.get('a'), null);
  assert.deepEqual(cache.keys(), ['b']);
});

test('cache invalidation failure never turns a durable OAuth connect into a false exchange error', async () => {
  const h = makeHarness({ cache: { get: () => null, set: () => {} } });
  const res = await run(h.callback, { state: validState(), code: AUTH_CODE });

  assert.match(res.last.url, /ig=connected&ch=42$/);
  assert.equal(h.saved.length, 1);
  assert.ok(h.audits.some((a) => a.action === 'ig_oauth_connected'));
  assert.ok(h.logs.some((entry) => entry.event === 'ig_cache_purge_failed'));
});
