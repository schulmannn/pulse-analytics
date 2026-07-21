'use strict';

// ── МойСклад JSON API 1.2 — единственная точка исходящих вызовов ────────────────
// По духу зеркалит infrastructure/instagramClient, но сознательно проще: у МойСклада
// нет нужды в singleflight (складов на аккаунт единицы, кэш 10 мин живёт выше по стеку)
// и нет token-refresh (токен долгоживущий). Правила, проверенные живым ключом:
//   • Authorization: Bearer + ОБЯЗАТЕЛЬНЫЙ Accept-Encoding: gzip — без него МС отвечает
//     HTTP 415 (fetch/undici распаковывает gzip сам, руками ничего делать не надо);
//   • лимит 45 запросов / 3 секунды: на 429 приходит заголовок X-Lognex-Retry-After
//     (секунды) — делаем РОВНО одну повторную попытку, ожидание кэпим 5 секундами;
//   • суммы приходят В КОПЕЙКАХ — наружу отдаём рубли через kopecksToRub.
// Токен живёт ТОЛЬКО в заголовке запроса: в URL, сообщениях ошибок и логах его нет
// по построению — логируем только path/статус.

const { fetchWithTimeout } = require('./http');

const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const MS_RETRY_AFTER_CAP_MS = 5000;
// 429 без Retry-After-заголовка: короткая консервативная пауза вместо мгновенного
// повтора (окно лимита у МС — 3 секунды, 1с достаточно, чтобы не сжечь попытку зря).
const MS_RETRY_AFTER_DEFAULT_MS = 1000;

// Копейки → рубли. null-safe: null/undefined/не-число → null («нет данных» ≠ «0 ₽»).
function kopecksToRub(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
}

// fetchImpl/log инъектируются для детерминированных unit-тестов; дефолты — прод-поведение
// (fetchWithTimeout из lib/http — тот же жёсткий дедлайн, что у IG/OAuth-путей).
function createMsClient({ fetchImpl, log } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const logFn = log || (() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Одна HTTP-попытка. 2xx → распарсенный JSON; всё остальное — throw Error с безопасными
  // полями { status, message }: message несёт максимум краткий upstream-текст ошибки МС
  // (тело ошибки токена не содержит — токен только в заголовке запроса).
  async function attempt(token, path) {
    let res;
    try {
      res = await doFetch(`${MS_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Encoding': 'gzip',
        },
      });
    } catch (netErr) {
      // Таймаут/обрыв сокета: сырое сообщение сети не пробрасываем (держим форму ошибок
      // единообразной и краткой), сохраняем только безопасный код причины.
      const err = new Error('МойСклад: сетевая ошибка или таймаут');
      err.status = 503;
      err.causeCode = (netErr && (netErr.code || netErr.type || netErr.name)) || 'network_error';
      throw err;
    }
    const status = Number(res.status) || 0;
    if (status >= 200 && status < 300) {
      try {
        return await res.json();
      } catch {
        const err = new Error('МойСклад: некорректный JSON в ответе');
        err.status = 502;
        throw err;
      }
    }
    // Не-2xx: МС кладёт диагностику в { errors: [{ error }] } — берём первую краткую строку.
    let upstreamMsg = '';
    try {
      const body = await res.json();
      const first = body && Array.isArray(body.errors) && body.errors[0];
      if (first && typeof first.error === 'string') upstreamMsg = first.error.slice(0, 200);
    } catch { /* тело не JSON — статуса достаточно */ }
    const err = new Error(upstreamMsg ? `МойСклад: ${upstreamMsg}` : `МойСклад: HTTP ${status}`);
    err.status = status;
    if (status === 429) {
      const ra = Number(res.headers && res.headers.get && res.headers.get('x-lognex-retry-after'));
      if (Number.isFinite(ra) && ra >= 0) err.retryAfter = ra;   // секунды — отдаём вызывающему
    }
    throw err;
  }

  // GET base+path. Ретрай-политика: РОВНО одна повторная попытка и только на 429 —
  // идемпотентные read-отчёты переживают всплеск лимита 45/3с, не умножая нагрузку.
  async function msFetch(token, path) {
    try {
      return await attempt(token, path);
    } catch (e) {
      if (!e || e.status !== 429) throw e;
      const waitMs = Math.min(
        MS_RETRY_AFTER_CAP_MS,
        e.retryAfter != null ? Math.max(0, e.retryAfter * 1000) : MS_RETRY_AFTER_DEFAULT_MS,
      );
      logFn('warn', 'ms_fetch_retry', { path, waitMs });
      await sleep(waitMs);
      return attempt(token, path);
    }
  }

  return { msFetch };
}

module.exports = { createMsClient, kopecksToRub, MS_BASE };
