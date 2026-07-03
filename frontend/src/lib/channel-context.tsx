import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getSelectedChannel, setSelectedChannel } from '@/lib/channel';

interface ChannelContextValue {
  channelId: number | null;
  setChannelId: (id: number | null) => void;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

export function ChannelProvider({ children }: { children: ReactNode }) {
  const [channelId, setChannelIdState] = useState<number | null>(() => getSelectedChannel());

  const setChannelId = useCallback((id: number | null) => {
    setSelectedChannel(id);
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
