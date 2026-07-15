'use strict';

const crypto = require('crypto');
const { hasWorkspaceRole } = require('../middleware/tenant');
const { createAdmissionController } = require('../lib/admissionController');

// "Business Login for Instagram" (Instagram API with Instagram Login, no Facebook Page). These app
// credentials + scopes are read once at load, exactly as index.js did.
// IG_CLIENT_ID/IG_CLIENT_SECRET приходят из deps (config.instagram.clientId/clientSecret) —
// роуты env не читают (boundary-гвард).
// Insights edges (reach / views / follower_count / follows_and_unfollows, media & story insights)
// require instagram_business_manage_insights — instagram_business_basic alone is NOT enough. Both
// are requested at connect time (Meta blog 2025-03-24).
const IG_OAUTH_SCOPES  = 'instagram_business_basic,instagram_business_manage_insights';
const IG_STATE_TTL = 10 * 60 * 1000;

/**
 * Instagram OAuth (per-channel connect) routes — extracted verbatim from index.js.
 *
 * Owns the oauth-only surface: igOauthConfigured, the signed-state helpers (signIgState/parseIgState)
 * and their HMAC key (derived here from the injected AUTH_SECRET — the domain-separated 'ig-state'
 * subkey), and igCachePurge (only the connect/disconnect flow purges the IG data cache; it iterates
 * the injected `cache` Map). Shared data-layer bits (igConfigured, IG_GRAPH) still live in index.js
 * — the IG cron + resolveIg use them — and are injected. igCrypto is the stateless token-encryption
 * singleton. appBase builds the public base URL for the redirect_uri and the SPA bounce.
 */
function registerIgOauthRoutes({
  app, db, requireAuth, audit, log, fetchWithTimeout, asyncHandler,
  appBase, cache, igConfigured, igCrypto, AUTH_SECRET, IG_GRAPH,
  IG_CLIENT_ID, IG_CLIENT_SECRET, oauthMaxInFlight, oauthAcquireTimeoutMs,
}) {
  // Bounded admission for the OAuth callback: it fans out three DEPENDENT external exchanges
  // (code→short→long→/me), each with a multi-second timeout, so an onboarding peak could otherwise
  // pin unbounded request slots against Instagram at once. One web replica (ADR-002) → a process-local
  // counter is authoritative. Config is validated in config.js; fall back to the same safe defaults
  // here so a bare test harness that omits them still gets a real bound.
  const igOauthAdmission = createAdmissionController({
    maxInFlight: oauthMaxInFlight,
    maxWaiting: oauthMaxInFlight,
    acquireTimeoutMs: oauthAcquireTimeoutMs,
  });
  // The per-channel OAuth connect flow needs app credentials, the token-encryption key, and a DB
  // (tokens are stored encrypted, one per channel). Without all three, connect is unavailable and
  // IG falls back to the global env account (or mock).
  const igOauthConfigured = () => !!IG_CLIENT_ID && !!IG_CLIENT_SECRET && igCrypto.configured() && db.enabled;

  // Drop cached IG payloads for one account id (keys look like `ig:<kind>:<accountId>[:...]`),
  // so a connect/disconnect flips the UI immediately instead of waiting out the 10-min TTL.
  function igCachePurge(accountId) {
    if (!accountId) return;
    const id = String(accountId);
    // Delimiter-aware: match the account id as a whole ':'-segment, so purging id 123 never touches
    // 1234's keys (a substring `includes(':123')` would). Keys look like ig:<kind>:<accountId>[:<param>].
    for (const k of cache.keys()) if (k.startsWith('ig:') && k.split(':').includes(id)) cache.delete(k);
  }

  // OAuth "state": a signed, expiring blob binding the connect flow to (uid, channelId). The
  // callback lands WITHOUT a session header (top-level browser redirect from Instagram), so the
  // signed state is the only trustworthy attribution — HMAC(IG_STATE_KEY, a domain-separated
  // subkey of AUTH_SECRET) + 10-min expiry + nonce.
  const IG_STATE_KEY = crypto.createHmac('sha256', AUTH_SECRET).update('ig-state').digest();
  function signIgState(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig  = crypto.createHmac('sha256', IG_STATE_KEY).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
  function parseIgState(state) {
    try {
      if (!state || typeof state !== 'string' || state.indexOf('.') < 0) return null;
      const [body, sig] = state.split('.');
      const expected = crypto.createHmac('sha256', IG_STATE_KEY).update(body).digest('base64url');
      if (!sig || sig.length !== expected.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload.exp || payload.exp <= Date.now()) return null;
      return payload;
    } catch { return null; }
  }

  // ── Instagram OAuth (per-channel connect) ─────────────────────────
  // "Business Login for Instagram" (Instagram API with Instagram Login, no Facebook Page).
  // Flow: start (authed, returns authorize_url) → user authorizes on instagram.com → callback
  // (credential-free, trusts the signed state) → code→short→long-lived token → stored encrypted
  // against the channel. Inert until IG_CLIENT_ID/IG_CLIENT_SECRET/IG_TOKEN_KEY + a DB are set.

  // POST /api/ig/oauth/start — begin connecting an Instagram account to the selected channel.
  // Returns { authorize_url } for a top-level browser navigation (a session header can't survive
  // the OAuth redirect, so we can't 302 here). The (uid, channelId) are bound into a signed state.
  app.post('/api/ig/oauth/start', requireAuth, asyncHandler(async (req, res) => {
    if (!igOauthConfigured()) return res.status(400).json({ error: 'Подключение Instagram не настроено на сервере' });
    // ?new_source=1 — connect the account as its OWN standalone source (a fresh channels row is
    // created in the callback once the identity is known) instead of attaching it to a channel.
    const newSource = String(req.query.new_source || '') === '1';
    const channelId = newSource ? 0 : parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    if (!newSource) {
      if (!channelId) return res.status(400).json({ error: 'Выбери канал, к которому подключить Instagram' });
      const ch = await db.getChannel(channelId, req.user).catch(() => null);
      if (!ch) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
      // Rebinding the channel's IG account/token — workspace admins only (ADR-001). The callback
      // trusts the signed state, so gating the state mint here covers the whole flow.
      if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    }
    const state = signIgState({ uid: req.user.uid, channelId, ns: newSource ? 1 : 0, nonce: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + IG_STATE_TTL });
    const authorizeUrl = 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
      client_id: IG_CLIENT_ID,
      redirect_uri: `${appBase(req)}/api/ig/oauth/callback`,
      response_type: 'code',
      scope: IG_OAUTH_SCOPES,
      state,
    }).toString();
    await audit(req, 'ig_oauth_start', { channelId });
    res.json({ authorize_url: authorizeUrl });
  }));

  // GET /api/ig/oauth/callback — Instagram redirects the user's browser here after they authorize.
  // No session header (top-level redirect), so trust comes from the signed state. Exchanges the code
  // for a long-lived token, stores it encrypted against the channel, then bounces the browser back
  // into the SPA with a success/error flag. Never renders tokens; logs stay secret-free.
  app.get('/api/ig/oauth/callback', async (req, res) => {
    const back = (q) => res.redirect(302, `${appBase(req)}/instagram?${q}`);
    try {
      if (req.query.error) return back('ig_error=denied');
      if (!igOauthConfigured()) return back('ig_error=server');
      const st = parseIgState(req.query.state);
      const code = String(req.query.code || '');
      if (!st || !code) return back('ig_error=state');

      // Re-verify the user still exists/active and still owns the target channel (state can outlive
      // a permission change).
      if (st.uid == null) return back('ig_error=auth');
      const u = await db.getUserById(st.uid).catch(() => null);
      if (!u || u.status !== 'active') return back('ig_error=auth');
      const user = { uid: u.id, role: u.role, email: u.email };
      // Channel-bound connect re-verifies ownership; a new-source connect has no channel yet —
      // its row is created below, after the Instagram identity is known.
      if (!st.ns) {
        const ch = await db.getChannel(st.channelId, user).catch(() => null);
        // The signed state can live for ten minutes. Re-check the write role as well as visibility so
        // a user downgraded after /start cannot still replace the workspace's Instagram credential.
        if (!ch || !hasWorkspaceRole(ch, user, 'admin')) return back('ig_error=channel');
      }
      const redirectUri = `${appBase(req)}/api/ig/oauth/callback`;

      // Admission gate: bound how many callbacks run the three dependent external exchanges at once.
      // State/user/channel are already validated above (cheap, no external calls), so a rejected
      // attempt here has made NO provider call and touched no code/token. Overload fast-fails with a
      // stable, safe code + retry UX — it is NOT an auth/state failure. Held across the exchange and
      // its short persistence tail, then released in `finally` so redirects, throws and early returns
      // all free the slot; no DB connection is held while waiting on Instagram.
      let releaseSlot;
      try {
        releaseSlot = await igOauthAdmission.acquire();
      } catch {
        log('warn', 'ig_oauth_busy', { channelId: st.channelId });
        return back('ig_error=busy');
      }
      try {
        // 1) authorization code → short-lived token (api.instagram.com, form-encoded POST).
        const shortRes = await fetchWithTimeout('https://api.instagram.com/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: IG_CLIENT_ID,
            client_secret: IG_CLIENT_SECRET,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code,
          }).toString(),
        });
        const shortJson = await shortRes.json().catch(() => ({}));
        if (!shortJson.access_token) {
          log('warn', 'ig_oauth_short_failed', { channelId: st.channelId, err: shortJson.error_message || shortJson.error_type || 'no_token' });
          return back('ig_error=exchange');
        }

        // 2) short-lived → long-lived (~60d) token (graph.instagram.com). If this fails we must NOT
        // silently persist the 1-hour short token under a 60-day expiry (the connection would die in an
        // hour with no refresh path) — bail with an error flag and let the user retry.
        const longRes = await fetchWithTimeout(`${IG_GRAPH}/access_token?` + new URLSearchParams({
          grant_type: 'ig_exchange_token', client_secret: IG_CLIENT_SECRET, access_token: shortJson.access_token }).toString());
        const longJson = await longRes.json().catch(() => ({}));
        if (!longJson.access_token || !longJson.expires_in) {
          log('warn', 'ig_oauth_long_failed', { channelId: st.channelId, err: longJson.error_message || (longJson.error && longJson.error.message) || longJson.error || 'no_long_token' });
          return back('ig_error=exchange');
        }
        const longToken = longJson.access_token;
        const expiresIn = Number(longJson.expires_in);

        // 3) identity — the IG user id + username to display and to build data-edge paths.
        const meRes = await fetchWithTimeout(`${IG_GRAPH}/me?` + new URLSearchParams({ fields: 'id,username,account_type', access_token: longToken }).toString());
        const me = await meRes.json().catch(() => ({}));
        const igUserId = me.id || String(shortJson.user_id || '');
        if (!igUserId) return back('ig_error=identity');

        // New-source connect: reuse the user's channel that already holds this identity (a
        // reconnect just refreshes its token), else create a standalone source='ig' row.
        let targetChannelId = st.channelId;
        if (st.ns) {
          const existing = await db.findIgChannelByIgUser(user.uid, igUserId).catch(() => null);
          if (existing) {
            targetChannelId = existing;
          } else {
            const created = await db.createIgChannel({ owner_uid: user.uid, username: me.username || null }).catch(() => null);
            if (!created) return back('ig_error=channel');
            targetChannelId = created.id;
          }
        }

        await db.saveIgAccount(targetChannelId, {
          ig_user_id: igUserId,
          username: me.username || null,
          access_token_enc: igCrypto.encrypt(longToken),
          token_expires_at: new Date(Date.now() + expiresIn * 1000),
          scopes: IG_OAUTH_SCOPES,
        });
        igCachePurge(igUserId);   // clear any stale cached payloads for this account id
        req.user = user; req.channel = { id: targetChannelId };
        await audit(req, 'ig_oauth_connected', { channelId: targetChannelId, username: me.username || null, newSource: !!st.ns });
        // ch= lets the SPA switch straight to the (possibly fresh) source after the bounce.
        return back(`ig=connected&ch=${targetChannelId}`);
      } finally {
        releaseSlot();
      }
    } catch (e) {
      log('error', 'ig_oauth_callback_error', { error: e.message });
      return back('ig_error=exchange');
    }
  });

  // DELETE /api/ig/oauth — disconnect the Instagram account from the selected channel.
  app.delete('/api/ig/oauth', requireAuth, asyncHandler(async (req, res) => {
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    if (!channelId) return res.status(400).json({ error: 'Канал не выбран' });
    const ch = await db.getChannel(channelId, req.user).catch(() => null);
    if (!ch) return res.status(403).json({ error: 'Нет доступа к этому каналу' });
    if (!hasWorkspaceRole(ch, req.user, 'admin')) return res.status(403).json({ error: 'Недостаточно прав в этом воркспейсе' });
    const acc = await db.getIgAccount(channelId).catch(() => null);
    const removed = await db.deleteIgAccount(channelId);
    if (acc && acc.ig_user_id) igCachePurge(acc.ig_user_id);
    await audit(req, 'ig_oauth_disconnected', { channelId });
    res.json({ ok: true, removed });
  }));

  // GET /api/ig/oauth/status — connection state for Settings + the connect panel (no token leaked).
  app.get('/api/ig/oauth/status', requireAuth, asyncHandler(async (req, res) => {
    const channelId = parseInt(req.query.channel || req.headers['x-channel-id'], 10) || 0;
    let acc = null;
    if (db.enabled && channelId) {
      const ch = await db.getChannel(channelId, req.user).catch(() => null);
      if (ch) acc = await db.getIgAccount(channelId).catch(() => null);
    }
    res.json({
      server_ready: igOauthConfigured(),   // app credentials + encryption key + DB all present
      env_fallback: igConfigured(),        // a global env account is serving IG in the meantime
      connected: !!acc,
      channel_id: channelId || null,
      username: acc ? acc.username : null,
      ig_user_id: acc ? acc.ig_user_id : null,
      connected_at: acc ? acc.connected_at : null,
      token_expires_at: acc ? acc.token_expires_at : null,
    });
  }));
}

module.exports = { registerIgOauthRoutes };
