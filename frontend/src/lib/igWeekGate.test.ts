import { describe, expect, it } from 'vitest';
import { igWeekGate } from './igWeekGate';

// The five IG endpoints must NOT fire for an unconnected selected channel; while channels are
// unresolved we probe nothing and load honestly; demo always probes.
describe('igWeekGate', () => {
  it('probes when channels resolved to a connected selected channel', () => {
    expect(igWeekGate({ demo: false, channelsResolved: true, channelsError: false, channelKnown: true, igConnected: true })).toEqual({
      igEnabled: true,
      notConnected: false,
      gateLoading: false,
    });
  });

  it('does NOT probe an unconnected selected channel — notConnected without touching endpoints', () => {
    expect(igWeekGate({ demo: false, channelsResolved: true, channelsError: false, channelKnown: true, igConnected: false })).toEqual({
      igEnabled: false,
      notConnected: true,
      gateLoading: false,
    });
  });

  it('while channels are unresolved: no probing, honest loading, not notConnected', () => {
    expect(igWeekGate({ demo: false, channelsResolved: false, channelsError: false, channelKnown: true, igConnected: false })).toEqual({
      igEnabled: false,
      notConnected: false,
      gateLoading: true,
    });
  });

  it('no channel selected yet: no probing, honest loading', () => {
    expect(igWeekGate({ demo: false, channelsResolved: true, channelsError: false, channelKnown: false, igConnected: false })).toEqual({
      igEnabled: false,
      notConnected: false,
      gateLoading: true,
    });
  });

  it('demo always probes regardless of capability (fixtures back every panel)', () => {
    expect(igWeekGate({ demo: true, channelsResolved: false, channelsError: false, channelKnown: false, igConnected: false })).toEqual({
      igEnabled: true,
      notConnected: false,
      gateLoading: false,
    });
  });

  it('falls back to the previous runtime probe when channel capability lookup fails', () => {
    expect(igWeekGate({ demo: false, channelsResolved: false, channelsError: true, channelKnown: true, igConnected: false })).toEqual({
      igEnabled: true,
      notConnected: false,
      gateLoading: false,
    });
  });
});
