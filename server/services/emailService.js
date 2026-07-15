// ═══════════════════════════════════════════════════════════════
//  Atlavue — email service (Resend + HTML-шаблоны + база ссылок)
// ═══════════════════════════════════════════════════════════════
// Фабрика email-домена (декомпозиция index.js, PR C): отправка через Resend (plain
// fetch, без новой зависимости), HTML-shell/кнопка для писем и appBase() — публичный
// origin для ссылок в письмах (anti Host-header poisoning). Без чтения окружения/Express —
// всё из config; тела перенесены из index.js literal (поведение-preserving).

'use strict';

const { fetchWithTimeout } = require('../lib/http');

// ── Detailed (idempotent) send policy for scheduled reports (sendEmailDetailed only) ────────────
// The scheduled-report path needs a durable, safely-classified send: the legacy sendEmail returns a
// bare boolean and carries no Idempotency-Key, so a socket that dies AFTER Resend accepted a send is
// indistinguishable from a real failure and the next daily tick re-sends. sendEmailDetailed attaches
// the Idempotency-Key and returns a structured outcome the job can act on without ever resending a
// message that may already be out. Auth / reset / verification flows keep the boolean sendEmail.
const EMAIL_MAX_RETRIES     = 2;      // → 3 immediate attempts total, same payload + same key
const EMAIL_BACKOFF_BASE_MS = 250;    // attempt N waits base * 2^(N-1): 250ms, 500ms
const EMAIL_BACKOFF_BUDGET_MS = 1000; // hard ceiling on cumulative backoff sleep per send
// Resend caps Idempotency-Key at 256 chars; our internal keys are far shorter and invalid keys are
// rejected locally rather than truncated into a possible collision.
const EMAIL_IDEMPOTENCY_KEY_MAX = 256;

// Retry-After may be an integer number of seconds or an HTTP-date; return whole seconds (≥0) or null
// when absent/unparseable/overflowing. `nowMs` injected so the HTTP-date branch stays deterministic.
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

// Pull Resend's machine error `name` (e.g. 'concurrent_idempotent_requests', 'invalid_idempotent_request')
// out of an error body WITHOUT ever surfacing the message/full body. Resend returns the name either at
// top level ({ name, message, statusCode }) or nested under `error`; accept both, else null.
function parseResendErrorName(json) {
  if (!json || typeof json !== 'object') return null;
  const e = json.error && typeof json.error === 'object' ? json.error : json;
  if (typeof e.name !== 'string') return null;
  const name = e.name.trim();
  return /^[a-z0-9_]{1,100}$/.test(name) ? name : null;
}

function safeCauseCode(error) {
  const raw = String((error && (error.code || error.type || error.name)) || 'network_error');
  return /^[a-z0-9_-]{1,64}$/i.test(raw) ? raw : 'network_error';
}

// fetchImpl/sleep/now injected only for deterministic unit-tests; defaults are production behavior.
function createEmailService({ config, fetchImpl, sleep, now } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const doSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = now || Date.now;
  const IS_PRODUCTION = config.isProduction;
  const RESEND_API_KEY = config.email.apiKey;
  const EMAIL_FROM = config.email.from;
  const APP_URL = config.http.appUrl;
  // Canonical public origin (Atlavue rebrand) — last-resort fallback for emailed
  // links / OAuth callbacks when APP_URL is unset and the request Host isn't
  // allow-listed. Constant, not the old Railway host: a stale fallback silently
  // mints links to a domain we no longer present to users.
  const CANONICAL_ORIGIN = 'https://atlavue.app';
  // Hosts honoured from the request when APP_URL isn't set — defends emailed links
  // against Host-header poisoning (reset link → account takeover). Best practice:
  // set APP_URL in production. Override the allowlist with TRUSTED_HOSTS (comma-sep).
  const TRUSTED_HOSTS = new Set(
    (config.http.trustedHosts || new URL(CANONICAL_ORIGIN).host)
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  // In production an unset APP_URL silently falls back to CANONICAL_ORIGIN —
  // emailed verify/reset links and the IG OAuth callback then point at the
  // hardcoded default rather than the configured domain. Loud boot error,
  // deliberately NON-FATAL: a missing env var must not crash-loop prod — the
  // dashboard itself still works without it. (Печатается при создании сервиса —
  // тот же module-load момент, что и раньше.)
  if (!APP_URL && IS_PRODUCTION) {
    console.error([
      '════════════════════════════════════════════════════════════════════',
      '[boot] APP_URL is not set in a production environment!',
      '[boot] Emailed verification/reset links and the Instagram OAuth callback',
      `[boot] will fall back to "${CANONICAL_ORIGIN}".`,
      `[boot] Set APP_URL to the canonical public origin, e.g. ${CANONICAL_ORIGIN}`,
      '════════════════════════════════════════════════════════════════════',
    ].join('\n'));
  }

  const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  // Public origin for emailed links. NEVER trust a raw Host header (poisonable):
  // use APP_URL, else only an allow-listed / localhost host, else the canonical default.
  function appBase(req) {
    if (APP_URL) return APP_URL;
    const host = String((req && req.get && req.get('host')) || '').toLowerCase();
    if (TRUSTED_HOSTS.has(host)) return 'https://' + host;                        // prod → https (never reflect X-Forwarded-Proto)
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://' + host;  // local dev
    return CANONICAL_ORIGIN;                                                      // untrusted host → canonical default
  }

  // Send via Resend (plain fetch). No key → log only non-secret metadata; in DEV
  // additionally log the action link (`devLink`) so registration/reset flows are
  // completable locally without an email provider — production never prints it.
  // Never throws (auth flows stay generic on email failure).
  async function sendEmail(to, subject, html, devLink) {
    if (!RESEND_API_KEY) {
      console.log(`[email:dev] to=${to} · "${subject}" (RESEND_API_KEY unset — not sent)`);
      if (!IS_PRODUCTION && devLink) console.log(`[email:dev] action link: ${devLink}`);
      return true;
    }
    try {
      // Single-shot, no Idempotency-Key: auth/reset/verification flows keep the generic boolean
      // contract. (doFetch === fetchWithTimeout in production; injected only for deterministic tests.)
      const r = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
      });
      if (!r.ok) { console.error('[email] resend', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
      return true;
    } catch (e) { console.error('[email] send error:', e.message); return false; }
  }

  // One HTTP attempt against Resend's POST /emails with the given (stable) headers/payload. Returns a
  // safe structured classification — NEVER the recipient, HTML, API key or the raw response body:
  //   { outcome: 'sent',      providerId, status }        — 2xx, provider accepted (id if parseable);
  //   { outcome: 'retryable', status, retryAfter }        — HTTP 429, provider explicitly rejected
  //                                                          BEFORE sending (known-not-sent);
  //   { outcome: 'ambiguous', reason, status/causeCode }  — network/timeout, HTTP 5xx, or 409
  //                                                          concurrent_idempotent_requests: may or
  //                                                          may not have sent → same-key retry is safe;
  //   { outcome: 'rejected',  status, name }              — other 4xx (invalid_idempotent_request,
  //                                                          invalid key/payload/auth): permanent, no retry.
  async function resendAttempt(headers, payload) {
    let res;
    try {
      res = await doFetch('https://api.resend.com/emails', { method: 'POST', headers, body: payload });
    } catch (e) {
      // Timeout / socket failure: the request may have reached Resend → ambiguous, same-key retry safe.
      // Keep only a safe cause code — the raw message can embed the tokenized URL / payload.
      return { outcome: 'ambiguous', reason: 'network', causeCode: safeCauseCode(e) };
    }
    const status = Number(res.status) || 0;
    if (status >= 200 && status < 300) {
      let providerId = null;
      try {
        const j = await res.json();
        if (j && typeof j === 'object' && typeof j.id === 'string' && /^[a-z0-9-]{1,100}$/i.test(j.id)) {
          providerId = j.id;
        }
      } catch { /* body optional */ }
      return { outcome: 'sent', providerId, status };
    }
    let name = null;
    try { name = parseResendErrorName(await res.json()); } catch { /* malformed body — classify by status */ }
    const retryAfter = parseRetryAfterSeconds(res.headers && res.headers.get && res.headers.get('retry-after'), clock());
    if (status === 429) return { outcome: 'retryable', status, retryAfter };
    const retryMeta = retryAfter == null ? {} : { retryAfter };
    if (status >= 500) return { outcome: 'ambiguous', reason: 'http_5xx', status, ...retryMeta };
    if (status === 409 && name === 'concurrent_idempotent_requests') {
      return { outcome: 'ambiguous', reason: 'concurrent', status, ...retryMeta };
    }
    return { outcome: 'rejected', status, name };   // any other 4xx incl. invalid_idempotent_request
  }

  // Idempotent, safely-classified send for scheduled reports. Attaches a stable `Idempotency-Key`
  // (caller derives it from internal report id + period — never user text) and does at most
  // EMAIL_MAX_RETRIES immediate retries with the EXACT same payload + key, bounded 250/500ms backoff
  // under a ≤1s sleep budget. Success and permanent rejection return immediately; retryable (429) and
  // ambiguous (network/5xx/409) retry until exhausted/over-budget, then return their classification.
  // Never logs or returns the API key, recipient, HTML or full response bodies.
  async function sendEmailDetailed(to, subject, html, { idempotencyKey } = {}) {
    if (!RESEND_API_KEY) {
      // Parity with legacy sendEmail's dev branch: no provider → treat as sent so local/report flows
      // complete. The scheduled job additionally gates on configured(), so this never runs in prod.
      console.log('[email:dev] scheduled report send skipped (RESEND_API_KEY unset)');
      return { outcome: 'sent', dev: true };
    }
    const key = String(idempotencyKey || '');
    // Never retry a scheduled side effect without provider dedupe, and never truncate into a
    // collision. Report keys are internal and intentionally use only this conservative alphabet.
    if (key.length > EMAIL_IDEMPOTENCY_KEY_MAX || !/^[a-z0-9._:/-]+$/i.test(key)) {
      return { outcome: 'rejected', status: 0, name: 'invalid_idempotency_key' };
    }
    const headers = {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    };
    // Same payload string across every retry — Resend requires an identical body for a reused key.
    const payload = JSON.stringify({ from: EMAIL_FROM, to, subject, html });
    let backoffSpent = 0;
    for (let attempt = 1; ; attempt++) {
      const cls = await resendAttempt(headers, payload);
      if (cls.outcome === 'sent' || cls.outcome === 'rejected') return cls;   // terminal, no retry
      if (attempt > EMAIL_MAX_RETRIES) return cls;                            // exhausted → classify
      // Backoff = max(exponential floor, provider Retry-After). Never sleep an unbounded provider
      // delay: if honoring it would blow the small budget, stop now and return the classification.
      const floor = EMAIL_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      const wait = cls.retryAfter != null ? Math.max(floor, cls.retryAfter * 1000) : floor;
      if (backoffSpent + wait > EMAIL_BACKOFF_BUDGET_MS) return cls;
      backoffSpent += wait;
      await doSleep(wait);
    }
  }

  const emailShell = (title, body) =>
    `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;color:#061b31"><h2 style="font-weight:600">${title}</h2>${body}</div>`;
  const emailBtn = (href, label) =>
    `<p><a href="${escHtml(href)}" style="display:inline-block;padding:10px 18px;background:#533afd;color:#fff;border-radius:6px;text-decoration:none">${label}</a></p>`;

  // configured: рассылка отчётов возможна только с почтовым провайдером (dev-заглушка
  // sendEmail вернула бы true и last_sent_at проставился бы без единого письма).
  const configured = () => !!RESEND_API_KEY;

  return { sendEmail, sendEmailDetailed, emailShell, emailBtn, appBase, escHtml, configured };
}

module.exports = { createEmailService };
