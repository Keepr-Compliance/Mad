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
import { render, waitFor, screen } from '@testing-library/react-native';
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

// --- Mock AsyncStorage: handleComplete() persists an onboarding flag. ---
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
}));

// --- Mock the background sync service. `performSync` is the function under test;
// its return shape drives which branch first-sync renders. `startBackgroundSync`
// is awaited before performSync and must resolve. We swap `performSync`'s
// implementation per-test. ---
const mockPerformSync = jest.fn<Promise<SyncOperationResult>, []>();
jest.mock('../../../services/backgroundSync', () => ({
  startBackgroundSync: jest.fn(async () => undefined),
  performSync: () => mockPerformSync(),
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
  desktopReachable: true,
  queueSize: 0,
};

/** Desktop unreachable: the false-"Sync Complete" case from BACKLOG-2201. */
const unreachableResult: SyncOperationResult = {
  newMessages: 3,
  sentMessages: 0,
  contactsSynced: 0,
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
