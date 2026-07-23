'use strict';

// ── Яндекс.Метрика (Reporting/Management API) — единственная точка исходящих вызовов ────────
// Зеркалит lib/msClient по духу и контракту (заголовок OAuth, один ретрай на всплеск квоты),
// но с двумя надстройками, которых у МС-путей нет и которые Метрике объективно нужны:
//   • ГЕЙТ ПАРАЛЛЕЛИЗМА: документация Метрики ограничивает аккаунт 3 одновременными запросами.
//     Холодный /metrika монтирует summary/sources/goals/utm/pages разом — легко выходит за 3.
//     Здесь один процессный семафор (по умолчанию 3) держит число ФИЗИЧЕСКИХ исходящих запросов
//     в рамках квоты. Безопасный глобальный потолок 3 предпочтительнее его нарушения.
//   • SINGLEFLIGHT: одинаковые (identity токена + path) GET-ы, вылетевшие одновременно, делят
//     ОДИН физический запрос; запись чистится на settle. Дублей у холодного маунта хватает
//     (одна и та же карточка в разных местах), а отчёты идемпотентны.
// Правила Метрики:
//   • Authorization: OAuth <token> (не Bearer!);
//   • 429 (rate) — РОВНО одна повторная попытка (Retry-After уважаем, иначе консервативная
//     секунда); 420 (quota BLOCK) — задокументированная блокировка на МИНУТЫ: НЕ ретраим,
//     пробрасываем с безопасной quota-меткой, роут превращает её в 503 + Retry-After;
//   • сэмплирование гасим на вызывающей стороне параметром accuracy=full.
// Токен живёт ТОЛЬКО в заголовке запроса. В URL, сообщениях ошибок, логах и ключах кэша/
// singleflight его нет по построению: для scoping берём стабильный ДАЙДЖЕСТ токена, не сам токен.

const crypto = require('crypto');
const { fetchWithTimeout } = require('./http');

const YM_BASE = 'https://api-metrika.yandex.net';
// 429 без Retry-After: короткая консервативная пауза (окно всплеска короткое, секунды достаточно).
const YM_RETRY_PAUSE_MS = 1000;
// Верхний предел ожидания Retry-After: запрос пользователя не должен висеть дольше — общий дедлайн
// fetchWithTimeout и так ~12с, а ретрай тут ровно один.
const YM_RETRY_AFTER_CAP_MS = 5000;
// Документированный потолок одновременных запросов Метрики на аккаунт.
const YM_MAX_CONCURRENCY = 3;

// Стабильная короткая identity токена для ключей singleflight — БЕЗ хранения plaintext-токена.
function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

// Retry-After ответа (секунды ИЛИ HTTP-дата) → миллисекунды. Здесь значение НЕ кэпается:
// для 429 cap применяется только к внутреннему ожиданию, а для 420 роут должен получить
// исходную длинную паузу и честно передать её клиенту.
function parseRetryAfter(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (raw == null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

// Счётный семафор: не более `max` одновременных держателей. release() отдаёт слот ждущему,
// если он есть (active не трогаем — слот просто переходит), иначе освобождает его.
function createGate(max) {
  let active = 0;
  const waiters = [];
  function acquire() {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }
  return { acquire, release };
}

// fetchImpl/log инъектируются для детерминированных unit-тестов; дефолты — прод-поведение
// (fetchWithTimeout из lib/http — тот же жёсткий дедлайн, что у IG/МС-путей). maxConcurrency
// оставлен параметром для теста гейта; прод берёт документированные 3.
function createYmClient({ fetchImpl, log, sleepImpl, maxConcurrency = YM_MAX_CONCURRENCY } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const logFn = log || (() => {});
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const gate = createGate(Math.max(1, maxConcurrency));
  const inflight = new Map(); // singleflight: `<digest>:<path>` → in-flight Promise

  // Одна HTTP-попытка ПОД ГЕЙТОМ. 2xx → распарсенный JSON; всё остальное — throw Error с
  // безопасными полями { status, message }: message несёт максимум краткий upstream-текст
  // (тела ошибок токена не содержат). Слот держится на всё время запроса И чтения тела —
  // так одновременных сокетов к Метрике не больше `max`.
  async function attempt(token, path) {
    await gate.acquire();
    try {
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
      // Квота-сигналы: 429 (rate) и 420 (documented BLOCK). Обоим вешаем безопасную метку
      // quota + распарсенный Retry-After для роута; ТОКЕНА в метке нет (он только в заголовке).
      if (status === 429 || status === 420) {
        err.quota = true;
        const retryMs = parseRetryAfter(res);
        if (retryMs != null) err.retryAfterMs = retryMs;
      }
      throw err;
    } finally {
      gate.release();
    }
  }

  // Ретрай-политика: РОВНО одна повторная попытка и ТОЛЬКО на 429. 420 — задокументированная
  // блокировка квоты на минуты: мгновенный повтор жжёт попытку зря и долбит блокировку, поэтому
  // пробрасываем как есть (роут отдаст 503 + разумный Retry-After).
  async function runWithRetry(token, path) {
    try {
      return await attempt(token, path);
    } catch (e) {
      if (!e || e.status !== 429) throw e;
      const waitMs = e.retryAfterMs != null
        ? Math.min(YM_RETRY_AFTER_CAP_MS, e.retryAfterMs)
        : YM_RETRY_PAUSE_MS;
      logFn('warn', 'ym_fetch_retry', { path, waitMs });
      await sleep(waitMs);
      return attempt(token, path);
    }
  }

  // GET base+path со singleflight: одинаковые одновременные запросы делят одну цепочку (включая
  // её внутренний ретрай). Запись чистится на settle — следующий такой же вызов сходит заново.
  // Ключ — по ДАЙДЖЕСТУ токена, plaintext-токен в Map не попадает.
  function ymFetch(token, path) {
    const key = `${tokenDigest(token)}:${path}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = runWithRetry(token, path);
    inflight.set(key, p);
    // Чистим на settle, не меняя значение/ошибку, которую видят вызывающие.
    p.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
    return p;
  }

  return { ymFetch };
}

module.exports = { createYmClient, YM_BASE, YM_MAX_CONCURRENCY };
