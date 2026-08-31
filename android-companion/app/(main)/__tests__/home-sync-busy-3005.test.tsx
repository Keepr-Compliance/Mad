/**
 * BACKLOG-3005 (busy-state fold) — the Sync Now button must reflect ANY
 * in-flight sync, and a skipped tap must never read as "Up to Date".
 *
 * ## The founder's complaint
 *
 * Told "don't tap Sync Now during the post-pair sync or it falsely says Up to
 * Date", he answered: *"why are we not graying it out or showing some spinner
 * and gray out to let them know it's running?"* — "don't tap it" is a
 * workaround for a UI defect, not guidance.
 *
 * ## Why it belongs to 3005
 *
 * `syncing` is component-local `useState`. The button greyed out correctly for
 * syncs THIS screen started and knew nothing about the post-pair auto-sync,
 * `appStateCatchup`, or the OS background task — all of which take the shared
 * AsyncStorage lock. Before 3005 that was a ~30 ms race. 3005 stretches the
 * lock-held window to the whole drain, so it is now the normal state.
 *
 * ## `isSyncInFlight` is REAL here, not mocked
 *
 * The stale-lock case is the one most likely to be got wrong, and mocking the
 * accessor would make the control assert its own fixture. So this suite takes
 * `jest.requireActual` of `smsQueueService` and seeds the lock by calling the
 * REAL `acquireSyncLock(now)` — the actual producer of that record — rather than
 * hand-writing a lock row.
 */

import React from 'react';
import {
  render,
  waitFor,
  screen,
  fireEvent,
  act,
} from '@testing-library/react-native';
import { Alert } from 'react-native';
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
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- Stateful AsyncStorage, seeded with a pairing so the PAIRED screen renders.
// The REAL lock accessors read and write this store. ---
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
    __esModule: true,
    __store: store,
    default: {
      getItem: jest.fn(async (k: string) => store[k] ?? null),
      setItem: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
      removeItem: jest.fn(async (k: string) => {
        delete store[k];
      }),
    },
    getItem: jest.fn(async (k: string) => store[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
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
  MAX_SYNC_CYCLES_PER_RUN: 20,
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
import {
  acquireSyncLock,
  releaseSyncLock,
  SYNC_LOCK_TTL_MS,
} from '../../../services/smsQueueService';

const RESULT_BASE: SyncOperationResult = {
  newMessages: 0,
  sentMessages: 0,
  contactsSynced: 0,
  newContacts: 0,
  desktopReachable: true,
  queueSize: 0,
};

const NOW = 1_800_000_000_000;

/**
 * The in-memory store lives on the MODULE namespace, not on `default` — the
 * default export is the AsyncStorage object itself, which has no `__store`.
 */
function store(): Record<string, string> {
  return (
    jest.requireMock('@react-native-async-storage/async-storage') as {
      __store: Record<string, string>;
    }
  ).__store;
}

/** Render the paired home screen and wait for its first load to settle. */
async function renderHome(): Promise<void> {
  render(<HomeScreen />);
  await waitFor(() => expect(screen.getByText('Paired')).toBeTruthy());
}

function syncButtonState(): { disabled: boolean; busy: boolean } {
  const btn = screen.getByTestId('button-Sync Now');
  const state = btn.props.accessibilityState as {
    disabled: boolean;
    busy: boolean;
  };
  return state;
}

beforeEach(() => {
  // Fake timers throughout: the focused screen runs a SYNC_BUSY_POLL_MS
  // interval, so real timers leave it pending past the run ("Jest did not
  // exit") and make the poll control untestable.
  jest.useFakeTimers();
  jest.clearAllMocks();
  delete store()['@keepr/sync-lock'];
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockPerformSync.mockResolvedValue({ ...RESULT_BASE });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. THE FOUNDER'S COMPLAINT
// ---------------------------------------------------------------------------

describe('a sync started somewhere else greys the button out', () => {
  /**
   * The post-pair auto-sync, `appStateCatchup` and the OS background task all
   * take this lock and never touch the home screen's `useState`.
   *
   * MUTATION that must go red: bind the button back to the local `syncing`
   * state alone (`loading={syncing} disabled={syncing}`).
   */
  it('renders Sync Now disabled AND spinning while another run holds the lock', async () => {
    // Seeded by the REAL producer, at the current clock.
    const nonce = await acquireSyncLock(NOW);
    expect(nonce).not.toBeNull();

    await renderHome();

    await waitFor(() => expect(syncButtonState().disabled).toBe(true));
    expect(syncButtonState().busy).toBe(true);
    expect(screen.getByTestId('spinner-Sync Now')).toBeTruthy();

    // And the press is genuinely blocked, not merely styled.
    fireEvent.press(screen.getByTestId('button-Sync Now'));
    expect(mockPerformSync).not.toHaveBeenCalled();
  });

  it('renders IDLE when no sync holds the lock', async () => {
    await renderHome();

    await waitFor(() => expect(syncButtonState().disabled).toBe(false));
    expect(screen.queryByTestId('spinner-Sync Now')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. A STALE LOCK MUST NOT STRAND THE BUTTON
// ---------------------------------------------------------------------------

describe('a stale lock reads as idle, not as busy forever', () => {
  /**
   * `acquireSyncLock` force-breaks a lock older than SYNC_LOCK_TTL_MS, so a run
   * that crashed mid-sync leaves a record behind. Reporting that as busy would
   * grey the button out PERMANENTLY — worse than the defect being fixed. The
   * two predicates must agree.
   *
   * MUTATION that must go red: drop the TTL comparison from `isSyncInFlight`
   * and return `existing !== null`.
   */
  it('a lock older than the TTL leaves Sync Now enabled and pressable', async () => {
    // Acquired well over the TTL ago, by the real producer, then abandoned.
    await acquireSyncLock(NOW - SYNC_LOCK_TTL_MS - 30_000);
    expect(store()['@keepr/sync-lock']).toBeDefined();

    await renderHome();

    await waitFor(() => expect(syncButtonState().disabled).toBe(false));
    expect(screen.queryByTestId('spinner-Sync Now')).toBeNull();

    fireEvent.press(screen.getByTestId('button-Sync Now'));
    await waitFor(() => expect(mockPerformSync).toHaveBeenCalled());
  });

  it('one millisecond INSIDE the TTL is still busy — the boundary is not sampled loosely', async () => {
    await acquireSyncLock(NOW - SYNC_LOCK_TTL_MS + 1);

    await renderHome();

    await waitFor(() => expect(syncButtonState().disabled).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// 3. A SKIPPED TAP MUST NEVER SAY "UP TO DATE"
// ---------------------------------------------------------------------------

describe('a tap that loses the lock race', () => {
  /**
   * The button is disabled while the lock is visibly held, but the poll is not
   * instantaneous — a sync can start between a render and a tap. `performSync`
   * then returns `skipped: true`, and the old code fell straight through to
   * `Alert('Up to Date', 'Nothing new to sync.')`.
   *
   * `first-sync.tsx` already treats `skipped` as an issue rather than a success.
   *
   * MUTATION that must go red: delete the `result.skipped` early return.
   */
  it('reports that a sync is already running, never "Up to Date"', async () => {
    mockPerformSync.mockResolvedValue({ ...RESULT_BASE, skipped: true });

    await renderHome();
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));

    fireEvent.press(screen.getByTestId('button-Sync Now'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());

    const titles = (Alert.alert as jest.Mock).mock.calls.map((c) => c[0]);
    expect(titles).toContain('Sync Already Running');
    expect(titles).not.toContain('Up to Date');
    expect(titles).not.toContain('Sync Complete');
  });

  it('a skipped run does not zero the stat tiles or clear the disconnected banner', async () => {
    // A real sync first, so there is a result on screen to be clobbered.
    mockPerformSync.mockResolvedValue({
      ...RESULT_BASE,
      newMessages: 7,
      sentMessages: 7,
    });
    await renderHome();
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));
    fireEvent.press(screen.getByTestId('button-Sync Now'));
    await waitFor(() =>
      expect(screen.getByText('New Messages 7')).toBeTruthy(),
    );

    // Now a tap that loses the race. The 7 must survive.
    mockPerformSync.mockResolvedValue({ ...RESULT_BASE, skipped: true });
    fireEvent.press(screen.getByTestId('button-Sync Now'));
    await waitFor(() =>
      expect(
        (Alert.alert as jest.Mock).mock.calls.map((c) => c[0]),
      ).toContain('Sync Already Running'),
    );

    expect(screen.getByText('New Messages 7')).toBeTruthy();
    expect(screen.getByText('Sent to Desktop 7')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3b. THE LOCAL FLAG IS STILL LOAD-BEARING
// ---------------------------------------------------------------------------

describe('the tap feels instant, before any lock exists', () => {
  /**
   * `syncBusy = syncing || syncInFlight` COMBINES the two rather than replacing
   * the local flag, and this is the window that justifies it: between
   * `setSyncing(true)` and `performSync` actually taking the lock, no lock
   * exists, so a lock-only predicate would leave the button live-looking on the
   * frame right after the tap.
   *
   * Added because dropping `syncing` from the predicate initially went GREEN —
   * every other control mocks `performSync` as already holding (or having held)
   * the lock, so none of them can see this window. The fixture was at fault.
   *
   * MUTATION that must go red: `const syncBusy = syncInFlight;`
   */
  it('greys the button on press even though no sync holds the lock yet', async () => {
    let release: (r: SyncOperationResult) => void = () => undefined;
    mockPerformSync.mockImplementation(
      () =>
        new Promise<SyncOperationResult>((resolve) => {
          release = resolve;
        }),
    );

    await renderHome();
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));
    expect(store()['@keepr/sync-lock']).toBeUndefined();

    fireEvent.press(screen.getByTestId('button-Sync Now'));

    // In flight, and NO lock record exists — only the local flag can know.
    await waitFor(() => expect(syncButtonState().disabled).toBe(true));
    expect(store()['@keepr/sync-lock']).toBeUndefined();
    expect(screen.getByTestId('spinner-Sync Now')).toBeTruthy();

    await act(async () => {
      release({ ...RESULT_BASE });
    });
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// 4. NO REGRESSION ON THE ORDINARY PATH
// ---------------------------------------------------------------------------

describe('an ordinary completed sync', () => {
  /**
   * The busy state must not become sticky. It is derived from a lock the run
   * itself releases, so a bug here would leave the button greyed after a sync
   * the user watched finish.
   */
  it('returns the button to idle and still reports the result', async () => {
    mockPerformSync.mockImplementation(async () => {
      // The real performSync holds the lock for the duration of the run.
      const nonce = (await acquireSyncLock(NOW)) as string;
      await releaseSyncLock(nonce);
      return { ...RESULT_BASE, sentMessages: 3, newMessages: 3 };
    });

    await renderHome();
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));

    fireEvent.press(screen.getByTestId('button-Sync Now'));

    await waitFor(() =>
      expect(
        (Alert.alert as jest.Mock).mock.calls.map((c) => c[0]),
      ).toContain('Sync Complete'),
    );
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));
    expect(screen.queryByTestId('spinner-Sync Now')).toBeNull();
  });

  /**
   * The `finally` RE-READS the lock rather than assuming idle. Our own run has
   * released it, but a background cycle can take it in the same moment — and
   * then the button must stay busy rather than flicker to idle for a poll tick.
   *
   * Added because the obvious mutation (`setSyncInFlight(false)`) initially went
   * GREEN against the other seven controls: no fixture distinguished "released
   * by us" from "immediately held by someone else". An unproven line is an
   * unverified one, so the fixture was the thing at fault, not the mutation.
   *
   * MUTATION that must go red: `setSyncInFlight(false)` in the `finally`.
   */
  it('stays busy when a background cycle takes the lock as our run releases it', async () => {
    mockPerformSync.mockImplementation(async () => {
      const nonce = (await acquireSyncLock(NOW)) as string;
      await releaseSyncLock(nonce);
      // A background cycle grabs it in the same moment.
      await acquireSyncLock(NOW);
      return { ...RESULT_BASE, sentMessages: 3, newMessages: 3 };
    });

    await renderHome();
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));

    fireEvent.press(screen.getByTestId('button-Sync Now'));

    await waitFor(() =>
      expect(
        (Alert.alert as jest.Mock).mock.calls.map((c) => c[0]),
      ).toContain('Sync Complete'),
    );
    // The other run is still going, so the button must NOT read as idle.
    await waitFor(() => expect(syncButtonState().disabled).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// 5. A SYNC THAT STARTS WHILE THE USER IS LOOKING AT THE SCREEN
// ---------------------------------------------------------------------------

describe('the focused screen notices a sync it did not start', () => {
  /**
   * Mount / focus / AppState refreshes cover ARRIVING mid-sync. The OS
   * background task and `appStateCatchup` can start one while the user is
   * already on the screen, which only the poll catches.
   *
   * MUTATION that must go red: delete the polling `useFocusEffect`.
   */
  it('greys the button within a poll tick of the lock being taken', async () => {
    await renderHome();
    await waitFor(() => expect(syncButtonState().disabled).toBe(false));

    // A background cycle takes the lock. Nothing tells the component.
    await act(async () => {
      await acquireSyncLock(NOW);
    });
    expect(syncButtonState().disabled).toBe(false);

    // One poll tick later it has noticed.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    await waitFor(() => expect(syncButtonState().disabled).toBe(true));
  });
});
