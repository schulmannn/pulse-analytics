'use strict';

require('dotenv').config();
const { main } = require('./main');

if (require.main === module) {
  main().catch((error) => {
    console.error('[boot] fatal:', error && error.message);
    process.exit(1);
  });
}

module.exports = { main };
