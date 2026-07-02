const STORAGE_KEY = 'pulse_channel';

/**
 * Selected-channel id, persisted in localStorage (same key style as pulse_token /
 * pulse_theme / pulse_demo). Persistence kills the bootstrap double-fetch: on reload the
 * provider starts from the stored id instead of null, so channel-scoped queries fire once
 * with the right key instead of "null-key fetch → ChannelCard sets id → full refetch".
 * The stored id is validated against /api/channels once the list loads (DashboardLayout);
 * a stale id falls back to the server's `selected` or the first channel.
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
