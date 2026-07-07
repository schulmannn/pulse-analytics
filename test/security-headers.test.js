const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APP_ALLOWED_DOMAINS,
  appCspHeader,
  legacyCspHeader,
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
  assert.strictEqual(csp.get('script-src'), `'self' ${APP_ALLOWED_DOMAINS.script.join(' ')}`);
  assert.strictEqual(csp.get('connect-src'), `'self' ${APP_ALLOWED_DOMAINS.connect.join(' ')}`);
  assert.strictEqual(csp.get('frame-src'), APP_ALLOWED_DOMAINS.frame.join(' '));
  assert.match(csp.get('style-src'), /'self'/);
  assert.match(csp.get('style-src'), /'unsafe-inline'/);
  assert.match(csp.get('style-src'), /https:\/\/fonts\.googleapis\.com/);

  assert.doesNotMatch(appCspHeader, /\*/);
  assert.doesNotMatch(csp.get('script-src'), /'unsafe-inline'|'unsafe-eval'/);
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

test('legacy nonce shell keeps inline scripts nonce-bound under the same security envelope', () => {
  const csp = legacyCspHeader('test-nonce');
  const parsed = directives(csp);
  const res = responseRecorder();
  setHtmlSecurityHeaders(request({ 'x-forwarded-proto': 'https' }), res, csp);

  assert.strictEqual(parsed.get('script-src'), "'self' 'nonce-test-nonce'");
  assert.strictEqual(parsed.get('frame-ancestors'), "'none'");
  assert.doesNotMatch(parsed.get('script-src'), /'unsafe-inline'|'unsafe-eval'/);
  assert.strictEqual(res.get('content-security-policy'), csp);
  assert.strictEqual(res.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.get('permissions-policy'), permissionsPolicy);
  assert.strictEqual(res.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});
