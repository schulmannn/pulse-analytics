'use strict';

// Сквозной request-id без прокидывания через сигнатуры: request-id middleware
// (lib/observability.requestContext) заворачивает остаток пайплайна в runWithRequestId(...),
// и любой downstream-код запроса — роуты → сервисы → mtproto-клиент — читает текущий id через
// getRequestId(). Фоновые jobs выполняются вне store, там getRequestId() отдаёт undefined и
// вызывающий код просто не шлёт заголовок.

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// Та же форма, что принимает Python-сторона (mtproto/service.py, _REQUEST_ID_RE):
// невалидный id там всё равно молча отбрасывается, поэтому наружу он не отправляется вовсе.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;

function runWithRequestId(requestId, fn) {
  return als.run({ requestId }, fn);
}

// id текущего запроса или undefined — вне request-store (jobs/boot) либо когда сохранённое
// значение не проходит валидацию формы trace-id.
function getRequestId() {
  const store = als.getStore();
  const id = store && store.requestId;
  return typeof id === 'string' && REQUEST_ID_RE.test(id) ? id : undefined;
}

// Отцепление fire-and-forget работы от request-store. Промис-цепочка, запущенная внутри
// обработчика, наследует ALS-store — и фоновый сбор (минуты работы Telethon), стартовавший
// ПОСЛЕ res.json, продолжал бы ходить в mtproto с x-request-id уже завершённого HTTP-запроса:
// JSON-логи Python атрибутировали бы минуты работы суб-секундному запросу. als.exit(...) снимает
// store для fn и всех её async-продолжений, поэтому такая работа выглядит как фоновая (как job),
// а не как хвост запроса. Логи самого вызывающего кода (до отцепления) request_id сохраняют.
function runDetached(fn) {
  return als.exit(fn);
}

module.exports = { runWithRequestId, getRequestId, runDetached };
