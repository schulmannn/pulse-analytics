'use strict';

// Cache policy for the statically-served SPA bundle (frontend/dist). Vite emits content-hashed
// files under /assets/** (e.g. index-a1b2c3d4.js) — the hash changes whenever the bytes change, so
// those are safe to cache for a year as `immutable` (no revalidation round-trip ever). Everything
// else served from dist (index.html, favicon, unhashed public files) MUST stay revalidatable —
// freezing the SPA HTML for a year would strand clients on a stale build after every deploy.

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

// Only Vite's content-hashed /assets/** files are immutable. `filePath` is the resolved on-disk
// path express.static hands to setHeaders, so require both the `assets` segment and Vite's
// `name-<hash>.<ext>` filename. A manually copied unhashed file under /assets must revalidate.
function assetCacheControl(filePath) {
  return /[/\\]assets[/\\][^/\\]+-[A-Za-z0-9_-]{8,}\.[^/\\]+$/.test(String(filePath))
    ? IMMUTABLE
    : REVALIDATE;
}

module.exports = { assetCacheControl, IMMUTABLE, REVALIDATE };
