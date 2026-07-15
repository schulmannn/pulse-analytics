'use strict';

// Shared decrypt-with-lazy-rewrite for ALL four TG managed-session read paths (managed central
// collection, immediate QR refresh, nightly/recovery collection, live mention search). Decrypts the
// stored session; if a PREVIOUS (rotated-out) key had to authenticate it, best-effort re-encrypts the
// SAME plaintext under the ACTIVE key and rewrites just that row's ciphertext under the same session
// generation (db.rotateTgSessionCiphertext — generation-guarded, never bumps session_version / touches
// identity / health).
//
// The rewrite NEVER blocks or fails the already-successful decrypt: a DB throw is safe-logged and
// swallowed, and a rowCount=0 (a concurrent reconnect already replaced the row) is normal, not an
// error. Session material, ciphertext, keys and arbitrary exception text never reach a log — only
// uid, phase and a fixed safe error code.
function createTgSessionDecryptor({ tgCrypto, db, log }) {
  async function rewriteUnderActiveKey(sess, plaintext) {
    try {
      const reEnc = tgCrypto.encrypt(plaintext);
      const matched = await db.rotateTgSessionCiphertext(sess.uid, sess.session_version, reEnc);
      // rowCount=0 = a reconnect bumped the generation between read and rewrite — expected, drop it.
      if (matched) log('info', 'tg_session_key_reencrypted', { uid: sess.uid, phase: 'rewrite' });
    } catch {
      log('warn', 'tg_session_key_reencrypt_failed', {
        uid: sess.uid,
        phase: 'rewrite',
        error: 'write_failed',
      });
    }
  }

  // Returns the plaintext session. Throws exactly what tgCrypto.decryptDetailed throws when NO key
  // (active or previous) authenticates — callers keep today's failure semantics. A previous-key
  // success returns plaintext normally (no reauth): the rewrite is a side-effect only.
  async function decryptTgSession(sess) {
    const { plaintext, usedPreviousKey } = tgCrypto.decryptDetailed(sess.session_enc);
    if (usedPreviousKey) await rewriteUnderActiveKey(sess, plaintext);
    return plaintext;
  }

  return { decryptTgSession };
}

module.exports = { createTgSessionDecryptor };
