/**
 * BACKLOG-2224 — pair-device account-match pre-check (behavioral guard).
 *
 * Verifies that scanning a QR for a DIFFERENT Keepr account aborts pairing
 * BEFORE any data leaves the phone: no registerDevice, no AsyncStorage write,
 * no navigation to first-sync — just an explanatory alert. The positive control
 * proves the gate actually gates (a matching account proceeds normally).
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

// --- expo-camera: capture the onBarcodeScanned prop so the test can fire a scan.
let capturedOnBarcodeScanned: ((r: { data: string }) => void) | null = null;
jest.mock('expo-camera', () => {
  const React2 = require('react');
  return {
    CameraView: (props: { onBarcodeScanned?: (r: { data: string }) => void }) => {
      capturedOnBarcodeScanned = props.onBarcodeScanned ?? null;
      return React2.createElement('View', null);
    },
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

// --- expo-router
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- AsyncStorage: must NOT be written on the abort path.
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
}));

// --- onboardingProgress (BACKLOG-2216): the screen persists its step on mount.
// Mock it so that step-write does NOT touch the AsyncStorage spied on above —
// the "no persist on abort" assertion must observe ONLY the pairing write. ---
// `completeOnboarding` added by BACKLOG-2956 for the "Continue without a
// computer" escape hatch; spied so the skip suite can assert it is awaited
// BEFORE navigation.
const mockCompleteOnboarding = jest.fn(async () => undefined);
jest.mock('../../../services/onboardingProgress', () => ({
  setOnboardingStep: jest.fn(async () => undefined),
  completeOnboarding: () => mockCompleteOnboarding(),
}));

// --- Mock the onboarding sign-out link (BACKLOG-2956). The real component
// imports authService, which calls expo-linking's createURL() at module scope and
// needs an expo-constants manifest jest does not provide. Its behavior has its
// own suite: components/ui/__tests__/OnboardingSignOutLink.test.tsx ---
jest.mock('../../../components/ui/OnboardingSignOutLink', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: () => ReactModule.createElement(Text, null, 'Sign out'),
  };
});

// --- syncService.registerDevice: must NOT be called on the abort path.
// Return shape widened (BACKLOG-2212) so tests can resolve failure results
// carrying errorType / status.
const mockRegisterDevice = jest.fn(
  async (
    _info: unknown,
  ): Promise<{
    success: boolean;
    deviceId?: string;
    errorType?: string;
    status?: number;
    error?: string;
  }> => ({
    success: true,
  }),
);
jest.mock('../../../services/syncService', () => ({
  registerDevice: (info: unknown) => mockRegisterDevice(info),
}));

// --- contactSyncState.forceFullContactResync: BACKLOG-2210 adoption reset.
const mockForceFullContactResync = jest.fn(async () => undefined);
jest.mock('../../../services/contactSyncState', () => ({
  forceFullContactResync: () => mockForceFullContactResync(),
}));

// --- accountMatch: the pre-check under test. Controlled per test.
const mockCheckDesktopAccountMatch = jest.fn();
jest.mock('../../../services/accountMatch', () => ({
  checkDesktopAccountMatch: (hash?: string) => mockCheckDesktopAccountMatch(hash),
  accountMatchMessage: (reason: string) => ({
    title: reason === 'account_mismatch' ? 'Different Keepr Account' : 'Sign In Required',
    body: 'msg',
  }),
}));

// --- components/ui barrel: lightweight Button (avoids the real barrel's Supabase
// / Sentry transitive imports, which don't load under jest).
jest.mock('../../../components/ui', () => {
  const React2 = require('react');
  const { Text, Pressable } = require('react-native');
  return {
    Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
      React2.createElement(
        Pressable,
        { onPress, accessibilityRole: 'button' },
        React2.createElement(Text, null, title),
      ),
  };
});

import PairDeviceScreen from '../pair-device';

const MISMATCH_QR = JSON.stringify({
  ip: '192.168.1.9',
  port: 51000,
  secret: 'a'.repeat(64),
  deviceName: 'Desktop-B',
  desktopUserIdHash: 'b'.repeat(64),
});

async function scanQr(getByText: (t: string) => unknown, qr: string): Promise<void> {
  await act(async () => {
    fireEvent.press(getByText('Scan QR Code') as never);
  });
  await waitFor(() => expect(capturedOnBarcodeScanned).not.toBeNull());
  await act(async () => {
    capturedOnBarcodeScanned!({ data: qr });
  });
}

describe('pair-device account-match pre-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnBarcodeScanned = null;
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  it('aborts pairing on a different-account QR: no register, no persist, no navigation', async () => {
    mockCheckDesktopAccountMatch.mockResolvedValue({ ok: false, reason: 'account_mismatch' });
    const AsyncStorage = require('@react-native-async-storage/async-storage');

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() => expect(mockCheckDesktopAccountMatch).toHaveBeenCalled());
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/Different Keepr Account/i),
      expect.anything(),
    );
  });

  it('positive control: a matching-account QR pairs (register + navigate)', async () => {
    mockCheckDesktopAccountMatch.mockResolvedValue({ ok: true });
    const AsyncStorage = require('@react-native-async-storage/async-storage');

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() => expect(mockRegisterDevice).toHaveBeenCalled());
    expect(AsyncStorage.setItem).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/first-sync');
  });

  it('BACKLOG-2210: adopts the desktop-minted deviceId — persists it + forces a full contact resync', async () => {
    mockCheckDesktopAccountMatch.mockResolvedValue({ ok: true });
    mockRegisterDevice.mockResolvedValue({
      success: true,
      deviceId: '11111111-2222-3333-4444-555555555555',
    });
    const AsyncStorage = require('@react-native-async-storage/async-storage');

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() => expect(mockForceFullContactResync).toHaveBeenCalled());
    // The pairing is persisted carrying the adopted UUID as its identity.
    const wroteAdoptedId = (AsyncStorage.setItem as jest.Mock).mock.calls.some(
      ([key, value]: [string, string]) =>
        key === '@keepr/pairing' &&
        JSON.parse(value).deviceId === '11111111-2222-3333-4444-555555555555',
    );
    expect(wroteAdoptedId).toBe(true);
  });
});

/**
 * BACKLOG-2212 — a swallowed registerDevice failure at pair time used to push on
 * to first-sync regardless. These tests prove each failure mode now surfaces its
 * OWN actionable message, never navigates onward, and never persists a
 * half-paired state — and that a reachability failure offers a Retry that
 * re-attempts (and can recover).
 */
describe('pair-device registration failure feedback (BACKLOG-2212)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterDevice.mockReset();
    capturedOnBarcodeScanned = null;
    // Account pre-check passes in every case here — we are exercising the
    // register round-trip that follows it.
    mockCheckDesktopAccountMatch.mockResolvedValue({ ok: true });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  it('reachability failure: shows the reach-Keepr message, does not navigate, persists nothing', async () => {
    mockRegisterDevice.mockResolvedValue({
      success: false,
      errorType: 'connection_refused',
    });
    const AsyncStorage = require('@react-native-async-storage/async-storage');

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() => expect(mockRegisterDevice).toHaveBeenCalledTimes(1));
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/reach keepr/i),
      expect.stringMatching(/same Wi-Fi/i),
      expect.any(Array),
    );
    // Not swallowed → no push to first-sync, and nothing persisted (no
    // half-paired state).
    expect(mockReplace).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('reachability failure: the Retry button re-attempts and recovers', async () => {
    mockRegisterDevice
      .mockResolvedValueOnce({ success: false, errorType: 'timeout' })
      .mockResolvedValueOnce({ success: true });

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() => expect(mockRegisterDevice).toHaveBeenCalledTimes(1));
    expect(mockReplace).not.toHaveBeenCalled();

    // Fire the Retry action from the alert's button list.
    const reachCall = (Alert.alert as jest.Mock).mock.calls.find((c) =>
      /reach keepr/i.test(String(c[0])),
    );
    const buttons = reachCall![2] as { text: string; onPress?: () => void }[];
    const retry = buttons.find((b) => b.text === 'Retry');
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.onPress?.();
    });

    // Re-attempted, and on success it navigates to first-sync.
    await waitFor(() => expect(mockRegisterDevice).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/first-sync'),
    );
  });

  it('desktop 403 (verified account mismatch): shows the account message, NOT the reach message, and does not navigate', async () => {
    mockRegisterDevice.mockResolvedValue({
      success: false,
      status: 403,
      errorType: 'server_error',
    });

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() => expect(mockRegisterDevice).toHaveBeenCalled());
    // Account copy (from accountMatchMessage), NOT the reachability copy, and no
    // Retry button (2-arg alert).
    expect(Alert.alert).toHaveBeenCalledWith(
      'Different Keepr Account',
      expect.anything(),
    );
    const sawReach = (Alert.alert as jest.Mock).mock.calls.some((c) =>
      /reach keepr/i.test(String(c[0])),
    );
    expect(sawReach).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('positive control: a successful register still navigates to first-sync', async () => {
    mockRegisterDevice.mockResolvedValue({ success: true });

    const { getByText } = render(<PairDeviceScreen />);
    await scanQr(getByText, MISMATCH_QR);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/first-sync'),
    );
  });
});

// =============================================================================
// BACKLOG-2956 — CONTROL 3a: the skip reaches the real screens.
// =============================================================================
//
// pair-device was the only onboarding screen with no way forward and no way back
// (permissions and first-sync both already ship "Skip for Now"). A Play reviewer
// with only a phone dead-ends here and never sees the app work — the most likely
// rejection — and the founder hit the same wall after signing in with the wrong
// account, with clearing app storage as his only escape.
//
// The skip must land in the REAL app (no demo mode, no sample data), and it must
// persist the onboarding-complete flag BEFORE navigating: app/_layout.tsx's auth
// gate treats "reached (main)" as proof that flag is written, so navigating first
// races the gate and bounces the user back into onboarding.
//
// MUTATION THAT MUST GO RED: delete the "Continue without a computer" Button from
// app/onboarding/pair-device.tsx. Both tests below fail — the first cannot find
// the button, the second cannot press it.
describe('pair-device — continue without a computer (BACKLOG-2956)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockCompleteOnboarding.mockClear();
    mockRegisterDevice.mockClear();
  });

  it('offers a way past the pairing screen', () => {
    const { getByText } = render(<PairDeviceScreen />);
    expect(getByText('Continue without a computer')).toBeTruthy();
  });

  it('lands in the real app, and marks onboarding complete BEFORE navigating', async () => {
    // Order matters, so record the sequence rather than just the two calls.
    const order: string[] = [];
    mockCompleteOnboarding.mockImplementation(async () => {
      order.push('completeOnboarding');
      return undefined;
    });
    mockReplace.mockImplementation((route: string) => {
      order.push(`replace:${route}`);
    });

    const { getByText } = render(<PairDeviceScreen />);
    fireEvent.press(getByText('Continue without a computer'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(main)/home');
    });

    expect(order).toEqual(['completeOnboarding', 'replace:/(main)/home']);

    // The escape hatch must not pair anything or invent a pairing to fake one.
    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('still navigates into the app when the completion write fails (never traps the user)', async () => {
    mockCompleteOnboarding.mockRejectedValue(new Error('storage full'));

    const { getByText } = render(<PairDeviceScreen />);
    fireEvent.press(getByText('Continue without a computer'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(main)/home');
    });
  });
});
