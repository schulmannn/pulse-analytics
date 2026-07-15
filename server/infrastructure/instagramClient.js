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

// defaultToken = глобальный env-токен (IG_ACCESS_TOKEN): legacy-вызовы igFetch без
// 3-го аргумента продолжают работать как раньше; IG-роуты передают per-request токен.
function createInstagramClient({ db, log, igCrypto, defaultToken, inflight }) {
  // Single choke-point for all Graph data calls. `token` defaults to the global env token so any
  // legacy caller keeps working; the IG routes pass the per-request token (req.ig.token).
  // Singleflight: concurrent identical calls (two tabs, a dashboard fan-out racing the cache)
  // share ONE Graph request instead of multiplying quota burn. Keyed by the full URL — the
  // access token is part of it, so different accounts never share a flight.
  // Live и background-клиенты могут разделять один Map: Graph singleflight остаётся общим,
  // хотя персист refresh-токена у каждого клиента идёт через свой DB budget.
  const igInflight = inflight || new Map();
  function igFetch(path, params = {}, token = defaultToken) {
    params.access_token = token;
    const qs  = new URLSearchParams(params).toString();
    const url = `${IG_BASE}${path}?${qs}`;
    let flight = igInflight.get(url);
    if (!flight) {
      flight = (async () => {
        const res = await fetchWithTimeout(url);
        const json = await res.json();
        if (json.error) {
          const err = new Error(`Instagram API: ${json.error.message}`);
          err.status = 502;   // upstream failure — message is safe to surface to the dashboard
          throw err;
        }
        return json;
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
      const now = Date.now();
      if (exp <= now || exp - now > IG_REFRESH_WINDOW_MS) return token;   // dead, or not due yet
      const r = await fetchWithTimeout(`${IG_GRAPH}/refresh_access_token?` + new URLSearchParams({
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
