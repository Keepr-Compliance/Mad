/**
 * Behavioral guard for BACKLOG-2201 — false "Sync Complete" on the onboarding
 * first-sync screen.
 *
 * The bug it accompanies: `first-sync.tsx` rendered the error branch only when
 * `error && !syncResult`. But `performSync` (backgroundSync.ts) returns a
 * POPULATED result object even when nothing transferred — when the desktop is
 * unreachable (or the phone isn't paired) it sets `desktopReachable: false` and
 * an `error` string but STILL returns a result. Because `syncResult` was then
 * truthy, the old guard fell through to the SUCCESS branch and showed a green ✅
 * "Sync Complete" for a zero-transfer sync, with "Desktop Reachable: No" buried
 * in the results card where a non-technical user won't read it.
 *
 * The fix keys the error branch on `desktopReachable === false` (the definitive
 * "nothing got through" signal, covering both the unreachable and not-paired
 * cases) OR a thrown error, while leaving the genuine-partial case
 * (desktopReachable === true WITH an error, i.e. a send failed mid-transfer)
 * on its legitimate "Partially Synced" path.
 *
 * WHAT THIS TEST DOES verify:
 *   1. desktop-unreachable result (desktopReachable:false + error) -> ⚠️ "Sync
 *      Issue" + "Retry Sync", and NOT the ✅ "Sync Complete" headline.
 *   2. genuine success (desktopReachable:true, no error) -> ✅ "Sync Complete".
 *   3. genuine partial (desktopReachable:true + error) -> ✅ "Partially Synced"
 *      (the legit partial path is preserved, not swallowed by the fix).
 */
import React from 'react';
import {
  render,
  waitFor,
  screen,
  fireEvent,
  act,
} from '@testing-library/react-native';
import type { SyncOperationResult } from '../../../services/backgroundSync';

// --- Mock expo-router: the screen calls useRouter().replace() ---
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- Mock expo-linking (see permissions.test.tsx): a transitive import via the
// components/ui barrel calls createURL() at module-load time, needing the
// expo-constants manifest that isn't present under jest. ---
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));

// --- Mock AsyncStorage (kept for any transitive use under jest). ---
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => undefined),
}));

// --- onboardingProgress (BACKLOG-2216): the screen persists its step on mount
// and calls completeOnboarding() on finish. Mock both so the test stays off
// AsyncStorage internals. ---
jest.mock('../../../services/onboardingProgress', () => ({
  setOnboardingStep: jest.fn(async () => undefined),
  completeOnboarding: jest.fn(async () => undefined),
}));

// --- Mock the background sync service. `performSync` is the function under test;
// its return shape drives which branch first-sync renders. `startBackgroundSync`
// is awaited before performSync and must resolve. We swap `performSync`'s
// implementation per-test. ---
const mockPerformSync = jest.fn<Promise<SyncOperationResult>, [unknown?]>();
// `stopBackgroundSync` is the cancel/unpair path. The first-sync screen must
// NEVER call it (skipping only unblocks the UI — the sync keeps running), so we
// expose it as a spy to assert it stays untouched (BACKLOG-2211).
const mockStopBackgroundSync = jest.fn(async () => undefined);
jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  stopBackgroundSync: () => mockStopBackgroundSync(),
  // BACKLOG-3005: FORWARD the options. Dropping them is why mutating the
  // `maxCycles` binding at either call site left this suite green.
  performSync: (options?: unknown) => mockPerformSync(options),
  // The REAL constant. Omitting it made the screen pass `maxCycles: undefined`
  // — i.e. depth 1 — inside this suite only, so the very binding under test was
  // neutralised by its own harness. Re-exporting the mock's own literal would
  // be no better: the assertion would compare the mock against itself.
  MAX_SYNC_CYCLES_PER_RUN: jest.requireActual('../../../services/syncDepth')
    .MAX_SYNC_CYCLES_PER_RUN,
}));

// --- Mock the `components/ui` barrel (see permissions.test.tsx rationale). The
// real barrel transitively pulls in @sentry/react-native + the Supabase client,
// native modules that don't load under jest. We provide faithful lightweight
// stand-ins: Button is a Pressable whose label is its title; Card renders its
// title + children; CardRow renders "label value"; CardDivider is inert. ---
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable, View } = require('react-native');
  const Button = ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    ReactModule.createElement(
      Pressable,
      { onPress, disabled, accessibilityRole: 'button' },
      ReactModule.createElement(Text, null, title)
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
      children
    );
  const CardRow = ({ label, value }: { label: string; value: string }) =>
    ReactModule.createElement(Text, null, `${label} ${value}`);
  const CardDivider = () => null;
  return { Button, Card, CardRow, CardDivider };
});

import FirstSyncScreen from '../first-sync';

/** A fully-successful sync: desktop reachable, no error. */
const successResult: SyncOperationResult = {
  newMessages: 12,
  sentMessages: 12,
  contactsSynced: 5,
  newContacts: 5,
  desktopReachable: true,
  queueSize: 0,
};

/** Desktop unreachable: the false-"Sync Complete" case from BACKLOG-2201. */
const unreachableResult: SyncOperationResult = {
  newMessages: 3,
  sentMessages: 0,
  contactsSynced: 0,
  newContacts: 0,
  desktopReachable: false,
  queueSize: 3,
  error: 'Desktop app is not running. Open Keepr on your computer and try again.',
  errorType: 'connection_refused',
};

/** Genuine partial: desktop WAS reachable but a send failed mid-transfer. */
const partialResult: SyncOperationResult = {
  newMessages: 10,
  sentMessages: 4,
  contactsSynced: 5,
  newContacts: 5,
  desktopReachable: true,
  queueSize: 6,
  error: 'Some messages could not be sent.',
  errorType: 'network_after_connect',
};

describe('FirstSyncScreen — false "Sync Complete" (BACKLOG-2201)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPerformSync.mockReset();
  });

  it('shows the error/retry UI (NOT "Sync Complete") when the desktop is unreachable', async () => {
    mockPerformSync.mockResolvedValue(unreachableResult);

    render(<FirstSyncScreen />);

    // The error headline must appear once the (populated-but-failed) result lands.
    await waitFor(() => {
      expect(screen.getByText('Sync Issue')).toBeTruthy();
    });

    // Retry must be offered so the user can recover.
    expect(screen.getByText('Retry Sync')).toBeTruthy();

    // The false-success affordances must NOT be shown for a zero-transfer sync.
    expect(screen.queryByText('Sync Complete')).toBeNull();
    expect(screen.queryByText('Partially Synced')).toBeNull();
    // The user must not have been auto-advanced into the app.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('shows "Sync Complete" when the sync genuinely succeeds', async () => {
    mockPerformSync.mockResolvedValue(successResult);

    render(<FirstSyncScreen />);

    await waitFor(() => {
      expect(screen.getByText('Sync Complete')).toBeTruthy();
    });

    // The genuine-success path must not surface the error headline or a retry.
    expect(screen.queryByText('Sync Issue')).toBeNull();
    expect(screen.queryByText('Retry Sync')).toBeNull();
  });

  it('keeps the legitimate "Partially Synced" path when the desktop was reachable but a send failed', async () => {
    mockPerformSync.mockResolvedValue(partialResult);

    render(<FirstSyncScreen />);

    await waitFor(() => {
      expect(screen.getByText('Partially Synced')).toBeTruthy();
    });

    // A reachable-but-partial sync is NOT the false-success bug: it should keep
    // the ✅ partial treatment (not the ⚠️ error headline) while still offering retry.
    expect(screen.queryByText('Sync Issue')).toBeNull();
    expect(screen.getByText('Retry Sync')).toBeTruthy();
  });
});

/**
 * Behavioral guard for BACKLOG-2211 — first-sync Skip + hard timeout (spinner
 * escape).
 *
 * The bug it accompanies: `first-sync.tsx` rendered a BARE, indefinite
 * `ActivityIndicator` while `performSync` ran, with no Skip/Cancel/timeout.
 * `performSync` has no wall-clock cap on its network reads/sends, so a stalled
 * read stranded the user on "Step 3 of 3" with no escape (force-quit just
 * re-enters onboarding).
 *
 * The fix arms a hard timeout when the sync starts: if it hasn't resolved within
 * the bound (injectable `timeoutMs` prop, default 30s) the indefinite spinner is
 * replaced by an escape UI ("Taking longer than expected" + "Continue to App" /
 * "Keep Waiting"). Skipping unblocks the flow WITHOUT cancelling the sync — it
 * keeps running (and, via startBackgroundSync, in the background). A resolved
 * sync (success OR genuine error) always takes precedence over the timeout UI.
 */
describe('FirstSyncScreen — Skip + hard timeout (BACKLOG-2211)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPerformSync.mockReset();
    mockStopBackgroundSync.mockClear();
  });

  it('replaces the indefinite spinner with the escape UI after the hard timeout, and Skip advances into the app WITHOUT cancelling the in-flight sync', async () => {
    // A sync that never resolves on its own — the stalled-read case that used to
    // strand the user on the spinner forever.
    let resolveSync!: (r: SyncOperationResult) => void;
    mockPerformSync.mockImplementation(
      () =>
        new Promise<SyncOperationResult>((res) => {
          resolveSync = res;
        }),
    );

    render(<FirstSyncScreen timeoutMs={50} />);

    // Initially the spinner is shown (with the always-present escape hatch).
    await waitFor(() => {
      expect(screen.getByText('First Sync')).toBeTruthy();
    });
    expect(screen.getByText('Skip for now')).toBeTruthy();

    // After the bound elapses, the indefinite spinner is replaced by the escape UI.
    await waitFor(() => {
      expect(screen.getByText('Taking longer than expected')).toBeTruthy();
    });
    expect(screen.getByText('Continue to App')).toBeTruthy();
    expect(screen.getByText('Keep Waiting')).toBeTruthy();
    // This is the generic slow-but-fine timeout, NOT the ⚠️ error path.
    expect(screen.queryByText('Sync Issue')).toBeNull();

    // Skip → the user is advanced into the app.
    fireEvent.press(screen.getByText('Continue to App'));
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(main)/home');
    });

    // The sync was NOT cancelled: no stop/unpair was invoked, performSync was
    // started exactly once (skip did not abort or re-run it), and the in-flight
    // promise is still free to resolve to completion after the skip.
    expect(mockStopBackgroundSync).not.toHaveBeenCalled();
    expect(mockPerformSync).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSync(successResult);
    });
  });

  it('lets the user Skip straight from the spinner (before the timeout) without cancelling the sync', async () => {
    let resolveSync!: (r: SyncOperationResult) => void;
    mockPerformSync.mockImplementation(
      () =>
        new Promise<SyncOperationResult>((res) => {
          resolveSync = res;
        }),
    );

    // Large bound so the timeout never fires within the test — we exercise the
    // always-present spinner-level "Skip for now".
    render(<FirstSyncScreen timeoutMs={100_000} />);

    await waitFor(() => {
      expect(screen.getByText('Skip for now')).toBeTruthy();
    });
    // Still the spinner, not the timeout escalation.
    expect(screen.queryByText('Taking longer than expected')).toBeNull();

    fireEvent.press(screen.getByText('Skip for now'));
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/(main)/home');
    });

    expect(mockStopBackgroundSync).not.toHaveBeenCalled();
    await act(async () => {
      resolveSync(successResult);
    });
  });

  it('shows the genuine error/Retry path (NOT the timeout screen) when the sync fails', async () => {
    // Resolves fast with a desktop-unreachable failure — the 2201/2206 error path.
    mockPerformSync.mockResolvedValue(unreachableResult);

    render(<FirstSyncScreen timeoutMs={50} />);

    await waitFor(() => {
      expect(screen.getByText('Sync Issue')).toBeTruthy();
    });
    expect(screen.getByText('Retry Sync')).toBeTruthy();

    // The generic timeout escape UI must NOT hijack a real error — even after the
    // bound would have elapsed, the resolved error state stays put.
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText('Taking longer than expected')).toBeNull();
    expect(screen.getByText('Sync Issue')).toBeTruthy();
  });

  it('completes a fast successful first sync normally, with no premature timeout/skip escape UI', async () => {
    mockPerformSync.mockResolvedValue(successResult);

    render(<FirstSyncScreen timeoutMs={50} />);

    await waitFor(() => {
      expect(screen.getByText('Sync Complete')).toBeTruthy();
    });

    // A fast sync must never flash the timeout escape UI.
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText('Taking longer than expected')).toBeNull();
    expect(screen.queryByText('Continue to App')).toBeNull();
    expect(screen.getByText('Sync Complete')).toBeTruthy();
  });
});

describe('FirstSyncScreen — skipped SMS permission gating (BACKLOG-2214)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockPerformSync.mockReset();
  });

  it('a permission_denied read (user skipped SMS access in onboarding) is a "Sync Issue", NOT a false "Sync Complete", with grant-to-sync setup copy', async () => {
    // performSync short-circuits on a not-granted READ_SMS permission and returns
    // a permission_denied readError (BACKLOG-2209 proactive check). During
    // onboarding this is always the never-granted case.
    mockPerformSync.mockResolvedValue({
      newMessages: 0,
      sentMessages: 0,
      contactsSynced: 0,
      newContacts: 0,
      desktopReachable: true,
      queueSize: 0,
      readError: {
        reason: 'permission_denied',
        message: 'READ_SMS permission is not granted',
      },
    });

    render(<FirstSyncScreen timeoutMs={50} />);

    // Truthful not-syncing state, not a green checkmark.
    await waitFor(() => {
      expect(screen.getByText('Sync Issue')).toBeTruthy();
    });
    expect(screen.queryByText('Sync Complete')).toBeNull();

    // BACKLOG-2214: the never-granted SETUP copy (grant to START syncing), NOT the
    // revoked "no longer has permission" wording — the same single surface as the
    // home grant-to-sync banner, cause-appropriate for onboarding.
    expect(
      screen.getByText(
        /allow SMS access so your texts start syncing to the desktop/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no longer has permission/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3005 — THE CALL-SITE BINDING ITSELF
// ---------------------------------------------------------------------------

describe('the onboarding first sync asks for a full drain', () => {
  /**
   * Every other control in this file asserts what the screen RENDERS for a
   * given result. None asserted what `performSync` was CALLED WITH — so
   * mutating `maxCycles` to 1 here left the whole suite green while silently
   * reinstating the founder-reported bug for a first-time pairing, which is the
   * exact path a new user's history arrives on.
   *
   * The constant is imported from the REAL module: comparing against the mock's
   * own literal would assert the mock against itself.
   *
   * MUTATION that must go red: change `maxCycles` at either `performSync` call
   * site in `first-sync.tsx` to 1.
   */
  it('passes maxCycles = MAX_SYNC_CYCLES_PER_RUN, not a single pass', async () => {
    const { MAX_SYNC_CYCLES_PER_RUN } = jest.requireActual<{
      MAX_SYNC_CYCLES_PER_RUN: number;
    }>('../../../services/syncDepth');

    mockPerformSync.mockResolvedValue(successResult);
    render(<FirstSyncScreen />);

    await waitFor(() => expect(mockPerformSync).toHaveBeenCalled());

    expect(MAX_SYNC_CYCLES_PER_RUN).toBeGreaterThan(1);
    for (const [options] of mockPerformSync.mock.calls) {
      expect(options).toEqual({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    }
  });

  /**
   * The RETRY call site is a separate binding and was equally unproven. A
   * skipped first attempt drives the loop into it.
   */
  it('the skip-retry call site asks for a full drain too', async () => {
    mockPerformSync
      .mockResolvedValueOnce({ ...successResult, skipped: true })
      .mockResolvedValue(successResult);

    const { MAX_SYNC_CYCLES_PER_RUN } = jest.requireActual<{
      MAX_SYNC_CYCLES_PER_RUN: number;
    }>('../../../services/syncDepth');

    render(<FirstSyncScreen />);

    await waitFor(() => expect(mockPerformSync.mock.calls.length).toBeGreaterThan(1));
    for (const [options] of mockPerformSync.mock.calls) {
      expect(options).toEqual({ maxCycles: MAX_SYNC_CYCLES_PER_RUN });
    }
  });
});
