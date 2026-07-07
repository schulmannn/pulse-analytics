const APP_ALLOWED_DOMAINS = Object.freeze({
  script: Object.freeze(['https://accounts.google.com', 'https://apis.google.com']),
  style: Object.freeze(['https://fonts.googleapis.com']),
  font: Object.freeze(['https://fonts.gstatic.com']),
  connect: Object.freeze(['https://accounts.google.com']),
  frame: Object.freeze(['https://accounts.google.com']),
});

const permissionsPolicy = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

const baseCspDirectives = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
];

const legacyCspHeader = (nonce) => [
  ...baseCspDirectives,
  `script-src 'self' 'nonce-${nonce}'`,
  `style-src 'self' 'unsafe-inline' ${APP_ALLOWED_DOMAINS.style.join(' ')}`,
  `font-src ${APP_ALLOWED_DOMAINS.font.join(' ')}`,
  "img-src 'self' data: https:",
  "connect-src 'self'",
].join('; ');

const appCspHeader = [
  ...baseCspDirectives,
  `script-src 'self' ${APP_ALLOWED_DOMAINS.script.join(' ')}`,
  `style-src 'self' 'unsafe-inline' ${APP_ALLOWED_DOMAINS.style.join(' ')}`,
  `font-src ${APP_ALLOWED_DOMAINS.font.join(' ')}`,
  "img-src 'self' data: https:",
  `connect-src 'self' ${APP_ALLOWED_DOMAINS.connect.join(' ')}`,
  `frame-src ${APP_ALLOWED_DOMAINS.frame.join(' ')}`,
].join('; ');

function shouldSendHsts(req) {
  return Boolean(req.secure || req.get('x-forwarded-proto') === 'https');
}

function setHtmlSecurityHeaders(req, res, csp) {
  res.set('Content-Security-Policy', csp)
    .set('X-Content-Type-Options', 'nosniff')
    .set('X-Frame-Options', 'DENY')
    .set('Referrer-Policy', 'no-referrer')
    .set('Permissions-Policy', permissionsPolicy);
  // HSTS only over TLS (Railway terminates it upstream; trust-proxy makes req.secure
  // honest). Never on plain-HTTP local dev, where browsers may pin localhost to https.
  if (shouldSendHsts(req)) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return res;
}

function setAppHeaders(req, res) {
  return setHtmlSecurityHeaders(req, res, appCspHeader);
}

module.exports = {
  APP_ALLOWED_DOMAINS,
  appCspHeader,
  legacyCspHeader,
  permissionsPolicy,
  setAppHeaders,
  setHtmlSecurityHeaders,
  shouldSendHsts,
};
