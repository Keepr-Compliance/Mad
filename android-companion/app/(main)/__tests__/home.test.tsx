/**
 * Behavioral guard for the home "SMS access needed" banner (BACKLOG-2209 proactive
 * revocation + BACKLOG-2214 skipped-in-onboarding never-granted).
 *
 * 2206 shipped a read-error banner, but it only surfaced AFTER a manual "Sync
 * Now" (it was fed solely by `lastSyncResult.readError`). 2209 added the PROACTIVE
 * half: the home screen LIVE-checks READ_SMS on load / every foreground and, when
 * SMS access is not granted, renders the SAME banner ("Open Settings" CTA) WITHOUT
 * a manual sync; granting again clears it (recovery). 2214 extends that ONE surface
 * to the never-granted (onboarding-skipped) cause and adapts the copy to it, using
 * the `@keepr/sms-granted-once` sticky flag to tell the two causes apart.
 *
 * WHAT THIS TEST verifies:
 *   1. denied + never granted (skipped onboarding) -> the "Grant SMS access to
 *      start syncing" banner + "Open Settings" CTA render on load (2214).
 *   2. denied + granted-before (revoked in Settings) -> the SAME banner with the
 *      revoked "Couldn't read messages" copy (2209) — one surface, adapted copy.
 *   3. granted -> the banner is absent (recovered / normal state) AND the sticky
 *      ever-granted flag is persisted so a later revoke reads as revoked.
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

// --- AsyncStorage: a stateful in-memory store, seeded with a pairing so home
// renders the PAIRED screen (where the banner lives), not the "Not Paired" hero.
// Stateful (not a fixed getItem) so BACKLOG-2214's `@keepr/sms-granted-once`
// sticky flag can be preset per-case AND so a granted load persists it (recovery
// proof). The store is inlined in the factory (jest.mock factories cannot close
// over out-of-scope vars) and exposed as `__store` for the tests to seed/reset. ---
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import HomeScreen from '../home';

const SMS_GRANTED_ONCE_KEY = '@keepr/sms-granted-once';
// Direct handle on the stateful AsyncStorage mock's backing store (see factory).
const store = (
  AsyncStorage as unknown as { __store: Record<string, string> }
).__store;

const grantSms = (): void => {
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  });
};
const denySms = (): void => {
  mockCheckSmsPermissions.mockResolvedValue({
    readSms: 'denied',
    receiveSms: 'denied',
    allGranted: false,
  });
};

describe('HomeScreen — one "SMS access needed" banner (BACKLOG-2209 + 2214)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the sticky ever-granted flag between cases (the store persists across
    // renders within the module).
    delete store[SMS_GRANTED_ONCE_KEY];
  });

  it('never-granted (skipped in onboarding): shows the "Grant SMS access to start syncing" banner + "Open Settings" CTA (2214)', async () => {
    denySms(); // no ever-granted flag => never-granted cause

    render(<HomeScreen />);

    // Setup framing, NOT the revoked "Couldn't read messages" wording.
    await waitFor(() => {
      expect(
        screen.getByText('Grant SMS access to start syncing'),
      ).toBeTruthy();
    });
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(screen.queryByText("Couldn't read messages")).toBeNull();
  });

  it('revoked (granted before, then turned off): shows the SAME banner with the 2209 revoked copy — one surface, adapted', async () => {
    denySms();
    store[SMS_GRANTED_ONCE_KEY] = 'true'; // granted at least once => revoked cause

    render(<HomeScreen />);

    // The shared 2206/2209 permission_denied copy, proving one surface (not a fork).
    await waitFor(() => {
      expect(screen.getByText("Couldn't read messages")).toBeTruthy();
    });
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(
      screen.queryByText('Grant SMS access to start syncing'),
    ).toBeNull();
  });

  it('granted: no banner (normal state) AND persists the ever-granted flag so a later revoke reads as revoked', async () => {
    grantSms();

    render(<HomeScreen />);

    // Wait for load to settle (the Paired status badge renders once loaded).
    await waitFor(() => {
      expect(screen.getByText('Paired')).toBeTruthy();
    });
    expect(screen.queryByText("Couldn't read messages")).toBeNull();
    expect(
      screen.queryByText('Grant SMS access to start syncing'),
    ).toBeNull();

    // Recovery half: observing a granted permission stamps the sticky flag.
    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        SMS_GRANTED_ONCE_KEY,
        'true',
      );
    });
  });
});
