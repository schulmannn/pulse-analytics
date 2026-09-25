// script: ТОЛЬКО accounts.google.com — GIS-кнопка грузит /gsi/client оттуда. apis.google.com
// (хост старого gapi) фронт не использует нигде, а исторически он пригоден для обхода CSP
// через JSONP-эндпоинты (?callback=) — не возвращать без реальной необходимости.
const APP_ALLOWED_DOMAINS = Object.freeze({
  script: Object.freeze(['https://accounts.google.com']),
  // GIS injects its own stylesheet; fonts are bundled locally and need no Google Fonts origin.
  style: Object.freeze(['https://accounts.google.com']),
  font: Object.freeze(["'self'"]),
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

/**
 * Заголовки JSON-ответов /api/*. Отдельно от HTML-контура: у API нет документа, скриптов и
 * шрифтов, поэтому CSP приложения ему не нужен — нужен запрет MIME-sniffing.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ setAppHeaders НА ВСЁ. До этого nosniff доезжал ТОЛЬКО до
 * тех /api-путей, которые проваливались сквозь роуты в статику (то есть до 404), — ни один
 * реальный ответ API его не нёс, хотя тест на 404 и создавал впечатление, что контур закрыт
 * (I-1, аудит #554). Sniffing на JSON — не теория: ответ с пользовательской строкой в первых
 * байтах браузер может опознать как HTML и исполнить, если его удастся открыть как документ.
 * X-Frame-Options и Referrer-Policy идут тем же скупым набором: обрамлять или реферить JSON
 * незачем ни одному нашему сценарию.
 */
function setApiHeaders(_req, res) {
  return res
    .set('X-Content-Type-Options', 'nosniff')
    .set('X-Frame-Options', 'DENY')
    .set('Referrer-Policy', 'no-referrer');
}

module.exports = {
  APP_ALLOWED_DOMAINS,
  appCspHeader,
  permissionsPolicy,
  setApiHeaders,
  setAppHeaders,
  setHtmlSecurityHeaders,
  shouldSendHsts,
};
