'use strict';

// web → mtproto (Telethon) proxy client: the circuit-breaker-guarded fetch/post used by the TG
// routes AND the daily-ingest cron. Lifted verbatim from index.js so the proxy layer is a single
// module (the review's "heavy MTProto in the request path" starts here — this is where a future
// job/cache/status layer would wrap). The breaker itself (createBreaker) is already unit-tested in
// lib/mtprotoBreaker; this module is the thin fetch wrapper around it.

const { createBreaker } = require('./mtprotoBreaker');
const { fetchWithTimeout } = require('./http');

const DEFAULT_MTPROTO_URL = 'http://localhost:8001';
// Heavy Telethon endpoints (stats graphs, velocity, mentions) are serialized on the
// Python side and can legitimately take minutes when queued — they get a long
// deadline; everything else fails fast with the default.
const MTPROTO_TIMEOUT_MS = 12000;
const MTPROTO_TIMEOUT_STATS_MS = 60000;
const MTPROTO_TIMEOUT_HEAVY_MS = 120000;

// Стабильные коды Python-сервиса → русские сообщения дашборда: сырые snake_case-коды
// ('mtproto_session_unauthorized') раньше доезжали до UI как есть. Неизвестный detail
// проходит без изменений; исходный код сохраняется в e.code для программных веток.
const MTPROTO_ERROR_RU = {
  mtproto_timeout: 'Telegram отвечает слишком долго, попробуйте позже',
  mtproto_session_unauthorized:
    'Сессия Telegram недействительна — переподключите аккаунт',
  mtproto_unreachable: 'Сервис Telegram недоступен, попробуйте позже',
  mtproto_error: 'Ошибка на стороне Telegram, попробуйте позже',
  internal_error: 'Внутренняя ошибка источника, попробуйте позже',
  too_many_collecting: 'Слишком много одновременных сборов — повторите позже',
  token_not_configured: 'Сервис Telegram не настроен',
  mtproto_not_configured: 'Сервис Telegram не настроен',
};
const ruDetail = (detail) => (detail && MTPROTO_ERROR_RU[detail]) || detail;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryableConnErr(err) {
  return !!err && err.name === 'FetchError' && err.type !== 'request-timeout';
}

const RETRYABLE_POST_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function isRetryablePostConnectErr(err) {
  return isRetryableConnErr(err) && RETRYABLE_POST_CONNECT_CODES.has(err.code);
}

function createMtprotoClient(
  { url = DEFAULT_MTPROTO_URL, token = '' } = {},
  { breaker = createBreaker(), fetchImpl = fetchWithTimeout } = {},
) {
  const MTPROTO_URL = url || DEFAULT_MTPROTO_URL;
  const MTPROTO_TOKEN = token || '';
  const mtprotoBreaker = breaker;

  async function mtprotoFetch(
    path,
    params = {},
    timeoutMs = MTPROTO_TIMEOUT_MS,
    lane = 'live',
  ) {
    const gate = mtprotoBreaker.tryAcquire(lane);
    if (!gate.ok) {
      const e = new Error(
        gate.reason === 'open'
          ? 'Сервис Telegram недоступен, попробуйте позже'
          : 'Сервис Telegram перегружен, попробуйте позже',
      );
      e.status = 503;
      e.retryAfter = Math.ceil(gate.retryAfterMs / 1000);
      throw e;
    }

    let breakerOk = false;
    try {
      const url = new URL(MTPROTO_URL + path);
      Object.entries(params).forEach(([k, v]) =>
        url.searchParams.set(k, String(v)),
      );
      let res;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await fetchImpl(
            url.toString(),
            {
              headers: { 'x-internal-token': MTPROTO_TOKEN },
            },
            timeoutMs,
          );
          break;
        } catch (err) {
          if (isRetryableConnErr(err) && attempt < 3) {
            const backoffMs =
              (attempt === 1 ? 150 : 400) + Math.floor(Math.random() * 100);
            await sleep(backoffMs);
            continue;
          }
          const e = new Error('Сервис Telegram недоступен, попробуйте позже');
          e.status = 503;
          throw e;
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        if (res.status === 429) {
          // Telethon FloodWait mapped by the Python side: an expected throttle, not an
          // outage. Surface as 503-with-message so the dashboard shows "retry later".
          const e = new Error(
            'Telegram временно ограничил запросы' +
              (err.retry_after != null
                ? ` — повтори через ~${err.retry_after} с`
                : ''),
          );
          e.status = 503;
          e.floodWait = true;
          if (err.retry_after != null) e.retryAfter = err.retry_after;
          throw e;
        }
        const e = new Error(
          ruDetail(err.detail) || `MTProto error ${res.status}`,
        );
        e.code = err.detail || undefined;
        e.status = res.status >= 500 ? 503 : res.status;
        if (err.retry_after != null) e.retryAfter = err.retry_after;
        throw e;
      }
      const data = await res.json();
      breakerOk = true;
      return data;
    } catch (err) {
      breakerOk = !(err && err.status === 503 && !err.floodWait);
      throw err;
    } finally {
      mtprotoBreaker.onSettled(breakerOk, lane, gate);
    }
  }

  // POST variant for the QR-login handshake (start/poll/password/cancel) and background
  // /qr/collect. `lane` defaults to 'live' so callers that omit it stay backward-compatible.
  async function mtprotoPost(
    path,
    {
      params = {},
      body = undefined,
      timeoutMs = MTPROTO_TIMEOUT_MS,
      retryConnectionErrors = false,
      lane = 'live',
    } = {},
  ) {
    const gate = mtprotoBreaker.tryAcquire(lane);
    if (!gate.ok) {
      const e = new Error(
        gate.reason === 'open'
          ? 'Сервис Telegram недоступен, попробуйте позже'
          : 'Сервис Telegram перегружен, попробуйте позже',
      );
      e.status = 503;
      e.retryAfter = Math.ceil(gate.retryAfterMs / 1000);
      throw e;
    }

    let breakerOk = false;
    try {
      const url = new URL(MTPROTO_URL + path);
      Object.entries(params).forEach(([k, v]) =>
        url.searchParams.set(k, String(v)),
      );
      let res;
      const maxAttempts = retryConnectionErrors ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          res = await fetchImpl(
            url.toString(),
            {
              method: 'POST',
              headers: {
                'x-internal-token': MTPROTO_TOKEN,
                ...(body ? { 'content-type': 'application/json' } : {}),
              },
              body: body ? JSON.stringify(body) : undefined,
            },
            timeoutMs,
          );
          break;
        } catch (err) {
          // Opt-in and connection-establishment failures only. Timeouts and resets are ambiguous:
          // the service may already have completed the POST, so they must never be repeated here.
          if (isRetryablePostConnectErr(err) && attempt < maxAttempts) {
            const backoffMs =
              (attempt === 1 ? 150 : 400) + Math.floor(Math.random() * 100);
            await sleep(backoffMs);
            continue;
          }
          const e = new Error('Сервис Telegram недоступен, попробуйте позже');
          e.status = 503;
          throw e;
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        if (res.status === 429) {
          const e = new Error(
            'Telegram временно ограничил запросы' +
              (err.retry_after != null
                ? ` — повтори через ~${err.retry_after} с`
                : ''),
          );
          e.status = 503;
          e.floodWait = true;
          if (err.retry_after != null) e.retryAfter = err.retry_after;
          throw e;
        }
        const e = new Error(
          ruDetail(err.detail) || `MTProto error ${res.status}`,
        );
        e.code = err.detail || undefined;
        e.status = res.status >= 500 ? 503 : res.status;
        if (err.retry_after != null) e.retryAfter = err.retry_after;
        throw e;
      }
      const data = await res.json();
      breakerOk = true;
      return data;
    } catch (err) {
      breakerOk = !(err && err.status === 503 && !err.floodWait);
      throw err;
    } finally {
      mtprotoBreaker.onSettled(breakerOk, lane, gate);
    }
  }

  function sendMtprotoError(res, err) {
    const status = err && err.status ? err.status : 503;
    if (err && err.retryAfter != null)
      res.set('Retry-After', String(err.retryAfter));
    return res.status(status).json({
      error: (err && err.message) || 'Источник недоступен',
      ...(err && err.retryAfter != null ? { retry_after: err.retryAfter } : {}),
    });
  }

  return Object.freeze({
    MTPROTO_URL,
    MTPROTO_TOKEN,
    MTPROTO_TIMEOUT_MS,
    MTPROTO_TIMEOUT_STATS_MS,
    MTPROTO_TIMEOUT_HEAVY_MS,
    mtprotoBreaker,
    mtprotoFetch,
    mtprotoPost,
    sendMtprotoError,
  });
}

module.exports = {
  createMtprotoClient,
  MTPROTO_TIMEOUT_MS,
  MTPROTO_TIMEOUT_STATS_MS,
  MTPROTO_TIMEOUT_HEAVY_MS,
};
