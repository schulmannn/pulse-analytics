'use strict';

const crypto = require('crypto');

const IG_THUMB_SIZE = 80;
const IG_THUMB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const IG_THUMB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IG_THUMB_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const IG_THUMB_FETCH_TIMEOUT_MS = 8000;
const IG_THUMB_MAX_REDIRECTS = 3;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

class IgThumbnailError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isAllowedIgCdnUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    return host === 'cdninstagram.com'
      || host.endsWith('.cdninstagram.com')
      || host === 'fbcdn.net'
      || host.endsWith('.fbcdn.net');
  } catch {
    return false;
  }
}

function tokenSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`atlavue:ig-thumb:v1:${payload}`)
    .digest();
}

function createIgThumbnailToken(sourceUrl, secret, {
  now = Date.now(),
  ttlMs = IG_THUMB_TOKEN_TTL_MS,
} = {}) {
  if (!secret || !isAllowedIgCdnUrl(sourceUrl)) return null;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    u: sourceUrl,
    e: Math.floor(now + ttlMs),
  })).toString('base64url');
  const signature = tokenSignature(payload, secret).toString('base64url');
  return `${payload}.${signature}`;
}

function verifyIgThumbnailToken(token, secret, { now = Date.now() } = {}) {
  if (!secret || typeof token !== 'string' || token.length < 10 || token.length > 12_000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, rawSignature] = parts;
  let supplied;
  try {
    supplied = Buffer.from(rawSignature, 'base64url');
  } catch {
    return null;
  }
  const expected = tokenSignature(payload, secret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed?.v !== 1 || typeof parsed.u !== 'string' || !Number.isSafeInteger(parsed.e)) return null;
  if (parsed.e <= now || parsed.e > now + (2 * IG_THUMB_TOKEN_TTL_MS)) return null;
  return isAllowedIgCdnUrl(parsed.u) ? parsed.u : null;
}

function igThumbnailPath(sourceUrl, secret, options) {
  const token = createIgThumbnailToken(sourceUrl, secret, options);
  return token ? `/api/ig/thumb?t=${encodeURIComponent(token)}` : null;
}

function igThumbnailCacheKey(sourceUrl) {
  const digest = crypto.createHash('sha256').update(sourceUrl).digest('base64url');
  return `ig:thumb:v1:${digest}`;
}

async function readBoundedBody(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new IgThumbnailError('ig_thumb_too_large');
  }

  if (response.body?.getReader) {
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new IgThumbnailError('ig_thumb_too_large');
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, total);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new IgThumbnailError('ig_thumb_too_large');
  return buffer;
}

async function downloadIgThumbnailSource(fetchImpl, sourceUrl, {
  maxBytes = IG_THUMB_MAX_SOURCE_BYTES,
  timeoutMs = IG_THUMB_FETCH_TIMEOUT_MS,
  maxRedirects = IG_THUMB_MAX_REDIRECTS,
} = {}) {
  let currentUrl = sourceUrl;
  const signal = AbortSignal.timeout(timeoutMs);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (!isAllowedIgCdnUrl(currentUrl)) throw new IgThumbnailError('ig_thumb_unsafe_url');
    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal,
      headers: { Accept: 'image/jpeg,image/webp,image/png' },
    }, timeoutMs);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel?.().catch(() => {});
      if (redirect === maxRedirects) throw new IgThumbnailError('ig_thumb_redirect_limit');
      const location = response.headers?.get?.('location');
      if (!location) throw new IgThumbnailError('ig_thumb_bad_redirect');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new IgThumbnailError('ig_thumb_upstream_failed');
    }

    const contentType = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel?.().catch(() => {});
      throw new IgThumbnailError('ig_thumb_bad_type');
    }
    const body = await readBoundedBody(response, maxBytes);
    if (!body.length) throw new IgThumbnailError('ig_thumb_empty');
    return body;
  }
  throw new IgThumbnailError('ig_thumb_redirect_limit');
}

async function resizeIgThumbnail(source) {
  // Lazy loading keeps app boot resilient if a platform-specific optional binary is unavailable.
  const sharp = require('sharp');
  return sharp(source, {
    animated: false,
    failOn: 'error',
    limitInputPixels: 16_000_000,
  })
    .rotate()
    .resize(IG_THUMB_SIZE, IG_THUMB_SIZE, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

function safeIgThumbnailErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && code.startsWith('ig_thumb_') ? code : 'ig_thumb_failed';
}

module.exports = {
  IG_THUMB_SIZE,
  IG_THUMB_TOKEN_TTL_MS,
  IG_THUMB_CACHE_TTL_MS,
  IG_THUMB_MAX_SOURCE_BYTES,
  IgThumbnailError,
  isAllowedIgCdnUrl,
  createIgThumbnailToken,
  verifyIgThumbnailToken,
  igThumbnailPath,
  igThumbnailCacheKey,
  downloadIgThumbnailSource,
  resizeIgThumbnail,
  safeIgThumbnailErrorCode,
};
