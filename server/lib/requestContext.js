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

module.exports = { runWithRequestId, getRequestId };
