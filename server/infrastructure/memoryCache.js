// ═══════════════════════════════════════════════════════════════
//  Atlavue — in-memory кэш ответов (infrastructure)
// ═══════════════════════════════════════════════════════════════
// Бывший cache-блок index.js (PR E), тела literal. Интерфейс повторяет прежние
// договорённости app.js: `cache.size` (свойство-геттер, как у Map) и `cache.clear()`.
// Свип-интервал НЕ стартует при создании — main.js зовёт start() после listen и stop()
// на остановке (createApp таймеров не создаёт; unref — свип не держит процесс в тестах).

'use strict';

function createMemoryCache({ ttlMs = 10 * 60 * 1000, maxEntries = 500, sweepMs = 60 * 1000 } = {}) {
  const cache = new Map();
  let sweepTimer = null;

  function get(key) {
    const entry = cache.get(key);
    if (!entry || entry.expires < Date.now()) { cache.delete(key); return null; }
    return entry.data;
  }
  function set(key, data, ttl = ttlMs) {
    // Bounded: the key space (per-channel × per-param) is otherwise unbounded and
    // grows into a slow memory leak. Evict the oldest entry (insertion order ≈ age).
    if (!cache.has(key) && cache.size >= maxEntries) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, { data, expires: Date.now() + ttl });
  }
  // Expired entries used to be reaped only on re-read, so one-off keys lingered for
  // the process lifetime.
  function start() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of cache) if (entry.expires < now) cache.delete(key);
    }, sweepMs);
    sweepTimer.unref();
  }
  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  return {
    get, set, start, stop,
    clear: () => cache.clear(),
    get size() { return cache.size; },
  };
}

module.exports = { createMemoryCache };
