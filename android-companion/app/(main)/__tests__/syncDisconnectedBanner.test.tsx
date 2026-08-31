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
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import type { SyncOperationResult } from '../../../services/backgroundSync';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));
// expo-camera: the QR scanner. CameraView renders nothing, but pressing
// "Re-connect" flips the screen into the scanner (scanning=true), which renders
// the scanner instruction text — our proof the guided re-pair flow was entered.
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: () => null,
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
jest.mock('../../../services/syncService', () => ({
  registerDevice: jest.fn(async () => ({ success: true })),
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

async function renderPairedHome(): Promise<void> {
  render(<HomeScreen />);
  await waitFor(() => expect(screen.getByText('Paired')).toBeTruthy());
}

async function pressSyncNow(): Promise<void> {
  fireEvent.press(screen.getByText('Sync Now'));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  // Default: a healthy sync.
  mockPerformSync.mockResolvedValue({ ...RESULT_BASE });
});

describe('HomeScreen — sync-disconnected banner (BACKLOG-2296)', () => {
  it('desktop unreachable (phone on Wi-Fi) → "Can\'t reach Keepr" banner + Re-connect CTA', async () => {
    mockPerformSync.mockResolvedValue({
      ...RESULT_BASE,
      desktopReachable: false,
      error: "Can't reach Keepr on your computer. Make sure Keepr is open, then re-connect.",
      errorType: 'connection_refused',
    });

    await renderPairedHome();
    await pressSyncNow();

    await waitFor(() => {
      expect(screen.getByText("Can't reach Keepr on your computer")).toBeTruthy();
    });
    // Case (a) offers the guided re-pair.
    expect(screen.getByText('Re-connect')).toBeTruthy();
  });

  // BACKLOG-2301: Re-connect now opens the GUIDED re-pair walkthrough
  // (instructions THEN scan) instead of jumping straight to the bare camera.
  it('Re-connect opens the guided re-pair walkthrough, then its "Scan QR Code" opens the scanner', async () => {
    mockPerformSync.mockResolvedValue({
      ...RESULT_BASE,
      desktopReachable: false,
      error: "Can't reach Keepr on your computer. Make sure Keepr is open, then re-connect.",
      errorType: 'connection_refused',
    });

    await renderPairedHome();
    await pressSyncNow();
    await waitFor(() => expect(screen.getByText('Re-connect')).toBeTruthy());

    fireEvent.press(screen.getByText('Re-connect'));

    // The guided walkthrough (instructions) is shown FIRST — not the bare camera.
    await waitFor(() =>
      expect(screen.getByText('Open Keepr on your computer')).toBeTruthy(),
    );
    expect(screen.getByText('Re-connect to Keepr')).toBeTruthy();
    expect(screen.queryByText(/Point camera at the QR code/i)).toBeNull();

    // Following the walkthrough's "Scan QR Code" then opens the QR scanner.
    fireEvent.press(screen.getByText('Scan QR Code'));
    await waitFor(() =>
      expect(screen.getByText(/Point camera at the QR code/i)).toBeTruthy(),
    );
  });

  it('phone offline (no Wi-Fi) → "not connected to Wi-Fi" banner, NO Re-connect CTA', async () => {
    mockPerformSync.mockResolvedValue({
      ...RESULT_BASE,
      desktopReachable: false,
      error: "You're not connected to Wi-Fi. Reconnect to the same network as your computer, then sync again.",
      errorType: 'phone_offline',
    });

    await renderPairedHome();
    await pressSyncNow();

    await waitFor(() => {
      expect(screen.getByText("You're not connected to Wi-Fi")).toBeTruthy();
    });
    // Reconnecting Wi-Fi is the fix — re-pairing is NOT offered.
    expect(screen.queryByText('Re-connect')).toBeNull();
  });

  it('403 account rejection (server_error, 2284) → NO disconnected banner, NO Re-connect', async () => {
    mockPerformSync.mockResolvedValue({
      ...RESULT_BASE,
      desktopReachable: true,
      error: 'Server responded with 403: account mismatch',
      errorType: 'server_error',
    });

    await renderPairedHome();
    await pressSyncNow();

    // Give the render a beat, then assert neither connectivity banner appeared.
    await waitFor(() => expect(mockPerformSync).toHaveBeenCalled());
    expect(screen.queryByText("Can't reach Keepr on your computer")).toBeNull();
    expect(screen.queryByText("You're not connected to Wi-Fi")).toBeNull();
    expect(screen.queryByText('Re-connect')).toBeNull();
  });

  it('a successful sync → NO disconnected banner', async () => {
    mockPerformSync.mockResolvedValue({ ...RESULT_BASE, sentMessages: 2 });

    await renderPairedHome();
    await pressSyncNow();

    await waitFor(() => expect(mockPerformSync).toHaveBeenCalled());
    expect(screen.queryByText("Can't reach Keepr on your computer")).toBeNull();
    expect(screen.queryByText("You're not connected to Wi-Fi")).toBeNull();
    expect(screen.queryByText('Re-connect')).toBeNull();
  });
});
