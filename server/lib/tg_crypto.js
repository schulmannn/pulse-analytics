'use strict';

const { createSecretCrypto } = require('./secretCrypto');

function createTgCrypto(sessionKey) {
  return createSecretCrypto({
    rawKey: sessionKey,
    missingKeyMessage: 'TG_SESSION_KEY not set',
  });
}

module.exports = { createTgCrypto };
