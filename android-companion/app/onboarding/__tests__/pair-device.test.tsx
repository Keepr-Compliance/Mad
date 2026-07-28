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

// --- syncService.registerDevice: must NOT be called on the abort path.
const mockRegisterDevice = jest.fn(
  async (_info: unknown): Promise<{ success: boolean; deviceId?: string }> => ({
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
    // The pairing is re-persisted carrying the adopted UUID as its identity.
    const wroteAdoptedId = (AsyncStorage.setItem as jest.Mock).mock.calls.some(
      ([key, value]: [string, string]) =>
        key === '@keepr/pairing' &&
        JSON.parse(value).deviceId === '11111111-2222-3333-4444-555555555555',
    );
    expect(wroteAdoptedId).toBe(true);
  });
});
