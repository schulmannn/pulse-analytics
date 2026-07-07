import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeSize } from './observeSize';

// Capture the ResizeObserver callback + track observe/disconnect so we can drive it by hand.
class FakeRO {
  static last: FakeRO | null = null;
  cb: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    FakeRO.last = this;
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  trigger() { this.cb([], this as unknown as ResizeObserver); }
}

const el = { nodeType: 1 } as unknown as Element;

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRO.last = null;
});

describe('observeSize', () => {
  it('defers ResizeObserver callbacks to requestAnimationFrame (breaks the sync measure→render→measure loop)', () => {
    vi.stubGlobal('ResizeObserver', FakeRO);
    let scheduled: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { scheduled = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { scheduled = null; });

    const measure = vi.fn();
    observeSize(el, measure);
    expect(FakeRO.last?.observed).toContain(el);

    // A resize does NOT call measure synchronously — it only schedules it (no nested-render storm).
    FakeRO.last!.trigger();
    expect(measure).not.toHaveBeenCalled();
    // The frame runs the coalesced measurement exactly once.
    scheduled!(0);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of resizes into a single deferred measurement', () => {
    vi.stubGlobal('ResizeObserver', FakeRO);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const measure = vi.fn();
    observeSize(el, measure);
    FakeRO.last!.trigger();
    FakeRO.last!.trigger();
    FakeRO.last!.trigger();
    // Only the most-recently-scheduled frame runs a measurement (prior ones were cancelled).
    frames[frames.length - 1](0);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('cleanup disconnects the observer', () => {
    vi.stubGlobal('ResizeObserver', FakeRO);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const cleanup = observeSize(el, vi.fn());
    cleanup();
    expect(FakeRO.last?.disconnected).toBe(true);
  });

  it('is a no-op where ResizeObserver is unavailable (SSR / jsdom)', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const cleanup = observeSize(el, vi.fn());
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });
});
