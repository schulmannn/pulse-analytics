/**
 * Pure capability gate for the Instagram-week narrative (NarrativeWeek `useIgWeekInput`).
 *
 * The IG-week input fans out FIVE queries (profile, insights 14/7, history, posts). Firing them
 * for a channel that never linked an Instagram account is pure waste — the endpoints answer with a
 * `mock` payload the panel discards. This decides, from the already-cached `useChannels` capability
 * (`ig_connected`), whether to probe at all:
 *
 * - demo: always probe (fixtures back every panel, no real account needed);
 * - channels still unresolved OR no channel selected: DON'T probe — represent honest loading;
 * - resolved + selected + not connected: `notConnected` without touching any of the five endpoints;
 * - resolved + selected + connected: probe.
 */
export interface IgWeekGateInput {
  /** Demo mode — fixtures stand in for a real account, so always probe. */
  demo: boolean;
  /** `useChannels` has settled (resolved data OR error) — capability is now knowable. */
  channelsResolved: boolean;
  /** Capability lookup failed — preserve the previous runtime probe instead of claiming disconnected. */
  channelsError: boolean;
  /** A channel id is currently selected. */
  channelKnown: boolean;
  /** The selected channel carries a linked Instagram account (`ig_connected`). */
  igConnected: boolean;
}

export interface IgWeekGate {
  /** Fire the five IG hooks. */
  igEnabled: boolean;
  /** Resolved to an unconnected selected channel (not demo) — show the connect CTA, no probing. */
  notConnected: boolean;
  /** Capability not yet knowable (channels unresolved / no channel) — honest loading, no probing. */
  gateLoading: boolean;
}

export function igWeekGate({ demo, channelsResolved, channelsError, channelKnown, igConnected }: IgWeekGateInput): IgWeekGate {
  if (demo || channelsError) return { igEnabled: true, notConnected: false, gateLoading: false };
  if (!channelKnown || !channelsResolved) return { igEnabled: false, notConnected: false, gateLoading: true };
  if (!igConnected) return { igEnabled: false, notConnected: true, gateLoading: false };
  return { igEnabled: true, notConnected: false, gateLoading: false };
}
