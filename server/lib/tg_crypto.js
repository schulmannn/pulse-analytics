'use strict';

const { createSecretCrypto } = require('./secretCrypto');

// previousSessionKeys — optional ordered read-only keys (TG_SESSION_KEY_PREVIOUS) tried only when the
// active key can't authenticate a stored session, so a rotated-out key still decrypts existing rows.
function createTgCrypto(sessionKey, previousSessionKeys = []) {
  return createSecretCrypto({
    rawKey: sessionKey,
    previousRawKeys: previousSessionKeys,
    missingKeyMessage: 'TG_SESSION_KEY not set',
  });
}

module.exports = { createTgCrypto };
