/**
 * BACKLOG-3005 — pairing from the HOME screen must drain, exactly like pairing
 * from onboarding.
 *
 * ## What the founder observed, on the int build, 2026-08-30
 *
 * He paired from the HOME screen with the import window on All time and got
 * **500 of 2,317** — no `Drained N cycles` line, nothing on screen saying more
 * remained. An hour earlier the *identical binary* drained all 2,317, because
 * that time he paired through ONBOARDING. Same phone, same setting, same build.
 *
 * His ruling: *"regardless of where you sync — onboarding or home screen —
 * after you just scan the QR code, or a returning user syncing, it should
 * ALWAYS do everything based on the setting in Keepr desktop."*
 *
 * ## Why this suite exists at all
 *
 * The cause was a single argument: `home.tsx`'s auto-first-sync passed
 * `maxCycles: 1`. The previous SR review measured that **mutating that binding
 * left all 641 tests green** — the six home suites assert what a sync RESULT
 * renders, never what `performSync` was CALLED WITH, and this pairing path had
 * no coverage at all. Closing that gap is the point of this file.
 *
 * The constant comes from the REAL leaf module (`services/syncDepth`), never a
 * literal written here, so the assertion cannot compare the mock against itself.
 */

import React from 'react';
import {
  render,
  waitFor,
  screen,
  fireEvent,
  act,
} from '@testing-library/react-native';
import { Alert, AppState } from 'react-native';
import type { SyncOperationResult } from '../../../services/backgroundSync';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactModule = require('react');
    ReactModule.useEffect(() => cb(), [cb]);
  },
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));
// Capture `onBarcodeScanned` so the scan itself can be driven.
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

// --- Stateful AsyncStorage, seeded with a pairing so the PAIRED screen renders.
// The REAL lock accessors read and write this store. ---
// Deliberately NOT seeded with a pairing: this suite pairs by scanning, which
// is the path the founder used.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  // ONE set of spies, shared by `default` and the namespace. Two separate sets
  // is a silent trap: the code under test imports the DEFAULT export, so a
  // counter reading the namespace copy sees zero calls forever — which makes a
  // "no reads happened" assertion pass for the wrong reason.
  const api = {
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
  return { __esModule: true, __store: store, default: api, ...api };
});

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

const mockPerformSync = jest.fn<Promise<SyncOperationResult>, [unknown?]>();
jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  stopBackgroundSync: jest.fn(async () => undefined),
  performSync: (opts?: unknown) => mockPerformSync(opts),
  isBackgroundSyncActive: jest.fn(async () => true),
  // BACKLOG-3005: the REAL ceiling, from the leaf module, so the call-site
  // control below cannot compare a literal against itself.
  MAX_SYNC_CYCLES_PER_RUN: jest.requireActual('../../../services/syncDepth')
    .MAX_SYNC_CYCLES_PER_RUN,
}));

// --- `syncWindow` reaches Supabase at import time via smsQueueService. ---
jest.mock('../../../services/supabaseClient', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  },
}));

// --- THE POINT OF THIS SUITE: the lock accessors are REAL. Only the data
// getters home calls on load are stubbed. ---
jest.mock('../../../services/smsQueueService', () => {
  const actual = jest.requireActual('../../../services/smsQueueService');
  return {
    ...actual,
    getSyncStats: jest.fn(async () => ({
      totalSynced: 0,
      lastSyncTime: Date.now(),
      lastSuccessfulSyncAt: Date.now(),
      consecutiveFailures: 0,
      firstFailureTime: null,
    })),
    getQueueSize: jest.fn(async () => 0),
    getBackgroundSyncEnabled: jest.fn(async () => false),
    resetAllSyncData: jest.fn(async () => undefined),
  };
});

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

/**
 * The ui barrel must be mocked (the real one pulls @sentry/react-native and the
 * Supabase client in via HelpModal). `Button` is a TRANSCRIPTION of the real
 * `components/ui/Button.tsx` contract, not an invention:
 *
 *   :109  `disabled && styles.disabled`        -> greyed out
 *   :112  `disabled={disabled || loading}`     -> press blocked by EITHER prop
 *   :115  `loading ? <ActivityIndicator ...>`  -> the spinner
 *
 * So a spinner testID stands in for the ActivityIndicator, and the Pressable's
 * `disabled` is computed the same way the real component computes it.
 */
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable, View, ActivityIndicator } = require('react-native');
  const Button = ({
    title,
    onPress,
    loading,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    loading?: boolean;
    disabled?: boolean;
  }) =>
    ReactModule.createElement(
      Pressable,
      {
        testID: `button-${title}`,
        onPress,
        disabled: !!disabled || !!loading,
        accessibilityRole: 'button',
        accessibilityState: { disabled: !!disabled || !!loading, busy: !!loading },
      },
      loading
        ? ReactModule.createElement(ActivityIndicator, {
            testID: `spinner-${title}`,
          })
        : null,
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

/** A valid pairing QR payload: private LAN address, 64-hex secret. */
const VALID_QR = JSON.stringify({
  ip: '10.0.0.2',
  port: 51000,
  secret: 'a'.repeat(64),
  deviceName: 'Desktop-A',
});

const { MAX_SYNC_CYCLES_PER_RUN } = jest.requireActual<{
  MAX_SYNC_CYCLES_PER_RUN: number;
}>('../../../services/syncDepth');

/** The in-memory store lives on the MODULE namespace, not on `default`. */
function store(): Record<string, string> {
  return (
    jest.requireMock('@react-native-async-storage/async-storage') as {
      __store: Record<string, string>;
    }
  ).__store;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The store is module-scoped and survives between cases: without this the
  // second test starts ALREADY PAIRED by the first one's scan.
  for (const key of Object.keys(store())) delete store()[key];
  capturedOnBarcodeScanned = null;
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockPerformSync.mockResolvedValue({ ...RESULT_BASE });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Render the UNPAIRED home screen, open the scanner, and scan a valid QR. */
async function pairFromHomeScreen(): Promise<void> {
  render(<HomeScreen />);
  await waitFor(() => expect(screen.getByText('Not Paired')).toBeTruthy());

  fireEvent.press(screen.getByTestId('button-Scan QR Code'));
  await waitFor(() => expect(capturedOnBarcodeScanned).not.toBeNull());

  await act(async () => {
    capturedOnBarcodeScanned!({ data: VALID_QR });
  });
}

describe('pairing from the home screen', () => {
  /**
   * THE CONTROL FOR THE FOUNDER'S ACTUAL COMPLAINT.
   *
   * MUTATION that must go red: restore `maxCycles: 1` at the auto-first-sync
   * call site in `savePairing`.
   */
  it('asks for a FULL DRAIN, not a single pass', async () => {
    await pairFromHomeScreen();

    await waitFor(() => expect(mockPerformSync).toHaveBeenCalled());

    expect(MAX_SYNC_CYCLES_PER_RUN).toBeGreaterThan(1);
    expect(mockPerformSync).toHaveBeenCalledWith({
      maxCycles: MAX_SYNC_CYCLES_PER_RUN,
    });
  });

  /**
   * The drain is NOT awaited before the success alert.
   *
   * `handleBarCodeScanned` awaits `savePairing`, and only then shows "Paired
   * Successfully". Awaiting a multi-minute drain there would leave the user
   * staring at a closed camera with no confirmation that pairing worked — a
   * regression introduced BY the fix if the call site were left awaited.
   *
   * MUTATION that must go red: `await performSync({...})` instead of the
   * fire-and-forget `.then(...)`.
   */
  it('confirms the pairing immediately, without waiting for the drain', async () => {
    // A drain that never settles for the duration of this test.
    mockPerformSync.mockImplementation(
      () => new Promise<SyncOperationResult>(() => undefined),
    );

    await pairFromHomeScreen();

    await waitFor(() =>
      expect(
        (Alert.alert as jest.Mock).mock.calls.map((c) => c[0]),
      ).toContain('Paired Successfully'),
    );
    // And the sync really was started — the alert is not skipping it.
    expect(mockPerformSync).toHaveBeenCalledWith({
      maxCycles: MAX_SYNC_CYCLES_PER_RUN,
    });
  });
});
