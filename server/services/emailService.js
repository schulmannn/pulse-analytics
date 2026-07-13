// ═══════════════════════════════════════════════════════════════
//  Atlavue — email service (Resend + HTML-шаблоны + база ссылок)
// ═══════════════════════════════════════════════════════════════
// Фабрика email-домена (декомпозиция index.js, PR C): отправка через Resend (plain
// fetch, без новой зависимости), HTML-shell/кнопка для писем и appBase() — публичный
// origin для ссылок в письмах (anti Host-header poisoning). Без process.env/Express —
// всё из config; тела перенесены из index.js literal (поведение-preserving).

'use strict';

const { fetchWithTimeout } = require('../lib/http');

function createEmailService({ config }) {
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
      const r = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
      });
      if (!r.ok) { console.error('[email] resend', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
      return true;
    } catch (e) { console.error('[email] send error:', e.message); return false; }
  }

  const emailShell = (title, body) =>
    `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;color:#061b31"><h2 style="font-weight:600">${title}</h2>${body}</div>`;
  const emailBtn = (href, label) =>
    `<p><a href="${escHtml(href)}" style="display:inline-block;padding:10px 18px;background:#533afd;color:#fff;border-radius:6px;text-decoration:none">${label}</a></p>`;

  // configured: рассылка отчётов возможна только с почтовым провайдером (dev-заглушка
  // sendEmail вернула бы true и last_sent_at проставился бы без единого письма).
  const configured = () => !!RESEND_API_KEY;

  return { sendEmail, emailShell, emailBtn, appBase, escHtml, configured };
}

module.exports = { createEmailService };
