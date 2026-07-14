const STORAGE_KEY = 'pulse_channel';
const MEMORY_KEY = 'pulse_source_channels';

/**
 * Selected-channel id, persisted in localStorage (same key style as pulse_token /
 * pulse_theme / pulse_demo). Persistence kills the bootstrap double-fetch: on reload the
 * provider starts from the stored id instead of null, so channel-scoped queries fire once
 * with the right key instead of "null-key fetch → ChannelCard sets id → full refetch".
 * The stored id is validated against /api/channels once the list loads (SourceSwitcher);
 * a stale id falls back to the server's `selected` or the first channel.
 *
 * `pulse_channel` remains the single ACTIVE channel (network-agnostic) — the value the API
 * client reads synchronously for the X-Channel-Id header (api/client). The per-network memory
 * below (`pulse_source_channels`) sits on top: it remembers the last valid channel PER network
 * so switching Telegram ↔ Instagram restores each side's own source instead of dragging the
 * other network's channel across. `pulse_channel` stays a migration/fallback seed for it.
 */
let selectedChannel: number | null = readStoredChannel();

function readStoredChannel(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null || raw === '') return null;
    const id = Number(raw);
    return Number.isInteger(id) && id >= 0 ? id : null;
  } catch {
    return null;
  }
}

export function getSelectedChannel(): number | null {
  return selectedChannel;
}

export function setSelectedChannel(id: number | null): void {
  selectedChannel = id;
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    /* localStorage may be unavailable — selection just won't survive a reload */
  }
}

// ── Per-network source memory ─────────────────────────────────────────────────────────────────
// A source is exactly (network, channel_id). We remember the last valid channel for each network
// independently, so TG → IG → TG round-trips restore each network's own last channel. Backed by a
// single JSON map ({ tg: 12, ig: 7 }); a missing entry falls back to the legacy `pulse_channel`
// value so a user with only the old key keeps a sane starting point on their first cross-network
// switch (migration/fallback).

function readMemory(): Record<string, number> {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(v);
      if (Number.isInteger(id) && id >= 0) out[k] = id;
    }
    return out;
  } catch {
    return {};
  }
}

const memory: Record<string, number> = readMemory();

/** The last valid channel remembered for a network, or the legacy single value as a fallback
    (so a first switch to a never-visited network starts from the last active channel). Only valid
    ids (≥0) are ever stored, so a missing entry reads as `undefined` and defers to the legacy value. */
export function getRememberedChannel(network: string): number | null {
  const id = memory[network];
  return id != null ? id : readStoredChannel();
}

/** Remember (or clear, with null) the channel for a network. No-op when unchanged. */
export function setRememberedChannel(network: string, id: number | null): void {
  if (id == null) {
    if (memory[network] === undefined) return;
    delete memory[network];
  } else if (memory[network] === id) {
    return;
  } else {
    memory[network] = id;
  }
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* localStorage may be unavailable — memory just won't survive a reload */
  }
}
