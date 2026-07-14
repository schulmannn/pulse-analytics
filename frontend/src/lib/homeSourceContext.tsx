import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Network } from '@/lib/networks';

export type SourceNetwork = Network | 'multi';

interface HomeSourceValue {
  network: SourceNetwork;
  channelId?: number | null;
}

const HomeSourceContext = createContext<HomeSourceValue | null>(null);

export function HomeSourceProvider({ value, children }: { value: HomeSourceValue; children: ReactNode }) {
  return <HomeSourceContext.Provider value={value}>{children}</HomeSourceContext.Provider>;
}

export function useHomeSource(): HomeSourceValue | null {
  return useContext(HomeSourceContext);
}
