/**
 * Behavioral guard for BACKLOG-2209 — proactive SMS-permission revocation banner
 * on the home screen.
 *
 * 2206 shipped a read-error banner, but it only surfaced AFTER a manual "Sync
 * Now" (it was fed solely by `lastSyncResult.readError`). 2209 adds the PROACTIVE
 * half: the home screen LIVE-checks READ_SMS on load / every foreground and, when
 * it was revoked in Android Settings after pairing, renders the SAME 2206 banner
 * (same copy from `smsReadErrorMessage`, same "Open Settings" CTA) WITHOUT
 * requiring a manual sync. When the permission is granted again, that same live
 * check clears the banner (recovery).
 *
 * WHAT THIS TEST verifies:
 *   1. checkSmsPermissions() === denied  -> the read-error/revocation banner and
 *      its "Open Settings" CTA render on load (no manual sync needed).
 *   2. checkSmsPermissions() === granted -> the banner is absent (the recovered /
 *      normal state).
 *
 * The sync-cycle half (proactive short-circuit, health held, cursor held, the
 * shared `permission_denied` SmsReadError surface) is covered in
 * services/__tests__/backgroundSync.test.ts.
 */
import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';
import type { SmsPermissionResult } from '../../../services/permissions';

// --- expo-router: home calls useRouter() and useFocusEffect(). The mount
// useEffect already drives loadAllData, so useFocusEffect is a no-op here. ---
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// --- expo-linking: a transitive import via the components/ui barrel calls
// createURL() at module-load time (needs the expo-constants manifest jest lacks). ---
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));

// --- expo-camera: home instantiates useCameraPermissions() for QR pairing. ---
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: () => null,
}));

// --- safe-area insets ---
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- AsyncStorage: return a stored pairing so home renders the PAIRED screen
// (where the banner lives), not the "Not Paired" hero. The pairing JSON is
// inlined in the factory (jest.mock factories cannot close over out-of-scope
// vars). ---
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) =>
    k === '@keepr/pairing'
      ? JSON.stringify({
          ip: '10.0.0.2',
          port: 8765,
          secret: 'x'.repeat(64),
          deviceName: 'desk',
          pairedAt: new Date().toISOString(),
        })
      : null,
  ),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

// --- The permission gate under test. Flipped per-case. ---
const mockCheckSmsPermissions = jest.fn<Promise<SmsPermissionResult>, []>();
jest.mock('../../../services/permissions', () => ({
  checkSmsPermissions: () => mockCheckSmsPermissions(),
  requestSmsPermissions: jest.fn(async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  })),
  requestContactsPermissions: jest.fn(async () => ({
    readContacts: 'granted',
    granted: true,
  })),
}));

// --- Background sync + queue services (home reads stats/queue on load). ---
jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  stopBackgroundSync: jest.fn(async () => undefined),
  performSync: jest.fn(async () => ({
    newMessages: 0,
    sentMessages: 0,
    contactsSynced: 0,
    newContacts: 0,
    desktopReachable: true,
    queueSize: 0,
  })),
  isBackgroundSyncActive: jest.fn(async () => true),
}));
jest.mock('../../../services/smsQueueService', () => ({
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

// --- Keep the stale-banner + battery-prompt paths inert so the ONLY banner in
// play is the 2209 read-error/revocation one. ---
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

// --- Misc services home touches on load / render. ---
jest.mock('../../../services/syncService', () => ({
  registerDevice: jest.fn(async () => ({ success: true })),
}));
// BACKLOG-2210: home imports forceFullContactResync for the deviceId-adoption
// path (only exercised on a QR re-pair, not by these banner tests).
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

// --- components/ui barrel: the real one pulls in @sentry/react-native + the
// Supabase client via HelpModal (native, unavailable under jest). Faithful
// lightweight stand-ins; Button surfaces its title so the "Open Settings" CTA is
// queryable. smsReadErrorMessage (services/smsReader) is used REAL so the banner
// shows the real copy. ---
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable, View } = require('react-native');
  const Button = ({ title, onPress }: { title: string; onPress?: () => void }) =>
    ReactModule.createElement(
      Pressable,
      { onPress, accessibilityRole: 'button' },
      ReactModule.createElement(Text, null, title),
    );
  const Card = ({
    title,
    children,
  }: {
    title?: string;
    children?: React.ReactNode;
  }) =>
    ReactModule.createElement(
      View,
      null,
      title ? ReactModule.createElement(Text, null, title) : null,
      children,
    );
  const CardRow = ({ label, value }: { label: string; value: string }) =>
    ReactModule.createElement(Text, null, `${label} ${value}`);
  const CardDivider = () => null;
  const StatusBadge = ({ label }: { label: string }) =>
    ReactModule.createElement(Text, null, label);
  const Header = () => null;
  const Avatar = () => null;
  const SupportButton = () => null;
  const NavBarFooter = () => null;
  return {
    Button,
    Card,
    CardRow,
    CardDivider,
    StatusBadge,
    Header,
    Avatar,
    SupportButton,
    NavBarFooter,
  };
});

import HomeScreen from '../home';

const grantSms = (): void => {
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  });
};
const revokeSms = (): void => {
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'denied',
    receiveSms: 'denied',
    allGranted: false,
  });
};

describe('HomeScreen — proactive SMS-permission revocation banner (BACKLOG-2209)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the read-error/revocation banner + "Open Settings" CTA when SMS permission is revoked (no manual sync)', async () => {
    revokeSms();

    render(<HomeScreen />);

    // The banner uses the SHARED 2206 copy (smsReadErrorMessage) — proving it is
    // the same surface, not a competing one — and appears purely from the live
    // permission check on load.
    await waitFor(() => {
      expect(screen.getByText("Couldn't read messages")).toBeTruthy();
    });
    expect(screen.getByText('Open Settings')).toBeTruthy();
  });

  it('does NOT show the revocation banner when SMS permission is granted (recovered / normal state)', async () => {
    grantSms();

    render(<HomeScreen />);

    // Wait for load to settle (the Paired status badge renders once loaded).
    await waitFor(() => {
      expect(screen.getByText('Paired')).toBeTruthy();
    });
    expect(screen.queryByText("Couldn't read messages")).toBeNull();
  });
});
