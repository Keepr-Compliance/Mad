/**
 * Behavioral guard for the home sync-status banner polish (BACKLOG-2301,
 * follow-up to BACKLOG-2296 #2106 + founder live-test feedback).
 *
 * Three founder/SR-confirmed changes, all exercised here through the real
 * services/syncStaleness (freshness) and services/syncFailure (disconnected
 * banner) so the wiring — not a re-implemented copy — is what's verified:
 *
 *   1. STALENESS DISMISSABLE. The amber 2204 "Sync may be behind" banner is
 *      nice-to-have background info, so it carries a subtle dismiss (X). Dismiss
 *      hides it for the session (survives a foreground refresh while still
 *      stale); a successful sync (-> fresh) also clears it. The DANGER 2296
 *      disconnected banner is NOT dismissable.
 *   2. RECONNECT -> GUIDED. The not-connected Re-connect CTA opens the guided
 *      re-pair walkthrough (instructions THEN scan), not the bare in-place
 *      camera. The two 2296 messages (desktop-down vs phone-offline) are
 *      unchanged.
 *   3. FOREGROUND-CLEAR + DE-DUP. On AppState->active, a disconnected banner is
 *      cleared once a sync has succeeded since it was raised (silent background
 *      recovery). While the disconnected banner is active the staleness banner is
 *      suppressed (never co-render both).
 *
 * DETERMINISM: getSyncStats / performSync are driven by MUTABLE `currentStats`
 * and `currentResult` read via `mockImplementation` (not `mockResolvedValueOnce`
 * queues). Every call — mount, "Sync Now", or an AppState->active refresh —
 * reads the currently-intended state, so the assertions never depend on how many
 * times (or in what order) the component happens to poll. State-changing triggers
 * are always awaited to settle (`waitFor` for visible outcomes; a flushed
 * `act(...)` for the AppState->active refresh) before asserting.
 *
 * The pure recovery helper (`hasSyncedSince`) and the message mapping
 * (`syncDisconnection`) are unit-tested in services/__tests__/syncFailure.test.ts.
 */
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react-native';
import { Alert, AppState, type AppStateStatus } from 'react-native';
import type { SyncOperationResult } from '../../../services/backgroundSync';
import type { SyncErrorType } from '../../../types/sync';

// --- expo-router: home calls useRouter() + useFocusEffect(). The mount useEffect
// drives loadAllData, so useFocusEffect is a no-op here. ---
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));

// --- expo-linking: transitively imported via the components/ui barrel. ---
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));

// --- expo-camera: home instantiates useCameraPermissions() for QR pairing. ---
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- AsyncStorage: seeded with a pairing so home renders the PAIRED screen. ---
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {
    '@keepr/pairing': JSON.stringify({
      ip: '10.0.0.2',
      port: 8765,
      secret: 'x'.repeat(64),
      deviceName: 'desk',
      pairedAt: new Date().toISOString(),
    }),
    // Ever-granted so the SMS banner path stays quiet and out of the way.
    '@keepr/sms-granted-once': 'true',
  };
  return {
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
});

// --- SMS permission: granted throughout so its banner never competes. ---
jest.mock('../../../services/permissions', () => ({
  checkSmsPermissions: jest.fn(async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  })),
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

// --- Sync services: performSync + getSyncStats are driven per-test via the
// mutable `currentResult` / `currentStats` (wired in beforeEach). mock-prefixed
// so the hoisted jest.mock factories may reference them. ---
const mockPerformSync = jest.fn<Promise<SyncOperationResult>, []>();
const mockGetSyncStats = jest.fn();
jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  stopBackgroundSync: jest.fn(async () => undefined),
  performSync: () => mockPerformSync(),
  isBackgroundSyncActive: jest.fn(async () => true),
}));
jest.mock('../../../services/smsQueueService', () => ({
  resetAllSyncData: jest.fn(async () => undefined),
  getSyncStats: () => mockGetSyncStats(),
  getQueueSize: jest.fn(async () => 0),
  getBackgroundSyncEnabled: jest.fn(async () => false),
}));

// --- Battery-optimization prompt kept inert. ---
jest.mock('../../../services/batteryOptimization', () => ({
  shouldPromptBatteryOptimization: () => false,
  openBatteryOptimizationSettings: jest.fn(async () => true),
  getBatteryOptPromptDismissed: jest.fn(async () => false),
  setBatteryOptPromptDismissed: jest.fn(async () => undefined),
}));

// --- Misc services home touches on load / the (untriggered) re-pair path. ---
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

// --- components/ui barrel: the real one pulls @sentry/react-native + the
// Supabase client via HelpModal (native, unavailable under jest). Faithful
// lightweight stand-ins; Button surfaces its title so CTAs are queryable. Raw
// react-native (View/Text/TouchableOpacity/ScrollView) — incl. the dismiss X —
// is NOT mocked, so the staleness dismiss control is queryable by its label. ---
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

// -------------------------------------------------------
// Fixtures
// -------------------------------------------------------

const STALE_MS = 4 * 60 * 60 * 1000; // > the 3h STALE_THRESHOLD_MS
const MINUTE_MS = 60 * 1000;

/** SyncStats whose last success is old enough to read as 'stale'. */
const staleStats = (): Record<string, unknown> => {
  const at = new Date(Date.now() - STALE_MS).toISOString();
  return { totalSynced: 0, lastSyncTime: at, lastSuccessfulSyncAt: at };
};
/** SyncStats whose last success is `successAt` (defaults to now) → 'fresh'. */
const freshStats = (
  successAt: string = new Date().toISOString(),
): Record<string, unknown> => ({
  totalSynced: 0,
  lastSyncTime: successAt,
  lastSuccessfulSyncAt: successAt,
});

const successResult = (): SyncOperationResult => ({
  newMessages: 0,
  sentMessages: 0,
  contactsSynced: 0,
  newContacts: 0,
  desktopReachable: true,
  queueSize: 0,
});
const failResult = (errorType: SyncErrorType): SyncOperationResult => ({
  newMessages: 0,
  sentMessages: 0,
  contactsSynced: 0,
  newContacts: 0,
  desktopReachable: false,
  queueSize: 0,
  error: 'boom',
  errorType,
});

const STALE_TITLE = 'Sync may be behind';
const DESKTOP_DOWN_TITLE = "Can't reach Keepr on your computer";
const WIFI_OFF_TITLE = "You're not connected to Wi-Fi";
const DISMISS_LABEL = 'Dismiss sync status notice';

// Mutable state the mocks read on EVERY call (see beforeEach). Tests mutate these
// to model "stale on load, fresh after a successful/background sync" without
// depending on call order or count.
let currentStats: Record<string, unknown>;
let currentResult: SyncOperationResult;
let appStateHandler: ((s: AppStateStatus) => void) | undefined;

/** Fire an AppState background->active transition and flush the refresh. */
const fireForeground = async (): Promise<void> => {
  await act(async () => {
    appStateHandler?.('active');
    // Flush loadAllData's promise chain (getSyncStats -> setState -> re-render).
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Render, tap "Sync Now", and wait for the given banner title to appear. */
const syncAndAwaitBanner = async (title: string): Promise<void> => {
  render(<HomeScreen />);
  await waitFor(() => expect(screen.getByText('Paired')).toBeTruthy());
  fireEvent.press(screen.getByText('Sync Now'));
  await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
};

beforeEach(() => {
  jest.clearAllMocks();
  appStateHandler = undefined;
  currentStats = freshStats();
  currentResult = successResult();
  mockGetSyncStats.mockImplementation(async () => currentStats);
  mockPerformSync.mockImplementation(async () => currentResult);
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((event, handler) => {
      if (event === 'change') {
        appStateHandler = handler as (s: AppStateStatus) => void;
      }
      return { remove: jest.fn() } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// -------------------------------------------------------
// 1. Staleness banner is dismissable
// -------------------------------------------------------

describe('staleness banner — dismissable (BACKLOG-2301 #1)', () => {
  it('shows a dismiss control; dismissing hides it and it stays hidden across a foreground refresh (same stale state)', async () => {
    currentStats = staleStats();

    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText(STALE_TITLE)).toBeTruthy());

    // A subtle dismiss (X) affordance is present and hides the banner.
    fireEvent.press(screen.getByLabelText(DISMISS_LABEL));
    await waitFor(() => expect(screen.queryByText(STALE_TITLE)).toBeNull());

    // Foregrounding while STILL stale must not resurrect it (session dismissal).
    await fireForeground();
    expect(screen.queryByText(STALE_TITLE)).toBeNull();
  });

  it('a successful sync (-> fresh) still clears the staleness banner', async () => {
    currentStats = staleStats();

    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText(STALE_TITLE)).toBeTruthy());

    // A successful sync advances lastSuccessfulSyncAt -> fresh on the reload.
    currentStats = freshStats();
    currentResult = successResult();
    fireEvent.press(screen.getByText('Sync Now'));

    await waitFor(() => expect(screen.queryByText(STALE_TITLE)).toBeNull());
  });
});

// -------------------------------------------------------
// 2. Reconnect routes to the guided flow; messages unchanged
// -------------------------------------------------------

describe('not-connected Re-connect — guided walkthrough (BACKLOG-2301 #2)', () => {
  it('opens the guided re-pair walkthrough (instructions), NOT the bare camera rescan', async () => {
    currentStats = freshStats();
    currentResult = failResult('connection_refused');

    await syncAndAwaitBanner(DESKTOP_DOWN_TITLE);
    fireEvent.press(screen.getByText('Re-connect'));

    // Guided walkthrough: instruction steps appear first...
    await waitFor(() =>
      expect(screen.getByText('Open Keepr on your computer')).toBeTruthy(),
    );
    expect(screen.getByText('Re-connect to Keepr')).toBeTruthy();
    // ...and it did NOT jump straight to the bare in-place camera scanner.
    expect(
      screen.queryByText(
        'Point camera at the QR code on your Keepr desktop app',
      ),
    ).toBeNull();
  });

  it('keeps the desktop-down message + Re-connect CTA (case a)', async () => {
    currentStats = freshStats();
    currentResult = failResult('connection_refused');

    await syncAndAwaitBanner(DESKTOP_DOWN_TITLE);
    expect(
      screen.getByText('Make sure Keepr is open on your computer, then re-connect.'),
    ).toBeTruthy();
    expect(screen.getByText('Re-connect')).toBeTruthy();
  });

  it('keeps the phone-offline message and offers NO Re-connect CTA (case b)', async () => {
    currentStats = freshStats();
    currentResult = failResult('phone_offline');

    await syncAndAwaitBanner(WIFI_OFF_TITLE);
    expect(
      screen.getByText(
        'Reconnect to the same Wi-Fi network as your computer, then sync again.',
      ),
    ).toBeTruthy();
    // Re-pairing cannot fix a phone off Wi-Fi — no CTA.
    expect(screen.queryByText('Re-connect')).toBeNull();
  });
});

// -------------------------------------------------------
// 3. Foreground-clear + de-dup; disconnected is NOT dismissable
// -------------------------------------------------------

describe('disconnected banner — foreground-clear + de-dup (BACKLOG-2301 #3)', () => {
  it('is NOT dismissable (no dismiss affordance on the danger banner)', async () => {
    currentStats = freshStats();
    currentResult = failResult('connection_refused');

    await syncAndAwaitBanner(DESKTOP_DOWN_TITLE);
    expect(screen.queryByLabelText(DISMISS_LABEL)).toBeNull();
  });

  it('clears on foreground once a sync has succeeded since it was raised (silent background recovery)', async () => {
    // Baseline success predates the failure, so the banner persists after it.
    currentStats = freshStats(new Date(Date.now() - MINUTE_MS).toISOString());
    currentResult = failResult('connection_refused');

    await syncAndAwaitBanner(DESKTOP_DOWN_TITLE);

    // Background/catch-up recovery: last success now advances past the failure.
    currentStats = freshStats(new Date(Date.now() + MINUTE_MS).toISOString());
    await fireForeground();

    await waitFor(() =>
      expect(screen.queryByText(DESKTOP_DOWN_TITLE)).toBeNull(),
    );
  });

  it('does NOT clear on foreground when no newer success exists (banner persists)', async () => {
    // Only a pre-failure success on record — foregrounding must not clear it.
    currentStats = freshStats(new Date(Date.now() - MINUTE_MS).toISOString());
    currentResult = failResult('connection_refused');

    await syncAndAwaitBanner(DESKTOP_DOWN_TITLE);

    await fireForeground();
    expect(screen.getByText(DESKTOP_DOWN_TITLE)).toBeTruthy();
  });

  it('suppresses the amber staleness banner while the disconnected banner is active (no double banner)', async () => {
    // Stale AND a connectivity failure — both banners would otherwise qualify.
    currentStats = staleStats();
    currentResult = failResult('connection_refused');

    render(<HomeScreen />);
    // Stale on mount → the amber banner shows first.
    await waitFor(() => expect(screen.getByText(STALE_TITLE)).toBeTruthy());

    fireEvent.press(screen.getByText('Sync Now'));
    await waitFor(() => expect(screen.getByText(DESKTOP_DOWN_TITLE)).toBeTruthy());
    // De-dup: the amber banner is suppressed while the danger banner is up.
    expect(screen.queryByText(STALE_TITLE)).toBeNull();
  });
});

// -------------------------------------------------------
// 4. Genuine success → no banners
// -------------------------------------------------------

describe('genuine success — no banners (BACKLOG-2301)', () => {
  it('shows no staleness and no disconnected banner after a clean sync', async () => {
    currentStats = freshStats();
    currentResult = successResult();

    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('Paired')).toBeTruthy());
    fireEvent.press(screen.getByText('Sync Now'));

    // Let the sync settle, then assert no banner ever appeared.
    await waitFor(() => expect(mockPerformSync).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(STALE_TITLE)).toBeNull();
    expect(screen.queryByText(DESKTOP_DOWN_TITLE)).toBeNull();
    expect(screen.queryByText(WIFI_OFF_TITLE)).toBeNull();
  });
});
