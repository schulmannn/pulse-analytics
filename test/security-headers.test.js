const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  APP_ALLOWED_DOMAINS,
  appCspHeader,
  permissionsPolicy,
  setAppHeaders,
  setHtmlSecurityHeaders,
  shouldSendHsts,
} = require('../server/lib/securityHeaders');

function request(headers = {}, secure = false) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    secure,
    get(name) {
      return lower[String(name).toLowerCase()];
    },
  };
}

function responseRecorder() {
  const headers = new Map();
  return {
    headers,
    set(name, value) {
      headers.set(String(name).toLowerCase(), value);
      return this;
    },
    get(name) {
      return headers.get(String(name).toLowerCase());
    },
  };
}

function directives(csp) {
  return new Map(csp.split('; ').map((part) => {
    const [name, ...values] = part.split(' ');
    return [name, values.join(' ')];
  }));
}

test('production app CSP is strict and documents the allowed external domains', () => {
  const csp = directives(appCspHeader);

  assert.strictEqual(csp.get('default-src'), "'self'");
  assert.strictEqual(csp.get('base-uri'), "'none'");
  assert.strictEqual(csp.get('object-src'), "'none'");
  assert.strictEqual(csp.get('frame-ancestors'), "'none'");
  assert.strictEqual(csp.get('img-src'), "'self' data: https:");
  assert.strictEqual(csp.get('font-src'), APP_ALLOWED_DOMAINS.font.join(' '));
  assert.match(csp.get('font-src'), /(?:^| )'self'(?: |$)/);
  assert.strictEqual(csp.get('script-src'), `'self' ${APP_ALLOWED_DOMAINS.script.join(' ')}`);
  assert.strictEqual(csp.get('connect-src'), `'self' ${APP_ALLOWED_DOMAINS.connect.join(' ')}`);
  assert.strictEqual(csp.get('frame-src'), APP_ALLOWED_DOMAINS.frame.join(' '));
  assert.match(csp.get('style-src'), /'self'/);
  assert.match(csp.get('style-src'), /'unsafe-inline'/);
  assert.match(csp.get('style-src'), /https:\/\/accounts\.google\.com/);
  assert.strictEqual(
    csp.get('style-src'),
    `'self' 'unsafe-inline' ${APP_ALLOWED_DOMAINS.style.join(' ')}`,
  );

  assert.doesNotMatch(appCspHeader, /\*/);
  assert.doesNotMatch(appCspHeader, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(csp.get('script-src'), /'unsafe-inline'|'unsafe-eval'/);
  // apis.google.com (старый gapi-хост) фронту не нужен, а как JSONP-хост он пригоден для
  // обхода CSP — регрессия-гард: script-src разрешает Google ТОЛЬКО через accounts.google.com.
  assert.doesNotMatch(csp.get('script-src'), /apis\.google\.com/);
  assert.strictEqual(csp.get('script-src'), "'self' https://accounts.google.com");
});

test('security headers cover CSP, frame denial, referrer policy and permissions policy', () => {
  const res = responseRecorder();
  setAppHeaders(request(), res);

  assert.strictEqual(res.get('content-security-policy'), appCspHeader);
  assert.strictEqual(res.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(res.get('permissions-policy'), permissionsPolicy);
  assert.match(permissionsPolicy, /camera=\(\)/);
  assert.match(permissionsPolicy, /geolocation=\(\)/);
  assert.match(permissionsPolicy, /microphone=\(\)/);
  assert.strictEqual(res.get('strict-transport-security'), undefined);
});

test('HSTS is emitted only when the request is effectively HTTPS', () => {
  assert.strictEqual(shouldSendHsts(request()), false);
  assert.strictEqual(shouldSendHsts(request({}, true)), true);
  assert.strictEqual(shouldSendHsts(request({ 'x-forwarded-proto': 'https' })), true);
  assert.strictEqual(shouldSendHsts(request({ 'x-forwarded-proto': 'http' })), false);

  const res = responseRecorder();
  setAppHeaders(request({ 'x-forwarded-proto': 'https' }), res);
  assert.strictEqual(res.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});

test('HTML приложения не тянет внешних шрифтов', () => {
  // Прежде проверялись ДВЕ страницы — приложения и nonce-оболочки. Оболочка удалена вместе со
  // своим CSP-контуром, HTML-поверхность осталась одна (аудит #554, ТЗ-6).
  const root = path.join(__dirname, '..');
  const modernHtml = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const modernStyles = fs.readFileSync(path.join(root, 'frontend/src/index.css'), 'utf8');

  assert.doesNotMatch(modernHtml, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(modernStyles, /geist-cyrillic-wght-normal\.woff2/);
  assert.match(modernStyles, /geist-latin-wght-normal\.woff2/);
  assert.doesNotMatch(modernStyles, /geist-(?:cyrillic-ext|latin-ext|vietnamese)-wght-normal\.woff2/);
});
