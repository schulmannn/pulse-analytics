import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DEMO_CHANNEL_ID, isDemoMode, setDemoFlag } from '@/lib/demo';
import { useSelectedChannel } from '@/lib/channel-context';

interface DemoContextValue {
  demo: boolean;
  enterDemo: () => void;
  exitDemo: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

/**
 * Demo-mode state. `demo` drives React rendering (banner, Get-Started gate); the API client reads
 * the flag from localStorage directly. enter/exit keep both in sync, then clear the query cache and
 * bounce to the overview so every panel refetches against the new (fixture vs real) source.
 * Must sit inside BrowserRouter + QueryClientProvider + ChannelProvider (it uses all three).
 */
export function DemoProvider({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState<boolean>(() => isDemoMode());
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { setChannelId } = useSelectedChannel();

  const enterDemo = useCallback(() => {
    setDemoFlag(true);
    setDemo(true);
    setChannelId(DEMO_CHANNEL_ID); // the demo workspace
    qc.clear();
    navigate('/');
  }, [qc, navigate, setChannelId]);

  const exitDemo = useCallback(() => {
    setDemoFlag(false);
    setDemo(false);
    setChannelId(null);
    qc.clear();
    navigate('/');
  }, [qc, navigate, setChannelId]);

  return <DemoContext.Provider value={{ demo, enterDemo, exitDemo }}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoContextValue {
  const v = useContext(DemoContext);
  if (!v) throw new Error('useDemo must be used within DemoProvider');
  return v;
}
