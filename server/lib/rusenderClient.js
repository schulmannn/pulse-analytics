'use strict';

// ── Rusender (Public API v1) — единственная точка исходящих вызовов ──────────────────────────
// Зеркалит lib/ymClient по духу и контракту (гейт параллелизма + singleflight + ровно один
// ретрай на 429), с поправками на то, чем Rusender отличается от Метрики:
//   • АВТОРИЗАЦИЯ — `Authorization: Bearer <apiKey>` (в отличие от `OAuth` у Метрики).
//   • ОБОЛОЧКА ОТВЕТА — у Rusender ЕДИНАЯ форма { ok, data, meta }. Клиент разворачивает её и
//     отдаёт вызывающему `data`, а пагинацию из meta — отдельным полем: иначе каждый вызов
//     повторял бы `body.data.items` и по-своему ошибался бы на пустом ответе.
//   • ПАГИНАЦИЯ — честно неизвестна. В ответе meta есть page/limit/totalItems/totalPages, но
//     ИМЁН query-параметров ни OpenAPI-спека, ни docs не документируют. Поэтому fetchAllPages
//     шлёт общепринятые page/limit и ведёт цикл ПО ОТВЕТУ: если сервер их игнорирует и снова
//     отдаёт ту же страницу, цикл честно останавливается на первой вместо вечного кружения.
//     Мы предпочитаем недобрать страницу вечному циклу и молчаливому дублю строк.
//   • КВОТА — документирован только 429 + Retry-After, без чисел. Потолок параллелизма взят
//     консервативно (4): нарушить неизвестный лимит хуже, чем собрать чуть медленнее.
// Ключ живёт ТОЛЬКО в заголовке запроса. В URL, сообщениях ошибок, логах и ключах
// singleflight его нет по построению: для scoping берём стабильный ДАЙДЖЕСТ ключа, не сам ключ.

const crypto = require('crypto');
const { fetchWithTimeout } = require('./http');

const RUSENDER_BASE = 'https://api.rusender.ru/api';
// 429 без Retry-After: короткая консервативная пауза (окно всплеска короткое).
const RUSENDER_RETRY_PAUSE_MS = 1000;
// Верхний предел ожидания Retry-After: запрос пользователя не должен висеть дольше — общий
// дедлайн fetchWithTimeout и так ~12с, а ретрай тут ровно один.
const RUSENDER_RETRY_AFTER_CAP_MS = 5000;
// Консервативный потолок одновременных запросов: чисел квоты Rusender не публикует.
const RUSENDER_MAX_CONCURRENCY = 4;
// Размер страницы постраничных обходов и жёсткий потолок числа страниц за один обход —
// защита и от кривой пагинации, и от аккаунта-гиганта, который выжрал бы весь проход.
const RUSENDER_PAGE_LIMIT = 100;
const RUSENDER_MAX_PAGES = 20;

// Стабильная короткая identity ключа для singleflight — БЕЗ хранения plaintext-ключа.
function keyDigest(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

// Retry-After ответа (секунды ИЛИ HTTP-дата) → миллисекунды. Значение НЕ кэпается здесь:
// для 429 cap применяется только к внутреннему ожиданию, а роут должен получить исходную
// паузу и честно передать её клиенту.
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

// fetchImpl/log/sleepImpl инъектируются для детерминированных unit-тестов; дефолты — прод-
// поведение (fetchWithTimeout из lib/http — тот же жёсткий дедлайн, что у IG/МС/ЯМ-путей).
function createRusenderClient({ fetchImpl, log, sleepImpl, maxConcurrency = RUSENDER_MAX_CONCURRENCY } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  const logFn = log || (() => {});
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const gate = createGate(Math.max(1, maxConcurrency));
  const inflight = new Map(); // singleflight: `<digest>:<path>` → in-flight Promise

  // Одна HTTP-попытка ПОД ГЕЙТОМ. 2xx → { data, meta } из общей оболочки ответа; всё остальное
  // — throw Error с безопасными полями { status, message }. Слот держится на всё время запроса
  // И чтения тела — так одновременных сокетов к Rusender не больше `max`.
  async function attempt(apiKey, path) {
    await gate.acquire();
    try {
      let res;
      try {
        res = await doFetch(`${RUSENDER_BASE}${path}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        });
      } catch (netErr) {
        // Таймаут/обрыв сокета: сырое сообщение сети не пробрасываем (единая краткая форма
        // ошибок), сохраняем только безопасный код причины.
        const err = new Error('Rusender: сетевая ошибка или таймаут');
        err.status = 503;
        err.causeCode = (netErr && (netErr.code || netErr.type || netErr.name)) || 'network_error';
        throw err;
      }
      const status = Number(res.status) || 0;
      if (status >= 200 && status < 300) {
        let body;
        try {
          body = await res.json();
        } catch {
          const err = new Error('Rusender: некорректный JSON в ответе');
          err.status = 502;
          throw err;
        }
        // Единая оболочка { ok, data, meta }. Разворачиваем ЗДЕСЬ, чтобы вызывающие читали
        // предметные поля, а не переоткрывали конверт в каждом месте.
        const data = body && typeof body === 'object' && 'data' in body ? body.data : body;
        const meta = body && typeof body === 'object' && body.meta && typeof body.meta === 'object'
          ? body.meta
          : null;
        return { data, meta };
      }
      // Не-2xx: Rusender кладёт диагностику в { error: { code, message } } — берём краткую строку.
      let upstreamMsg = '';
      let upstreamCode = '';
      try {
        const body = await res.json();
        const e = body && body.error;
        if (e && typeof e.message === 'string' && e.message) upstreamMsg = e.message.slice(0, 200);
        if (e && typeof e.code === 'string' && e.code) upstreamCode = e.code.slice(0, 64);
        if (!upstreamMsg && body && typeof body.message === 'string') upstreamMsg = body.message.slice(0, 200);
      } catch { /* тело не JSON — статуса достаточно */ }
      const err = new Error(upstreamMsg ? `Rusender: ${upstreamMsg}` : `Rusender: HTTP ${status}`);
      err.status = status;
      if (upstreamCode) err.upstreamCode = upstreamCode;
      // Квота-сигнал: у Rusender документирован ровно 429 + Retry-After. Метка безопасная —
      // КЛЮЧА в ней нет (он только в заголовке).
      if (status === 429) {
        err.quota = true;
        const retryMs = parseRetryAfter(res);
        if (retryMs != null) err.retryAfterMs = retryMs;
      }
      throw err;
    } finally {
      gate.release();
    }
  }

  // Ретрай-политика: РОВНО одна повторная попытка и ТОЛЬКО на 429. Остальные коды (401/403 —
  // ключ отозван или не хватает scope, 404, 5xx) мгновенным повтором не лечатся.
  async function runWithRetry(apiKey, path) {
    try {
      return await attempt(apiKey, path);
    } catch (e) {
      if (!e || e.status !== 429) throw e;
      const waitMs = e.retryAfterMs != null
        ? Math.min(RUSENDER_RETRY_AFTER_CAP_MS, e.retryAfterMs)
        : RUSENDER_RETRY_PAUSE_MS;
      logFn('warn', 'rusender_fetch_retry', { path, waitMs });
      await sleep(waitMs);
      return attempt(apiKey, path);
    }
  }

  // GET base+path со singleflight: одинаковые одновременные запросы делят одну цепочку (включая
  // её внутренний ретрай). Запись чистится на settle. Ключ — по ДАЙДЖЕСТУ ключа, plaintext в
  // Map не попадает. Возвращает { data, meta }.
  function rusenderFetch(apiKey, path) {
    const key = `${keyDigest(apiKey)}:${path}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = runWithRetry(apiKey, path);
    inflight.set(key, p);
    p.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
    return p;
  }

  /**
   * Постраничный обход списочного эндпоинта → плоский массив items.
   *
   * Имена query-параметров пагинации у Rusender НЕ документированы (в ответе meta они есть, в
   * спеке параметров нет). Поэтому цикл ведётся ПО ОТВЕТУ и останавливается, как только
   * страница перестаёт продвигаться:
   *   • meta.totalPages сказал, что страниц больше нет → стоп (нормальный выход);
   *   • сервер вернул ту же meta.page, что и в прошлый раз → параметры проигнорированы,
   *     дальнейшие запросы вернут ТО ЖЕ САМОЕ → стоп (иначе вечный цикл и дубли строк);
   *   • пустая страница → стоп;
   *   • потолок RUSENDER_MAX_PAGES → стоп с предупреждением в лог, чтобы усечение не выглядело
   *     как «собрали всё» (канон «no silent caps»).
   */
  async function fetchAllPages(apiKey, basePath, { limit = RUSENDER_PAGE_LIMIT, maxPages = RUSENDER_MAX_PAGES } = {}) {
    const out = [];
    let seenPage = null;
    let truncated = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const sep = basePath.includes('?') ? '&' : '?';
      const { data, meta } = await rusenderFetch(apiKey, `${basePath}${sep}page=${page}&limit=${limit}`);
      const items = data && Array.isArray(data.items) ? data.items : [];
      if (!items.length) break;
      out.push(...items);
      const reported = meta && Number.isFinite(Number(meta.page)) ? Number(meta.page) : null;
      // Сервер проигнорировал `page` (та же страница, что и в прошлый раз) — дальше пойдут дубли.
      if (reported != null && reported === seenPage) break;
      seenPage = reported;
      const totalPages = meta && Number.isFinite(Number(meta.totalPages)) ? Number(meta.totalPages) : null;
      if (totalPages != null && page >= totalPages) break;
      // Страница короче запрошенного лимита — это последняя, даже если meta промолчала.
      if (items.length < limit) break;
      if (page === maxPages) truncated = true;
    }
    if (truncated) {
      logFn('warn', 'rusender_pagination_truncated', { path: basePath, maxPages, collected: out.length });
    }
    return out;
  }

  return { rusenderFetch, fetchAllPages };
}

module.exports = {
  createRusenderClient,
  RUSENDER_BASE,
  RUSENDER_MAX_CONCURRENCY,
  RUSENDER_PAGE_LIMIT,
  RUSENDER_MAX_PAGES,
};
