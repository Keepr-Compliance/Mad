/**
 * Behavioral guard for BACKLOG-2196 — permission-denial recovery UI on the
 * onboarding permissions screen (first test in android-companion).
 *
 * The bug it accompanies: `permissions.tsx` read `allGranted` before its own
 * `const` declaration (temporal dead zone). Under Hermes this threw
 * `ReferenceError: Cannot access 'allGranted' before initialization` the instant
 * `attempted` flipped true — i.e. the moment the user DENIED (or partially
 * granted) the SMS/contacts prompt — crashing the very screen that holds the
 * recovery buttons. The fix reorders the declaration above its first use.
 *
 * WHAT THIS TEST DOES verify: driven into the DENIED state (attempted=true, not
 * all granted), the screen renders the recovery UI ("Open Settings" / "Skip for
 * Now") and does NOT auto-advance. This locks in the recovery-path behavior.
 *
 * WHAT THIS TEST DOES NOT do: reproduce the Hermes TDZ crash itself. jest runs
 * under jest-expo's Babel transform, which does NOT preserve `const` TDZ
 * semantics — a use-before-declaration does not throw under jest (verified: a
 * minimal `const a = b; const b = 5;` probe returns without a ReferenceError).
 * So this test passes on BOTH the buggy and fixed source and cannot, by itself,
 * catch a re-introduction of the ordering bug. The tool that WOULD catch that
 * class Hermes-independently is a static `no-use-before-define` lint rule;
 * standing up ESLint for android-companion is deferred to BACKLOG-2198 (owns the
 * full test/lint harness). See the PR description and issue-log for detail.
 */
import React from 'react';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';

// --- Mock expo-router: the screen calls useRouter().replace() ---
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- Mock expo-linking. The permissions screen uses react-native's `Linking`,
// NOT expo-linking, but a transitive import (components/ui -> HelpModal ->
// authService) calls expo-linking's `createURL()` at module-load time, which
// needs the expo-constants manifest that isn't present under jest. Stubbing it
// keeps the import graph loadable without touching tested behavior. ---
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));

// --- Mock the `components/ui` barrel. The permissions screen only uses
// `Button`, but the barrel also re-exports `HelpModal`, which transitively pulls
// in pairingManager -> @sentry/react-native + the Supabase client (native
// modules that don't load under jest). We provide a faithful lightweight Button:
// a Pressable whose accessible label is the title, so `getByText(title)` and
// `fireEvent.press` behave exactly as with the real component. ---
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable } = require('react-native');
  const MockButton = ({
    title,
    onPress,
    disabled,
    loading,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) =>
    ReactModule.createElement(
      Pressable,
      { onPress, disabled: disabled || loading, accessibilityRole: 'button' },
      ReactModule.createElement(Text, null, title)
    );
  return { Button: MockButton };
});

// --- Mock the permissions service to simulate the user DENYING both prompts ---
jest.mock('../../../services/permissions', () => ({
  requestSmsPermissions: jest.fn(async () => ({
    readSms: 'denied',
    receiveSms: 'denied',
    allGranted: false,
  })),
  requestContactsPermissions: jest.fn(async () => ({
    readContacts: 'denied',
    granted: false,
  })),
  checkSmsPermissions: jest.fn(async () => ({
    readSms: 'denied',
    receiveSms: 'denied',
    allGranted: false,
  })),
  checkContactsPermissions: jest.fn(async () => ({
    readContacts: 'denied',
    granted: false,
  })),
}));

import PermissionsScreen from '../permissions';

describe('PermissionsScreen — permission denial (BACKLOG-2196)', () => {
  beforeEach(() => {
    // The screen's `withTimeout` helper schedules a 10s setTimeout per permission
    // request as a race fallback. Our mocks resolve instantly (winning the race),
    // but those timers would otherwise stay pending and keep jest from exiting.
    // Fake timers let us clear them deterministically in afterEach.
    jest.useFakeTimers();
    mockReplace.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('renders the recovery UI without crashing after the user denies permissions', async () => {
    // First render is safe (attempted=false). The bug only fires once the user
    // acts, so we must actually drive the denial flow.
    render(<PermissionsScreen />);

    // Tapping "Grant Permissions" runs the (mocked) denied request flow, which
    // sets attempted=true and forces the `hasDeniedPermissions` branch — the
    // exact code path the fix keeps crash-free on Hermes.
    fireEvent.press(screen.getByText('Grant Permissions'));

    // The recovery UI must appear once the denial is recorded.
    await waitFor(() => {
      expect(screen.getByText('Open Settings')).toBeTruthy();
    });

    // Recovery affordances the user needs to recover from a denial.
    expect(screen.getByText('Open Settings')).toBeTruthy();
    expect(screen.getByText('Skip for Now')).toBeTruthy();

    // Denial must NOT auto-advance to the next onboarding step.
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
