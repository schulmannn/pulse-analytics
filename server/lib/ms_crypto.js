'use strict';

const { createSecretCrypto } = require('./secretCrypto');

// Зеркало ig_crypto: тот же AES-256-GCM-механизм (secretCrypto), свой ключ MS_TOKEN_KEY —
// токены МойСклада и Instagram шифруются РАЗНЫМИ ключами, ротация одного не трогает другой.
function createMsCrypto(tokenKey) {
  return createSecretCrypto({
    rawKey: tokenKey,
    missingKeyMessage: 'MS_TOKEN_KEY not set',
  });
}

module.exports = { createMsCrypto };
