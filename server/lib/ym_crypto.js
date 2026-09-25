'use strict';

const { createSecretCrypto } = require('./secretCrypto');

// Зеркало ms_crypto: тот же AES-256-GCM-механизм (secretCrypto), свой ключ YM_TOKEN_KEY —
// токены Яндекс.Метрики, МойСклада и Instagram шифруются РАЗНЫМИ ключами, ротация одного
// не трогает остальные.
function createYmCrypto(tokenKey) {
  return createSecretCrypto({
    rawKey: tokenKey,
    missingKeyMessage: 'YM_TOKEN_KEY not set',
  });
}

module.exports = { createYmCrypto };
