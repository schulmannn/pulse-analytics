import { describe, expect, it } from 'vitest';
import { effectiveSidebarMode, parseSidebarMode, toggledSidebarMode } from './sidebar';

describe('effectiveSidebarMode', () => {
  it('defaults to expanded at ≥lg and to the icon-rail below, when the user has not chosen', () => {
    expect(effectiveSidebarMode(null, true)).toBe('open');
    expect(effectiveSidebarMode(null, false)).toBe('rail');
  });

  it('honours an explicit persisted choice at every breakpoint', () => {
    expect(effectiveSidebarMode('rail', true)).toBe('rail');
    expect(effectiveSidebarMode('open', false)).toBe('open');
  });
});

describe('toggledSidebarMode', () => {
  it('flips between the two modes', () => {
    expect(toggledSidebarMode('open')).toBe('rail');
    expect(toggledSidebarMode('rail')).toBe('open');
  });
});

describe('parseSidebarMode', () => {
  it('accepts only the two valid persisted values', () => {
    expect(parseSidebarMode('open')).toBe('open');
    expect(parseSidebarMode('rail')).toBe('rail');
    expect(parseSidebarMode('1')).toBeNull();
    expect(parseSidebarMode('')).toBeNull();
    expect(parseSidebarMode(null)).toBeNull();
    expect(parseSidebarMode(undefined)).toBeNull();
  });
});
