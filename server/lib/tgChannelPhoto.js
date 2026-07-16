'use strict';

// Shared bound/validate for the central channel's avatar (a base64 JPEG). Used on BOTH the managed
// collect persist path (bound the trusted bytes once before storing them as a top-level snapshot
// field) and the open /channel/photo proxy (re-validate before serving, since the open route must
// reject malformed / oversized data before it reaches an anonymous <img>). Keeping one validator
// means the write and read agree on exactly what a "valid avatar" is.

const CHANNEL_PHOTO_MAX_BYTES = 512 * 1024;   // matches the Python-side download bound

// Decode a base64 JPEG, returning a Buffer only when it is syntactically valid base64, decodes to a
// size-bounded blob and carries the JPEG magic (FF D8); otherwise null. A cheap length guard runs
// before decode so an absurd string can't allocate a huge Buffer.
function decodeBoundedJpegBase64(b64, maxBytes = CHANNEL_PHOTO_MAX_BYTES) {
  if (typeof b64 !== 'string' || !b64) return null;
  // 4 base64 chars per 3 bytes (+padding); reject clearly-too-long input before touching Buffer.
  if (b64.length > Math.ceil(maxBytes / 3) * 4 + 8) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 4 || buf.length > maxBytes || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

module.exports = { decodeBoundedJpegBase64, CHANNEL_PHOTO_MAX_BYTES };
