/**
 * Behavioral guard for the onboarding permissions screen recovery UI.
 *
 * BACKLOG-2196 (regression it still guards): `permissions.tsx` read `allGranted`
 * before its own `const` declaration (temporal dead zone). Under Hermes this
 * threw `ReferenceError: Cannot access 'allGranted' before initialization` the
 * instant `attempted` flipped true — i.e. the moment the user DENIED the prompt —
 * crashing the very screen that holds the recovery buttons. These tests keep the
 * post-denial render crash-free and non-auto-advancing.
 *
 * BACKLOG-2223 (behavior these tests now pin): the recovery affordance must
 * depend on WHETHER the denial is still re-askable.
 *   - SOFT denial (denied, not never_ask_again) → in-app "Try Again" that
 *     re-requests the permission (re-triggers the OS prompt), NOT a Settings
 *     deep-link.
 *   - BLOCKED (never_ask_again) → "Open Settings" + deep-link, and NO "Try Again"
 *     (a blocked permission cannot be re-requested in-app).
 *   - Try Again → granted proceeds like a normal grant; Try Again → hard-denied
 *     (now blocked) falls through to "Open Settings" (no stuck retry loop).
 *
 * WHAT THESE TESTS DO NOT do: reproduce the Hermes TDZ crash itself. jest runs
 * under jest-expo's Babel transform, which does not preserve `const` TDZ
 * semantics, so a use-before-declaration does not throw under jest. The tool that
 * would catch a re-introduction Hermes-independently is a static
 * `no-use-before-define` lint rule (BACKLOG-2198 owns the full lint harness).
 */
import React from 'react';
import { Linking } from 'react-native';
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

// --- Mock onboardingProgress (BACKLOG-2216): the screen persists its step on
// mount. Mocking it keeps this test off AsyncStorage and lets us assert the
// step-persistence wiring directly. ---
const mockSetOnboardingStep = jest.fn(async (_step: string) => undefined);
jest.mock('../../../services/onboardingProgress', () => ({
  setOnboardingStep: (step: string) => mockSetOnboardingStep(step),
}));

// --- Mock the permissions service. Declared as bare jest.fn()s so each test can
// drive the exact permission outcome (soft-denied / blocked / granted) via
// mockResolvedValue. Defaults are set in beforeEach. ---
jest.mock('../../../services/permissions', () => ({
  requestSmsPermissions: jest.fn(),
  requestContactsPermissions: jest.fn(),
  checkSmsPermissions: jest.fn(),
  checkContactsPermissions: jest.fn(),
}));

import {
  requestSmsPermissions,
  requestContactsPermissions,
  checkSmsPermissions,
  checkContactsPermissions,
} from '../../../services/permissions';
import PermissionsScreen from '../permissions';

const mockRequestSms = requestSmsPermissions as jest.Mock;
const mockRequestContacts = requestContactsPermissions as jest.Mock;
const mockCheckSms = checkSmsPermissions as jest.Mock;
const mockCheckContacts = checkContactsPermissions as jest.Mock;

// Permission result fixtures.
const SMS_DENIED = { readSms: 'denied', receiveSms: 'denied', allGranted: false };
const SMS_BLOCKED = { readSms: 'never_ask_again', receiveSms: 'never_ask_again', allGranted: false };
const SMS_GRANTED = { readSms: 'granted', receiveSms: 'granted', allGranted: true };
const CONTACTS_DENIED = { readContacts: 'denied', granted: false };
const CONTACTS_BLOCKED = { readContacts: 'never_ask_again', granted: false };
const CONTACTS_GRANTED = { readContacts: 'granted', granted: true };

describe('PermissionsScreen — denial recovery (BACKLOG-2196 / BACKLOG-2223)', () => {
  let openSettingsSpy: jest.SpyInstance;

  beforeEach(() => {
    // The screen's `withTimeout` helper schedules a 10s setTimeout per permission
    // request as a race fallback. Our mocks resolve instantly (winning the race),
    // but those timers would otherwise stay pending and keep jest from exiting.
    // Fake timers let us clear them deterministically in afterEach.
    jest.useFakeTimers();
    mockReplace.mockClear();
    mockSetOnboardingStep.mockClear();

    // Default: a plain SOFT denial of both permissions (still re-askable).
    mockRequestSms.mockReset().mockResolvedValue(SMS_DENIED);
    mockRequestContacts.mockReset().mockResolvedValue(CONTACTS_DENIED);
    mockCheckSms.mockReset().mockResolvedValue(SMS_DENIED);
    mockCheckContacts.mockReset().mockResolvedValue(CONTACTS_DENIED);

    openSettingsSpy = jest
      .spyOn(Linking, 'openSettings')
      .mockImplementation(async () => undefined);
  });

  afterEach(() => {
    openSettingsSpy.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // BACKLOG-2223: soft (re-askable) denial → in-app "Try Again", not Settings.
  it('shows in-app "Try Again" (not Open Settings) on a soft denial and re-requests in-app', async () => {
    render(<PermissionsScreen />);

    fireEvent.press(screen.getByText('Grant Permissions'));

    await waitFor(() => {
      expect(screen.getByText('Try Again')).toBeTruthy();
    });

    // Open Settings is NOT the affordance here — the OS can still re-prompt.
    expect(screen.queryByText('Open Settings')).toBeNull();
    // Denial must NOT auto-advance to the next onboarding step (BACKLOG-2196).
    expect(mockReplace).not.toHaveBeenCalled();

    // Grant Permissions already invoked the request path once.
    expect(mockRequestSms).toHaveBeenCalledTimes(1);

    // Tapping Try Again re-requests IN-APP (re-triggers the OS prompt), and must
    // NOT fall back to the Settings deep-link.
    fireEvent.press(screen.getByText('Try Again'));
    await waitFor(() => {
      expect(mockRequestSms).toHaveBeenCalledTimes(2);
    });
    expect(mockRequestContacts).toHaveBeenCalledTimes(2);
    expect(openSettingsSpy).not.toHaveBeenCalled();
  });

  // BACKLOG-2223: permanently-blocked (never_ask_again) → Open Settings, no Try Again.
  it('shows "Open Settings" and NO "Try Again" when a permission is permanently blocked', async () => {
    mockRequestSms.mockResolvedValue(SMS_BLOCKED);
    mockRequestContacts.mockResolvedValue(CONTACTS_BLOCKED);

    render(<PermissionsScreen />);
    fireEvent.press(screen.getByText('Grant Permissions'));

    await waitFor(() => {
      expect(screen.getByText('Open Settings')).toBeTruthy();
    });

    expect(screen.queryByText('Try Again')).toBeNull();
    // The recovery affordances for a blocked permission.
    expect(screen.getByText('I Updated Settings')).toBeTruthy();
    expect(screen.getByText('Skip for Now')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // BACKLOG-2223: Try Again → granted proceeds exactly like a normal grant.
  it('proceeds to pair-device when Try Again resolves to granted', async () => {
    render(<PermissionsScreen />);
    fireEvent.press(screen.getByText('Grant Permissions'));

    await waitFor(() => {
      expect(screen.getByText('Try Again')).toBeTruthy();
    });

    // The user flips the toggles in the OS prompt this time.
    mockRequestSms.mockResolvedValue(SMS_GRANTED);
    mockRequestContacts.mockResolvedValue(CONTACTS_GRANTED);

    fireEvent.press(screen.getByText('Try Again'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/onboarding/pair-device');
    });
  });

  // BACKLOG-2223: Try Again → hard-denied (now blocked) falls through to Settings.
  it('falls through to "Open Settings" when Try Again gets hard-denied (now blocked)', async () => {
    render(<PermissionsScreen />);
    fireEvent.press(screen.getByText('Grant Permissions'));

    await waitFor(() => {
      expect(screen.getByText('Try Again')).toBeTruthy();
    });

    // Second deny flips SMS to never_ask_again (common on Android 11+/Samsung).
    mockRequestSms.mockResolvedValue(SMS_BLOCKED);
    mockRequestContacts.mockResolvedValue(CONTACTS_BLOCKED);

    fireEvent.press(screen.getByText('Try Again'));

    await waitFor(() => {
      expect(screen.getByText('Open Settings')).toBeTruthy();
    });

    // No stuck retry loop, and no crash reaching the blocked branch.
    expect(screen.queryByText('Try Again')).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // BACKLOG-2216: the screen must persist its step on mount so an interrupted
  // onboarding resumes here rather than restarting from the beginning.
  it('persists its onboarding step on mount', () => {
    render(<PermissionsScreen />);
    expect(mockSetOnboardingStep).toHaveBeenCalledWith('permissions');
  });
});
