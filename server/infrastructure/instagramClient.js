// ═══════════════════════════════════════════════════════════════
//  Atlavue — Instagram Graph client (infrastructure)
// ═══════════════════════════════════════════════════════════════
// Единственная точка Graph-вызовов (декомпозиция index.js, PR D): singleflight igFetch
// + opportunistic refresh 60-дневного токена. Ноль знания о юзерах/каналах/req —
// db.updateIgToken и igCrypto инъектируются (персист свежего токена). Live-роуты и
// дневной cron-сбор могут иметь разные DB budgets, сохраняя общий singleflight Map.
// Тела перенесены из index.js literal.

'use strict';

const { fetchWithTimeout } = require('../lib/http');

// "Instagram API with Instagram Login" (no Facebook Page): the IG user access token works
// against graph.instagram.com, NOT graph.facebook.com.
const IG_BASE  = 'https://graph.instagram.com/v22.0';   // versioned data edges
const IG_GRAPH = 'https://graph.instagram.com';         // token exchange / refresh / me (unversioned)

// ── Retry policy for the versioned data-edge GET (igFetch only) ─────────────────────────────────
// This is the idempotent read choke-point; a small bounded retry rides out a rate-limit blip or a
// transient Graph 5xx without multiplying quota (the retry lives INSIDE the singleflight). OAuth /
// token-exchange / refresh paths are deliberately NOT routed here — they keep single-shot behavior.
const IG_MAX_RETRIES     = 2;      // → 3 attempts total
const IG_BACKOFF_BASE_MS = 250;    // attempt N waits base * 2^(N-1): 250ms, 500ms
const IG_BACKOFF_BUDGET_MS = 1000; // hard ceiling on cumulative backoff sleep per request

// Graph error codes that mean "you are being throttled" (surface as 429, retry). Subcodes are not
// throttle signals on their own, so we match on the top-level code only.
//   4  = app-level rate limit, 17 = user-level rate limit, 32 = page rate limit,
//   613 = custom-rate-limit / calls-per-second.
const IG_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
// Authentication, permission and invalid-parameter failures must never be retried even if a
// malformed/contradictory Graph payload happens to mark them transient.
const IG_NON_RETRYABLE_CODES = new Set([10, 100, 190, 200]);

// Retry-After may be an integer number of seconds or an HTTP-date; return whole seconds (≥0) or
// null when absent/unparseable. `nowMs` is injected so the HTTP-date branch is deterministic.
function parseRetryAfterSeconds(headerValue, nowMs) {
  if (headerValue == null) return null;
  const s = String(headerValue).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) {
    const seconds = Number(s);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

// X-App-Usage / X-Business-Use-Case-Usage are JSON blobs; return the parsed object only when it is
// genuinely an object, otherwise undefined (a malformed header must never crash the read).
function parseUsageHeader(headerValue) {
  if (headerValue == null || headerValue === '') return undefined;
  try {
    const parsed = JSON.parse(headerValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

// defaultToken = глобальный env-токен (IG_ACCESS_TOKEN): legacy-вызовы igFetch без
// 3-го аргумента продолжают работать как раньше; IG-роуты передают per-request токен.
// fetchImpl/sleep/now инъектируются только для детерминированных unit-тестов; дефолты —
// прод-поведение (реальный fetchWithTimeout, реальный setTimeout, системные часы).
function createInstagramClient({ db, log, igCrypto, defaultToken, inflight, fetchImpl, sleep, now }) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const logFn = log || (() => {});
  const clock = now || Date.now;
  const doSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Single choke-point for all Graph data calls. `token` defaults to the global env token so any
  // legacy caller keeps working; the IG routes pass the per-request token (req.ig.token).
  // Singleflight: concurrent identical calls (two tabs, a dashboard fan-out racing the cache)
  // share ONE Graph request instead of multiplying quota burn. Keyed by the full URL — the
  // access token is part of it, so different accounts never share a flight.
  // Live и background-клиенты могут разделять один Map: Graph singleflight остаётся общим,
  // хотя персист refresh-токена у каждого клиента идёт через свой DB budget.
  const igInflight = inflight || new Map();

  // One HTTP attempt against the data edge. Returns parsed JSON on success; on any failure throws an
  // Error tagged with safe, structured metadata: `.status` (client-facing HTTP), `.transient`
  // (whether a retry is allowed), `.retryAfter` (seconds, when the provider told us), plus Graph
  // `.graph` / usage headers. NB: the URL (which carries the access token) is NEVER put on the error
  // message or logs — only `path` is, so nothing leaks downstream.
  async function igAttempt(url, path) {
    let res;
    try {
      res = await doFetch(url);
    } catch (netErr) {
      // fetchWithTimeout rejects on timeout / socket failure → transient. The raw message can embed
      // the tokenized URL, so keep only the safe cause code, not the message itself.
      const err = new Error('Instagram API: upstream request failed');
      err.transient = true;
      err.status = 503;
      err.causeCode = (netErr && (netErr.code || netErr.type || netErr.name)) || 'network_error';
      throw err;
    }

    const status = Number(res.status) || 0;
    let json = null;
    let parseFailed = false;
    try { json = await res.json(); } catch { parseFailed = true; }
    const graphError = json && typeof json === 'object' && json.error && typeof json.error === 'object'
      ? json.error : null;

    if (!graphError && !parseFailed && status >= 200 && status < 300) return json;

    // ── Classification ──────────────────────────────────────────────────────────────────────────
    const code = graphError && Number.isFinite(Number(graphError.code)) ? Number(graphError.code) : null;
    const isRateLimit = status === 429 || (code != null && IG_RATE_LIMIT_CODES.has(code));
    const is5xx = status >= 500;
    const graphType = graphError && typeof graphError.type === 'string' ? graphError.type : null;
    const explicitlyNonRetryable =
      !isRateLimit &&
      (graphType === 'OAuthException' || (code != null && IG_NON_RETRYABLE_CODES.has(code)));
    const isTransientGraph = !!(graphError && graphError.is_transient === true);
    const transient = !explicitlyNonRetryable && (isRateLimit || is5xx || isTransientGraph);

    // Facing status: rate-limit → 429; other transient (5xx / timeout / is_transient) → 503;
    // everything else (auth / permission / invalid-parameter) → 502, preserved as upstream failure.
    const facing = isRateLimit ? 429 : (transient ? 503 : 502);

    const message = graphError
      ? `Instagram API: ${graphError.message || 'error'}`
      : `Instagram API: upstream error (HTTP ${status})`;   // malformed body — do not mask the status
    const err = new Error(message);
    err.status = facing;
    err.transient = transient;
    err.upstreamStatus = status;

    const retryAfter = parseRetryAfterSeconds(res.headers && res.headers.get('retry-after'), clock());
    if (retryAfter != null) err.retryAfter = retryAfter;
    if (graphError) {
      err.graph = {
        code,
        subcode: Number.isFinite(Number(graphError.error_subcode)) ? Number(graphError.error_subcode) : null,
        type: graphType,
        is_transient: graphError.is_transient === true,
      };
      if (err.graph.code != null) err.igCode = err.graph.code;
      if (err.graph.subcode != null) err.igSubcode = err.graph.subcode;
      err.igTransient = err.graph.is_transient;
    }
    const appUsage = parseUsageHeader(res.headers && res.headers.get('x-app-usage'));
    if (appUsage) err.appUsage = appUsage;
    const bucUsage = parseUsageHeader(res.headers && res.headers.get('x-business-use-case-usage'));
    if (bucUsage) err.businessUseCaseUsage = bucUsage;
    throw err;
  }

  function igFetch(path, params = {}, token = defaultToken) {
    // Do not mutate the caller's params object — clone and add the token to the copy.
    const qs  = new URLSearchParams({ ...params, access_token: token }).toString();
    const url = `${IG_BASE}${path}?${qs}`;
    let flight = igInflight.get(url);
    if (!flight) {
      // The ENTIRE retry sequence lives inside the singleflight promise: concurrent identical
      // callers share one attempt-chain, so retries never multiply quota burn.
      flight = (async () => {
        let backoffSpent = 0;
        for (let attempt = 1; ; attempt++) {
          try {
            return await igAttempt(url, path);
          } catch (err) {
            if (!err.transient || attempt > IG_MAX_RETRIES) throw err;   // exhausted or non-transient
            // Backoff = max(exponential floor, provider Retry-After). Never sleep an unbounded
            // provider delay: if honoring it would blow the small backoff budget, fail fast now and
            // let the surfaced Retry-After tell the client when to come back.
            const floor = IG_BACKOFF_BASE_MS * 2 ** (attempt - 1);
            const wait = err.retryAfter != null ? Math.max(floor, err.retryAfter * 1000) : floor;
            if (backoffSpent + wait > IG_BACKOFF_BUDGET_MS) throw err;
            backoffSpent += wait;
            logFn('warn', 'ig_fetch_retry', {
              path, attempt, upstreamStatus: err.upstreamStatus, code: err.graph && err.graph.code, wait,
            });
            await doSleep(wait);
          }
        }
      })();
      igInflight.set(url, flight);
      // side chain only clears the map; swallow its rejection (callers hold the original promise)
      flight.finally(() => igInflight.delete(url)).catch(() => {});
    }
    return flight;
  }

  // Long-lived IG tokens live ~60 days and can be refreshed once ≥24h old. Refresh opportunistically
  // on read when within 10 days of expiry (and not already dead): the fresh 60-day token is
  // re-encrypted and persisted. Any failure is swallowed — the current token is returned so the
  // request never breaks; a truly-expired token surfaces as a Graph error → reconnect needed.
  const IG_REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
  async function refreshIgIfNeeded(channelId, token, expiresAtStr) {
    try {
      if (!expiresAtStr) return token;
      const exp = new Date(expiresAtStr).getTime();
      if (!Number.isFinite(exp)) return token;
      const now = clock();
      if (exp <= now || exp - now > IG_REFRESH_WINDOW_MS) return token;   // dead, or not due yet
      // Single-shot on purpose: token refresh is NOT idempotent-safe to retry and must bypass the
      // igFetch data-GET retry machinery. It shares only the injected fetch, never the retry loop.
      const r = await doFetch(`${IG_GRAPH}/refresh_access_token?` + new URLSearchParams({
        grant_type: 'ig_refresh_token', access_token: token }).toString());
      const j = await r.json();
      if (j && j.access_token && j.expires_in) {
        // Провал персиста — actionable (рефреш будет повторяться на каждом чтении): логируем, не глотаем.
        await db.updateIgToken(channelId, igCrypto.encrypt(j.access_token), new Date(now + j.expires_in * 1000))
          .catch((e) => log('warn', 'ig_token_persist_failed', { channelId, error: e.message }));
        return j.access_token;
      }
    } catch (e) { log('warn', 'ig_token_refresh_failed', { channelId, error: e.message }); }
    return token;
  }

  return { igFetch, refreshIgIfNeeded, IG_GRAPH };
}

module.exports = { createInstagramClient };
