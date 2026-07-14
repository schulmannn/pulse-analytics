import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getRememberedChannel, setRememberedChannel, setSelectedChannel } from '@/lib/channel';
import { getActiveNetwork } from '@/lib/networkStore';

interface ChannelContextValue {
  channelId: number | null;
  setChannelId: (id: number | null) => void;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

export function ChannelProvider({ children }: { children: ReactNode }) {
  const [channelId, setChannelIdState] = useState<number | null>(() => {
    // Start from the channel remembered for the CURRENTLY active network (falls back to the legacy
    // single value). Sync the module-level active var so the API client's X-Channel-Id header
    // matches the context from the very first fetch, before the switcher's reconcile effect runs.
    const initial = getRememberedChannel(getActiveNetwork());
    setSelectedChannel(initial);
    return initial;
  });

  const setChannelId = useCallback((id: number | null) => {
    setSelectedChannel(id);
    // Persist the pick as the active network's remembered source. Call sites that switch network
    // (SourceSwitcher.pick) set the active network FIRST, so this records the destination network.
    setRememberedChannel(getActiveNetwork(), id);
    setChannelIdState(id);
  }, []);

  return <ChannelContext.Provider value={{ channelId, setChannelId }}>{children}</ChannelContext.Provider>;
}

export function useSelectedChannel(): ChannelContextValue {
  const value = useContext(ChannelContext);
  if (!value) throw new Error('useSelectedChannel must be used within ChannelProvider');
  return value;
}

/**
 * Pin a subtree to a FIXED source: every query hook inside reads `channelId` from this
 * override instead of the switcher (per-widget «Источник» on Главная / report blocks).
 * Data stays isolated for free — all query keys already carry channelId. Passing
 * null/undefined renders children unscoped (follow the switcher).
 */
export function ChannelScope({ channelId, children }: { channelId?: number | null; children: ReactNode }) {
  const parent = useSelectedChannel();
  const value = useMemo(
    () => ({ channelId: channelId ?? parent.channelId, setChannelId: parent.setChannelId }),
    [channelId, parent.channelId, parent.setChannelId],
  );
  if (channelId == null) return <>{children}</>;
  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>;
}
