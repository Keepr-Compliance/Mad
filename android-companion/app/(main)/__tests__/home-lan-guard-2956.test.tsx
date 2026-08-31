/**
 * BACKLOG-2956 — the HOME re-pair scanner must apply the LAN address guard too.
 *
 * There are two QR entry points, and a guard on only one of them is a guard the
 * user can walk around: onboarding's `pair-device.tsx` (covered by
 * app/onboarding/__tests__/pair-device.test.tsx) and this one, the re-pair
 * scanner behind the home screen's "Re-connect". This suite exists because
 * deleting the guard from `home.tsx` left all 35 companion suites green — the
 * gap was found by mutating the line and watching nothing go red.
 *
 * It matters because the app now permits cleartext HTTP app-wide (Android's
 * network-security-config has no CIDR syntax, so the OS cannot scope it to the
 * LAN). The destination check is the only thing keeping a QR code from
 * redirecting SMS bodies, unencrypted, to a host on the internet.
 *
 * The mock scaffold is deliberately a copy of syncDisconnectedBanner.test.tsx's
 * — the same paired-home setup, differing only in that CameraView here captures
 * `onBarcodeScanned` so a scan can actually be fired.
 */
/**
 * Home "sync disconnected" banner + Re-connect routing (BACKLOG-2296).
 *
 * When a manual "Sync Now" fails for a connectivity reason, the home screen must
 * surface the RIGHT cause and recovery:
 *   (a) desktop unreachable (phone on Wi-Fi) → "Can't reach Keepr on your
 *       computer" + a Re-connect CTA that opens the guided pair (QR re-scan) flow.
 *   (b) phone offline (no Wi-Fi) → "You're not connected to Wi-Fi", NO Re-connect
 *       (reconnecting Wi-Fi is the fix, not re-pairing).
 *   - a 403 account rejection (server_error, BACKLOG-2284) → NO disconnected
 *     banner (it is not a reachability problem).
 *   - a successful sync → NO disconnected banner.
 *
 * The banner is derived from `syncDisconnection(lastSyncResult)` (used REAL here),
 * so this drives a real "Sync Now" and asserts the rendered outcome. The mock
 * shape mirrors app/(main)/__tests__/home.test.tsx.
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import type { SyncOperationResult } from '../../../services/backgroundSync';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));
// expo-camera: capture the onBarcodeScanned prop so a scan can be fired.
// (syncDisconnectedBanner.test.tsx stubs CameraView to null because it only
// needs to observe that the scanner opened; here the scan itself is the test.)
let capturedOnBarcodeScanned: ((r: { data: string }) => void) | null = null;
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: (props: { onBarcodeScanned?: (r: { data: string }) => void }) => {
    capturedOnBarcodeScanned = props.onBarcodeScanned ?? null;
    return null;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Seeded PAIRED so the home screen renders the paired view (where Sync Now lives).
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {
    '@keepr/pairing': JSON.stringify({
      ip: '10.0.0.2',
      port: 8765,
      secret: 'x'.repeat(64),
      deviceName: 'desk',
      pairedAt: new Date().toISOString(),
    }),
  };
  return {
    __store: store,
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
});

// SMS permission GRANTED so the SMS banner never competes with the 2296 banner.
jest.mock('../../../services/permissions', () => ({
  checkSmsPermissions: jest.fn(async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  })),
  requestSmsPermissions: jest.fn(async () => ({ readSms: 'granted' })),
  requestContactsPermissions: jest.fn(async () => ({ granted: true })),
}));

// performSync is driven per-test via mockPerformSync (mock-prefixed so the
// hoisted factory may reference it).
const mockPerformSync = jest.fn<Promise<SyncOperationResult>, []>();
jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  stopBackgroundSync: jest.fn(async () => undefined),
  performSync: () => mockPerformSync(),
  isBackgroundSyncActive: jest.fn(async () => true),
}));
jest.mock('../../../services/smsQueueService', () => ({
  // BACKLOG-3005 (busy-state fold): home reads the shared sync lock to grey the
  // Sync Now button for syncs it did not start. An omitted method here reads as
  // the feature not firing (the trap syncServiceLanGuard.test.ts documents).
  isSyncInFlight: jest.fn(async () => false),
  resetAllSyncData: jest.fn(async () => undefined),
  getSyncStats: jest.fn(async () => ({
    totalSynced: 0,
    lastSyncTime: Date.now(),
    lastSuccessfulSyncAt: Date.now(),
    consecutiveFailures: 0,
    firstFailureTime: null,
  })),
  getQueueSize: jest.fn(async () => 0),
  getBackgroundSyncEnabled: jest.fn(async () => false),
}));
jest.mock('../../../services/syncStaleness', () => ({
  getSyncFreshness: () => ({ status: 'fresh' }),
  formatRelativeTime: () => 'just now',
}));
jest.mock('../../../services/batteryOptimization', () => ({
  shouldPromptBatteryOptimization: () => false,
  openBatteryOptimizationSettings: jest.fn(async () => true),
  getBatteryOptPromptDismissed: jest.fn(async () => false),
  setBatteryOptPromptDismissed: jest.fn(async () => undefined),
}));
const mockRegisterDevice = jest.fn(async () => ({ success: true }));
jest.mock('../../../services/syncService', () => ({
  registerDevice: () => mockRegisterDevice(),
}));
jest.mock('../../../services/contactSyncState', () => ({
  forceFullContactResync: jest.fn(async () => undefined),
}));
jest.mock('../../../services/accountMatch', () => ({
  checkDesktopAccountMatch: jest.fn(async () => ({ ok: true })),
  accountMatchMessage: () => ({ title: '', body: '' }),
}));
jest.mock('../../../services/authService', () => ({
  getSession: jest.fn(async () => null),
}));

// Lightweight components/ui (same rationale as home.test): Button surfaces its
// title so CTAs are queryable/pressable.
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable, View } = require('react-native');
  const Button = ({ title, onPress }: { title: string; onPress?: () => void }) =>
    ReactModule.createElement(
      Pressable,
      { onPress, accessibilityRole: 'button' },
      ReactModule.createElement(Text, null, title),
    );
  const passthrough =
    (tag: string) =>
    ({ title, children }: { title?: string; children?: React.ReactNode }) =>
      ReactModule.createElement(
        View,
        { testID: tag },
        title ? ReactModule.createElement(Text, null, title) : null,
        children,
      );
  const CardRow = ({ label, value }: { label: string; value: string }) =>
    ReactModule.createElement(Text, null, `${label} ${value}`);
  const StatusBadge = ({ label }: { label: string }) =>
    ReactModule.createElement(Text, null, label);
  return {
    Button,
    Card: passthrough('card'),
    CardRow,
    CardDivider: () => null,
    StatusBadge,
    Header: () => null,
    Avatar: () => null,
    SupportButton: () => null,
    NavBarFooter: () => null,
  };
});

import HomeScreen from '../home';

const RESULT_BASE: SyncOperationResult = {
  newMessages: 0,
  sentMessages: 0,
  contactsSynced: 0,
  newContacts: 0,
  desktopReachable: true,
  queueSize: 0,
};

const qrForIp = (ip: string): string =>
  JSON.stringify({
    ip,
    port: 51000,
    secret: 'a'.repeat(64),
    deviceName: 'Desktop-A',
  });

/** Drive the paired home into the re-pair scanner and fire a QR scan. */
async function scanFromHome(qr: string): Promise<void> {
  render(<HomeScreen />);
  await waitFor(() => expect(screen.getByText('Paired')).toBeTruthy());

  // A failed sync is what surfaces the Re-connect CTA (BACKLOG-2296/2301).
  mockPerformSync.mockResolvedValue({
    ...RESULT_BASE,
    desktopReachable: false,
    error: "Can't reach Keepr on your computer.",
    errorType: 'connection_refused',
  });
  fireEvent.press(screen.getByText('Sync Now'));
  await waitFor(() => expect(screen.getByText('Re-connect')).toBeTruthy());

  fireEvent.press(screen.getByText('Re-connect'));
  await waitFor(() =>
    expect(screen.getByText('Open Keepr on your computer')).toBeTruthy(),
  );
  fireEvent.press(screen.getByText('Scan QR Code'));
  await waitFor(() => expect(capturedOnBarcodeScanned).not.toBeNull());

  await act(async () => {
    capturedOnBarcodeScanned!({ data: qr });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnBarcodeScanned = null;
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockPerformSync.mockResolvedValue({ ...RESULT_BASE });
});

describe('HomeScreen re-pair — LAN address guard (BACKLOG-2956)', () => {
  it.each([
    ['8.8.8.8', 'a public address'],
    ['100.100.100.100', 'CGNAT — outside the permitted ranges'],
    ['keepr.example.com', 'a hostname, which could resolve anywhere'],
  ])('refuses a re-pair QR pointing at %s (%s)', async (ip) => {
    await scanFromHome(qrForIp(ip));

    // Decisive: no registration request is issued to the address on the QR.
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      expect.stringMatching(/Not a Local Network Address/i),
      expect.stringContaining(ip),
    );
    const blamedWifi = (Alert.alert as jest.Mock).mock.calls.some((c) =>
      /same Wi-Fi network/i.test(String(c[1])),
    );
    expect(blamedWifi).toBe(false);
  });

  it('positive control: a 192.168/16 re-pair QR proceeds to register', async () => {
    await scanFromHome(qrForIp('192.168.0.233'));
    await waitFor(() => expect(mockRegisterDevice).toHaveBeenCalled());
  });
});
