'use strict';

const { createSecretCrypto } = require('./secretCrypto');

function createIgCrypto(tokenKey) {
  return createSecretCrypto({
    rawKey: tokenKey,
    missingKeyMessage: 'IG_TOKEN_KEY not set',
  });
}

module.exports = { createIgCrypto };
