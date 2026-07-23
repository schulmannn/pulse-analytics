'use strict';

// ── Яндекс.Метрика (Reporting/Management API) — единственная точка исходящих вызовов ────────
// Зеркалит lib/msClient по духу и контракту: без singleflight (счётчиков на аккаунт единицы,
// кэш живёт выше по стеку) и без token-refresh (OAuth-токен Яндекса долгоживущий, ~год).
// Правила Метрики:
//   • Authorization: OAuth <token> (не Bearer!);
//   • квоты щедрые, но при 429 (quota) делаем РОВНО одну повторную попытку после короткой
//     паузы — Retry-After Метрика не шлёт, ждём консервативную секунду;
//   • сэмплирование гасим на вызывающей стороне параметром accuracy=full (клиент его не
//     навязывает: management-вызовы параметра не знают).
// Токен живёт ТОЛЬКО в заголовке запроса: в URL, сообщениях ошибок и логах его нет
// по построению — логируем только path/статус.

const { fetchWithTimeout } = require('./http');

const YM_BASE = 'https://api-metrika.yandex.net';
const YM_RETRY_PAUSE_MS = 1000;

// fetchImpl/log инъектируются для детерминированных unit-тестов; дефолты — прод-поведение
// (fetchWithTimeout из lib/http — тот же жёсткий дедлайн, что у IG/МС-путей).
function createYmClient({ fetchImpl, log } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const logFn = log || (() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Одна HTTP-попытка. 2xx → распарсенный JSON; всё остальное — throw Error с безопасными
  // полями { status, message }: message несёт максимум краткий upstream-текст ошибки Метрики
  // (тела ошибок токена не содержат — токен только в заголовке запроса).
  async function attempt(token, path) {
    let res;
    try {
      res = await doFetch(`${YM_BASE}${path}`, {
        headers: { Authorization: `OAuth ${token}` },
      });
    } catch (netErr) {
      // Таймаут/обрыв сокета: сырое сообщение сети не пробрасываем (единая краткая форма
      // ошибок), сохраняем только безопасный код причины.
      const err = new Error('Яндекс.Метрика: сетевая ошибка или таймаут');
      err.status = 503;
      err.causeCode = (netErr && (netErr.code || netErr.type || netErr.name)) || 'network_error';
      throw err;
    }
    const status = Number(res.status) || 0;
    if (status >= 200 && status < 300) {
      try {
        return await res.json();
      } catch {
        const err = new Error('Яндекс.Метрика: некорректный JSON в ответе');
        err.status = 502;
        throw err;
      }
    }
    // Не-2xx: Метрика кладёт диагностику в { message, errors: [{ error_type, message }] } —
    // берём первую краткую строку.
    let upstreamMsg = '';
    try {
      const body = await res.json();
      const first = body && Array.isArray(body.errors) && body.errors[0];
      if (first && typeof first.message === 'string' && first.message) {
        upstreamMsg = first.message.slice(0, 200);
      } else if (body && typeof body.message === 'string' && body.message) {
        upstreamMsg = body.message.slice(0, 200);
      }
    } catch { /* тело не JSON — статуса достаточно */ }
    const err = new Error(upstreamMsg ? `Яндекс.Метрика: ${upstreamMsg}` : `Яндекс.Метрика: HTTP ${status}`);
    err.status = status;
    throw err;
  }

  // GET base+path. Ретрай-политика msFetch: РОВНО одна повторная попытка и только на 429 —
  // идемпотентные read-отчёты переживают всплеск квоты, не умножая нагрузку.
  async function ymFetch(token, path) {
    try {
      return await attempt(token, path);
    } catch (e) {
      if (!e || e.status !== 429) throw e;
      logFn('warn', 'ym_fetch_retry', { path, waitMs: YM_RETRY_PAUSE_MS });
      await sleep(YM_RETRY_PAUSE_MS);
      return attempt(token, path);
    }
  }

  return { ymFetch };
}

module.exports = { createYmClient, YM_BASE };
