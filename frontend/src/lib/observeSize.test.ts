import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSizeGate, observeSize } from './observeSize';

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
  trigger(entries: ResizeObserverEntry[] = []) { this.cb(entries, this as unknown as ResizeObserver); }
}

const el = { nodeType: 1 } as unknown as Element;

// A minimal RO entry carrying just the size fields observeSize reads.
const entry = (w: number, h: number) =>
  ({
    borderBoxSize: [{ inlineSize: w, blockSize: h }],
    contentRect: { width: w, height: h },
  }) as unknown as ResizeObserverEntry;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it('suppresses an A→B→A oscillation: no per-frame rAF, ONE trailing measure that re-arms', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeRO);
    let rafCount = 0;
    vi.stubGlobal('requestAnimationFrame', () => { rafCount += 1; return rafCount; });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const measure = vi.fn();
    observeSize(el, measure);
    const ro = FakeRO.last;
    if (!ro) throw new Error('ResizeObserver was not constructed');
    // Scrollbar flip: 300 ↔ 312. The first four deliveries ride the normal rAF hop…
    ro.trigger([entry(300, 200)]);
    ro.trigger([entry(312, 200)]);
    ro.trigger([entry(300, 200)]); // flip 1
    ro.trigger([entry(312, 200)]); // flip 2
    expect(rafCount).toBe(4);
    // …the 3rd flip is declared a livelock: no new frame is scheduled.
    ro.trigger([entry(300, 200)]); // flip 3 → suppress
    expect(rafCount).toBe(4);
    // Further oscillation inside the suppress window only pushes the trailing timer out.
    vi.advanceTimersByTime(200);
    ro.trigger([entry(312, 200)]); // ≈ last delivered → skip
    ro.trigger([entry(300, 200)]); // flip again → suppress, timer re-armed
    expect(rafCount).toBe(4);
    vi.advanceTimersByTime(400); // 600ms after the first arm, 400ms after the re-arm
    expect(measure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // 500ms after the re-arm — the ONE trailing measure fires
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('cleanup cancels a pending trailing measure', () => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', FakeRO);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const measure = vi.fn();
    const cleanup = observeSize(el, measure);
    const ro = FakeRO.last;
    if (!ro) throw new Error('ResizeObserver was not constructed');
    ro.trigger([entry(300, 200)]);
    ro.trigger([entry(312, 200)]);
    ro.trigger([entry(300, 200)]);
    ro.trigger([entry(312, 200)]);
    ro.trigger([entry(300, 200)]); // suppress → trailing timer armed
    cleanup();
    vi.advanceTimersByTime(1000);
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('createSizeGate', () => {
  const A: [number, number] = [300, 200];
  const B: [number, number] = [312, 200];

  it('skips a size within 1px of the last delivered one on both axes (epsilon)', () => {
    const gate = createSizeGate({ now: () => 0 });
    expect(gate.shouldDeliver(300, 200)).toBe('deliver');
    expect(gate.shouldDeliver(301, 200)).toBe('skip');
    expect(gate.shouldDeliver(300, 201)).toBe('skip');
    expect(gate.shouldDeliver(299, 199)).toBe('skip');
    // >1px on an axis is a real change.
    expect(gate.shouldDeliver(302, 200)).toBe('deliver');
  });

  it('suppresses the A→B→A flip pattern on the 3rd rapid flip and stays suppressed', () => {
    let t = 0;
    const gate = createSizeGate({ now: () => t });
    expect(gate.shouldDeliver(...A)).toBe('deliver');
    t += 16; expect(gate.shouldDeliver(...B)).toBe('deliver');
    t += 16; expect(gate.shouldDeliver(...A)).toBe('deliver'); // flip 1
    t += 16; expect(gate.shouldDeliver(...B)).toBe('deliver'); // flip 2
    t += 16; expect(gate.shouldDeliver(...A)).toBe('suppress'); // flip 3
    // The livelock keeps flipping: the repeat of the last delivered size is epsilon-noise,
    // the counterpart keeps being suppressed (each occurrence re-arms the trailing measure).
    t += 16; expect(gate.shouldDeliver(...B)).toBe('skip');
    t += 16; expect(gate.shouldDeliver(...A)).toBe('suppress');
  });

  it('a genuinely new size resets the flip streak', () => {
    let t = 0;
    const gate = createSizeGate({ now: () => t });
    gate.shouldDeliver(...A);
    t += 16; gate.shouldDeliver(...B);
    t += 16; expect(gate.shouldDeliver(...A)).toBe('deliver'); // flip 1
    t += 16; expect(gate.shouldDeliver(...B)).toBe('deliver'); // flip 2
    t += 16; expect(gate.shouldDeliver(500, 400)).toBe('deliver'); // real resize — streak over
    // The suspicion starts from scratch: it takes 3 fresh flips to suppress again.
    t += 16; expect(gate.shouldDeliver(...A)).toBe('deliver');
    t += 16; expect(gate.shouldDeliver(...B)).toBe('deliver');
    t += 16; expect(gate.shouldDeliver(...A)).toBe('deliver'); // flip 1
    t += 16; expect(gate.shouldDeliver(...B)).toBe('deliver'); // flip 2
    t += 16; expect(gate.shouldDeliver(...A)).toBe('suppress'); // flip 3
  });

  it('flip detection tolerates 1px of jitter around the remembered sizes', () => {
    let t = 0;
    const gate = createSizeGate({ now: () => t });
    gate.shouldDeliver(...A);
    t += 16; gate.shouldDeliver(...B);
    t += 16; expect(gate.shouldDeliver(301, 201)).toBe('deliver'); // ≈A → flip 1
    t += 16; expect(gate.shouldDeliver(311, 199)).toBe('deliver'); // ≈B → flip 2
    t += 16; expect(gate.shouldDeliver(300, 200)).toBe('suppress'); // ≈A → flip 3
  });

  it('slow (user-driven) revisits of a previous size never suppress', () => {
    let t = 0;
    const gate = createSizeGate({ now: () => t });
    gate.shouldDeliver(...A);
    t += 1000; expect(gate.shouldDeliver(...B)).toBe('deliver');
    t += 1000; expect(gate.shouldDeliver(...A)).toBe('deliver');
    t += 1000; expect(gate.shouldDeliver(...B)).toBe('deliver');
    t += 1000; expect(gate.shouldDeliver(...A)).toBe('deliver');
    t += 1000; expect(gate.shouldDeliver(...B)).toBe('deliver');
  });
});
