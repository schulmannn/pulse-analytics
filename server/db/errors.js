'use strict';

// DB core (P2 db/core): классификация ошибок БД. Сетевые / пул / shutdown-коды и характерные
// сообщения → «БД недоступна» (маппится в 503 выше по стеку); логические ошибки → false.
// Извлечено дословно из db.js.

const DB_UNAVAILABLE_CODES = new Set([
  '53300', '57P03', '57P01', '57P02',
  '08000', '08003', '08006', '08001', '08004',
]);
const DB_UNAVAILABLE_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /Connection terminated/i,
];

function isDbUnavailable(err) {
  if (!err) return false;
  if (DB_UNAVAILABLE_CODES.has(String(err.code || ''))) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return DB_UNAVAILABLE_MESSAGES.some(re => re.test(message));
}

module.exports = { isDbUnavailable, DB_UNAVAILABLE_CODES, DB_UNAVAILABLE_MESSAGES };
