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
    if (!entry) return null;
    if (entry.expires < Date.now()) { cache.delete(key); return null; }
    // True LRU: a valid read promotes the entry to most-recent (delete + re-insert moves it
    // to the tail of Map insertion order) WITHOUT touching `expires` — the absolute TTL still
    // decides staleness, a hot key just isn't the next eviction victim.
    cache.delete(key);
    cache.set(key, entry);
    return entry.data;
  }
  function set(key, data, ttl = ttlMs) {
    // Bounded LRU: the key space (per-channel × per-param) is unbounded, while retained response
    // memory stays capped. An existing key is promoted (delete → re-insert at the tail),
    // so re-writing a hot entry doesn't leave it stale at the eviction front; only when adding
    // a NEW key at capacity do we evict the least-recently-used entry (Map head).
    if (cache.has(key)) {
      cache.delete(key);
    } else if (cache.size >= maxEntries) {
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
