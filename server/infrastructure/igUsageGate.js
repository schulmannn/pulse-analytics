// ═══════════════════════════════════════════════════════════════
//  Atlavue — общий app-level usage-gate для Instagram Graph (infrastructure)
// ═══════════════════════════════════════════════════════════════
// Единый numeric-only тормоз на уровне ПРИЛОЖЕНИЯ. Instagram/Graph отдаёт квоту в заголовках
// X-App-Usage (app-level, проценты) и X-Business-Use-Case-Usage (per-BUC, проценты + мин. до
// восстановления). Клиент скармливает сюда РАЗОБРАННЫЕ заголовки и с успешных, и с ошибочных
// data GET'ов; gate удерживает ТОЛЬКО числовые максимумы и таймстемпы — никаких токенов, URL,
// сырых объектов заголовков, business id, identity аккаунта или пользовательских данных.
//
// Жёсткая остановка (открытие глобального app-gate) наступает ТОЛЬКО при задокументированном
// app-level сигнале: app usage >= 100, Graph app-rate код 4, либо app-scoped 429 с Retry-After
// (429, атрибутированный app-уровню, продлевает паузу его Retry-After). Никакого мягкого порога
// ниже 100. Неизвестные/user/page лимиты (код 17/32 без app-usage=100) глобальный gate НЕ
// открывают — они остаются заботой отдельного аккаунта.
//
// Состояние истекает через probeIntervalMs (если явный Retry-After не длиннее), чтобы следующий
// recovery-проход мог сделать ограниченный «пробный» вызов и переоценить квоту. Битые заголовки
// fail-open: observe никогда не бросает.

'use strict';

const DEFAULT_PROBE_MS = 900_000;   // 15 мин — совпадает с дефолтом COLLECTION_RECOVERY_INTERVAL_MS

// App-level throttling документирован на 100% по любому из полей X-App-Usage.
const APP_USAGE_CAP = 100;
// Graph код 4 = application request limit reached (app-level). Коды 17/32 = user/page — НЕ app-level.
const GRAPH_APP_RATE_CODE = 4;

// Числовые поля-проценты (0..100). estimated_time_to_regain_access и прочие НЕ проценты и в
// «usage %» максимум не входят — иначе минуты восстановления исказили бы порог.
const USAGE_PCT_FIELDS = ['call_count', 'total_cputime', 'total_time'];

// Максимум процент-полей плоского объекта X-App-Usage. Битый/непонятный вход → 0 (fail-open).
function maxAppUsage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let m = 0;
  for (const field of USAGE_PCT_FIELDS) {
    const n = Number(obj[field]);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

// Максимум процент-полей X-Business-Use-Case-Usage: { <bizid>: [ { call_count, ... } ] }. Читаем
// только числовые проценты вложенных записей; business id и прочие ключи НЕ удерживаются.
function maxBucUsage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let m = 0;
  for (const arr of Object.values(obj)) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      for (const field of USAGE_PCT_FIELDS) {
        const n = Number(entry[field]);
        if (Number.isFinite(n) && n > m) m = n;
      }
    }
  }
  return m;
}

// createIgUsageGate({ now, probeIntervalMs }) — now инъектируется для детерминированных тестов;
// probeIntervalMs переиспользует валидированный COLLECTION_RECOVERY_INTERVAL_MS из composition.
function createIgUsageGate({ now, probeIntervalMs } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const probeMs = Number.isFinite(probeIntervalMs) && probeIntervalMs > 0
    ? Math.floor(probeIntervalMs) : DEFAULT_PROBE_MS;

  // ── Единственное удерживаемое состояние — всё числовое ────────────────────────────────────────
  let stoppedUntilMs = 0;       // wall-clock ms, до которого app-gate открыт (стоп). 0 = закрыт.
  let lastAppUsagePct = 0;      // последний наблюдённый app-usage максимум (%)
  let lastBucUsagePct = 0;      // последний наблюдённый BUC максимум (%)
  let lastObservedMs = 0;       // таймстемп последнего observe

  function remainingMs() {
    const r = stoppedUntilMs - clock();
    return r > 0 ? r : 0;
  }

  // Наблюдаем разобранные заголовки + Graph-код + Retry-After. Никогда не бросает (fail-open):
  // ошибка внутри наблюдения не должна ронять сам data GET.
  //   obs = { appUsage, businessUseCaseUsage, graphCode, retryAfterSeconds, status }
  function observe(obs) {
    try {
      if (!obs || typeof obs !== 'object') return;
      const appMax = maxAppUsage(obs.appUsage);
      const bucMax = maxBucUsage(obs.businessUseCaseUsage);
      const graphCode = Number.isFinite(Number(obs.graphCode)) ? Number(obs.graphCode) : null;
      const retryAfter = Number.isFinite(Number(obs.retryAfterSeconds)) && Number(obs.retryAfterSeconds) >= 0
        ? Math.ceil(Number(obs.retryAfterSeconds)) : null;
      const status = Number.isFinite(Number(obs.status)) ? Number(obs.status) : null;

      const t = clock();
      lastObservedMs = t;
      lastAppUsagePct = appMax;
      lastBucUsagePct = bucMax;

      // App-level свидетельство: задокументированный app usage >= 100 ИЛИ Graph app-rate код 4.
      const appCapped = appMax >= APP_USAGE_CAP;
      const appRateCode = graphCode === GRAPH_APP_RATE_CODE;
      if (!appCapped && !appRateCode) return;   // user/page/unknown → глобальный gate не трогаем

      // Пауза = max(probe-интервал, явный Retry-After app-scoped 429). Никакого порога ниже 100.
      const retryMs = (status === 429 && retryAfter != null) ? retryAfter * 1000 : 0;
      const until = t + Math.max(probeMs, retryMs);
      if (until > stoppedUntilMs) stoppedUntilMs = until;   // берём самое позднее восстановление
    } catch {
      /* fail-open: observe никогда не бросает */
    }
  }

  // true, пока app-gate открыт. Фоновый проход обязан остановиться до claim'а следующего аккаунта.
  function shouldStopPass() {
    return remainingMs() > 0;
  }

  // Оставшиеся секунды паузы (для bounded retryAfter синтетической throttle-ошибки клиента).
  function remainingSeconds() {
    return Math.ceil(remainingMs() / 1000);
  }

  // Только для тестов: полностью числовой снимок состояния (без identity/токенов/сырых заголовков).
  function _snapshot() {
    return {
      stoppedUntilMs,
      remainingMs: remainingMs(),
      lastAppUsagePct,
      lastBucUsagePct,
      lastObservedMs,
      probeIntervalMs: probeMs,
    };
  }

  return { observe, shouldStopPass, remainingSeconds, _snapshot };
}

module.exports = { createIgUsageGate };
