import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOLTIP_DELAY_MS,
  TOOLTIP_SKIP_MS,
  isTooltipSkipActive,
  openTooltipSkipWindow,
  resetTooltipSkipForTest,
  subscribeTooltipSkip,
  tooltipDelayFor,
} from '@/lib/tooltipSkip';

describe('окно пропуска задержки подсказок', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTooltipSkipForTest();
  });
  afterEach(() => {
    resetTooltipSkipForTest();
    vi.useRealTimers();
  });

  it('до первого закрытия задержка полная', () => {
    expect(isTooltipSkipActive()).toBe(false);
    expect(tooltipDelayFor(isTooltipSkipActive())).toBe(TOOLTIP_DELAY_MS);
  });

  it('после закрытия соседняя открывается мгновенно, а по истечении окна задержка возвращается', () => {
    openTooltipSkipWindow();
    expect(tooltipDelayFor(isTooltipSkipActive())).toBe(0);

    vi.advanceTimersByTime(TOOLTIP_SKIP_MS - 1);
    expect(tooltipDelayFor(isTooltipSkipActive())).toBe(0);

    vi.advanceTimersByTime(1);
    expect(tooltipDelayFor(isTooltipSkipActive())).toBe(TOOLTIP_DELAY_MS);
  });

  it('оба перехода уведомляют подписчиков — иначе delayDuration протух бы между рендерами', () => {
    const seen: boolean[] = [];
    subscribeTooltipSkip(() => seen.push(isTooltipSkipActive()));

    openTooltipSkipWindow();
    vi.advanceTimersByTime(TOOLTIP_SKIP_MS);

    expect(seen).toEqual([true, false]);
  });

  it('повторное закрытие продлевает окно, а не оставляет старый таймер', () => {
    openTooltipSkipWindow();
    vi.advanceTimersByTime(TOOLTIP_SKIP_MS - 50);
    openTooltipSkipWindow();

    // Старый таймер сработал бы здесь и погасил окно раньше времени.
    vi.advanceTimersByTime(60);
    expect(isTooltipSkipActive()).toBe(true);

    vi.advanceTimersByTime(TOOLTIP_SKIP_MS);
    expect(isTooltipSkipActive()).toBe(false);
  });

  it('отписка снимает слушателя', () => {
    let calls = 0;
    const unsubscribe = subscribeTooltipSkip(() => {
      calls += 1;
    });
    unsubscribe();
    openTooltipSkipWindow();
    expect(calls).toBe(0);
  });
});
