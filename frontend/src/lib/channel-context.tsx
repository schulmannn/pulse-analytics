import { createContext, useCallback, useContext, useState } from 'react';
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
