/**
 * Phone connectivity probe (BACKLOG-2296).
 *
 * These pin the exact rule the sync-failure classifier depends on: a failed sync
 * is case (b) "phone off Wi-Fi" ONLY when the phone is not on a Wi-Fi connection,
 * and is treated as ON the local network (→ case (a) desktop-down) whenever we
 * cannot prove otherwise (undetermined state, NetInfo error) so we never show a
 * NEW false "you're offline" message.
 */

import type { NetInfoState } from '@react-native-community/netinfo';

const mockFetch = jest.fn<Promise<NetInfoState>, []>();
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: () => mockFetch() },
}));

import {
  getPhoneConnectivity,
  isOnLocalNetwork,
  isPhoneOnLocalNetwork,
} from '../connectivity';

/**
 * Minimal NetInfoState shim — only the fields connectivity.ts reads. `type` is a
 * plain string here (NetInfoStateType is a strict enum) and cast at the boundary.
 */
function state(partial: {
  type?: string;
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}): NetInfoState {
  return {
    type: 'unknown',
    isConnected: null,
    isInternetReachable: null,
    details: null,
    ...partial,
  } as unknown as NetInfoState;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getPhoneConnectivity', () => {
  it('Wi-Fi + connected → on the local network', async () => {
    mockFetch.mockResolvedValue(state({ type: 'wifi', isConnected: true }));
    const c = await getPhoneConnectivity();
    expect(c).toEqual({ isConnected: true, isWifi: true });
    expect(isOnLocalNetwork(c)).toBe(true);
  });

  it('cellular (connected but NOT Wi-Fi) → NOT on the local network (case b)', async () => {
    mockFetch.mockResolvedValue(state({ type: 'cellular', isConnected: true }));
    const c = await getPhoneConnectivity();
    expect(c).toEqual({ isConnected: true, isWifi: false });
    // Cellular cannot reach a LAN desktop → offline for sync purposes.
    expect(isOnLocalNetwork(c)).toBe(false);
  });

  it('no connection at all → NOT on the local network (case b)', async () => {
    mockFetch.mockResolvedValue(state({ type: 'none', isConnected: false }));
    const c = await getPhoneConnectivity();
    expect(c).toEqual({ isConnected: false, isWifi: false });
    expect(isOnLocalNetwork(c)).toBe(false);
  });

  it('does NOT key off isInternetReachable — Wi-Fi with no internet still counts as on-LAN', async () => {
    // A phone on the right Wi-Fi but with no internet can still reach the desktop.
    mockFetch.mockResolvedValue(
      state({ type: 'wifi', isConnected: true, isInternetReachable: false }),
    );
    expect(isOnLocalNetwork(await getPhoneConnectivity())).toBe(true);
  });

  it('undetermined isConnected (null) on Wi-Fi is treated as connected (no over-reporting offline)', async () => {
    mockFetch.mockResolvedValue(state({ type: 'wifi', isConnected: null }));
    const c = await getPhoneConnectivity();
    expect(c).toEqual({ isConnected: true, isWifi: true });
  });

  it('NetInfo throwing → assume on the local network (safe default, no false offline)', async () => {
    mockFetch.mockRejectedValue(new Error('native NetInfo failure'));
    const c = await getPhoneConnectivity();
    expect(c).toEqual({ isConnected: true, isWifi: true });
    expect(isOnLocalNetwork(c)).toBe(true);
  });
});

describe('isPhoneOnLocalNetwork', () => {
  it('true on Wi-Fi', async () => {
    mockFetch.mockResolvedValue(state({ type: 'wifi', isConnected: true }));
    expect(await isPhoneOnLocalNetwork()).toBe(true);
  });

  it('false when offline / not on Wi-Fi', async () => {
    mockFetch.mockResolvedValue(state({ type: 'none', isConnected: false }));
    expect(await isPhoneOnLocalNetwork()).toBe(false);
  });
});
