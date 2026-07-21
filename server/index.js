'use strict';

// quiet: dotenv 17 печатает баннер-подсказку при каждом config() — в прод-логах это шум.
require('dotenv').config({ quiet: true });
const { main } = require('./main');

if (require.main === module) {
  main().catch((error) => {
    console.error('[boot] fatal:', error && error.message);
    process.exit(1);
  });
}

module.exports = { main };
