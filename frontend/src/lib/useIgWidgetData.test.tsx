// Хук IG-виджета на «Всё»: пока архива нет (демо — запрос выключен, свежее подключение — пустой
// ответ, сбой чтения), архивному окну нужен живой фолбэк, как у useIgData. Без него карточка на
// «Всё» печатала «Нет данных за период», хотя резолвер с живыми инсайтами считает число.
// Запросы подменены: проверяется только проводка хука (что включено и что ушло в резолвер).
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IgHistoryData, IgInsights } from '@/api/schemas';
import type { WidgetConfig } from '@/lib/widgetConfig';
import type { WidgetDataState } from '@/lib/widgetDataState';

interface FakeQuery {
  data?: unknown;
  isPending: boolean;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: 'idle' | 'fetching';
  refetch: () => Promise<unknown>;
}
const q = (over: Partial<FakeQuery> = {}): FakeQuery => ({
  isPending: false, isLoading: false, isError: false, isFetching: false, fetchStatus: 'idle', refetch: async () => undefined, ...over,
});

const state = vi.hoisted(() => ({
  history: null as unknown,
  insights: null as unknown,
  insightsEnabled: [] as boolean[],
}));

vi.mock('@/api/queries', () => ({
  useIgProfile: () => q({ data: { followers_count: 100 } }),
  useIgHistory: () => state.history,
  useIgInsights: (_days: number, enabled: boolean) => {
    state.insightsEnabled.push(enabled);
    return state.insights;
  },
  useIgBreakdowns: () => q(),
  useIgOnline: () => q(),
}));
vi.mock('@/lib/channel-context', () => ({ useSelectedChannel: () => ({ channelId: 7 }) }));
vi.mock('@/lib/widgetViewport', () => ({ useWidgetInView: () => true }));

const { useIgWidgetData } = await import('@/lib/useIgWidgetData');

const DAY = 86_400_000;
const liveInsights: IgInsights = {
  data: [
    {
      name: 'reach',
      period: 'day',
      values: Array.from({ length: 90 }, (_, i) => ({ value: 100, end_time: new Date(Date.now() - (90 - i) * DAY).toISOString() })),
    },
  ],
} as IgInsights;

function run(config: WidgetConfig): WidgetDataState {
  let out: WidgetDataState | null = null;
  function Probe() {
    out = useIgWidgetData(config);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!out) throw new Error('hook did not run');
  return out;
}

const allTime: WidgetConfig = { id: 'w', metricId: 'ig.reach', viz: 'line', period: 0 };

describe('useIgWidgetData — «Всё» без архива берёт живой фолбэк (как useIgData)', () => {
  beforeEach(() => {
    state.insightsEnabled = [];
    state.insights = q({ data: liveInsights });
  });

  it('демо: архив выключен (pending + idle) — инсайты включены, карточка не пустая', () => {
    state.history = q({ isPending: true, fetchStatus: 'idle' });
    const r = run(allTime);
    expect(state.insightsEnabled).toEqual([true]);
    expect(r.result.empty).toBeFalsy();
    expect(r.result.valueRaw).toBe(9000);
    expect(r.isLoading).toBe(false);
  });

  it('свежее подключение: архив пришёл пустым — тот же фолбэк', () => {
    state.history = q({ data: { rows: [], bounds: null } satisfies Partial<IgHistoryData> });
    const r = run(allTime);
    expect(state.insightsEnabled).toEqual([true]);
    expect(r.result.empty).toBeFalsy();
  });

  it('архив есть — инсайты НЕ запрашиваются, закэшированное окно в резолвер не попадает', () => {
    const rows = [{ day: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10), reach: 5 }];
    state.history = q({ data: { rows, bounds: { first_day: rows[0]?.day, last_day: rows[0]?.day } } });
    const r = run(allTime);
    expect(state.insightsEnabled).toEqual([false]);
    expect(r.result.valueRaw).toBe(5);
  });

  it('фолбэк ещё грузится — скелетон, а не «Нет данных»', () => {
    state.history = q({ isPending: true, fetchStatus: 'idle' });
    state.insights = q({ isPending: true, isLoading: true, fetchStatus: 'fetching' });
    expect(run(allTime).isLoading).toBe(true);
  });
});
