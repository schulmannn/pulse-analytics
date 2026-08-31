'use strict';

const { createSecretCrypto } = require('./secretCrypto');

// Зеркало ym_crypto/ms_crypto: тот же AES-256-GCM-механизм (secretCrypto), свой ключ
// RUSENDER_KEY — API-ключи Rusender, токены Метрики, МойСклада и Instagram шифруются
// РАЗНЫМИ ключами, ротация одного не трогает остальные.
function createRusenderCrypto(tokenKey) {
  return createSecretCrypto({
    rawKey: tokenKey,
    missingKeyMessage: 'RUSENDER_KEY not set',
  });
}

module.exports = { createRusenderCrypto };
