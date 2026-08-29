/**
 * BACKLOG-2956 — CONTROL 2: consent is AFFIRMATIVE.
 *
 * Google Play does not accept implied consent for a prominent disclosure: the
 * user has to press something. "Continuing automatically does not count." So the
 * disclosure screen has exactly one advancing path — the consent button — and
 * mounting it, settling its effects, or scrolling it must record nothing and
 * navigate nowhere.
 *
 * MUTATION THAT MUST GO RED: add an auto-advance to disclosure.tsx, e.g. record
 * consent inside the mount effect —
 *     useEffect(() => { void recordDisclosureConsent();
 *                       router.replace('/onboarding/permissions'); }, []);
 * The "does not consent on its own" test then fails on both assertions.
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act, screen } from '@testing-library/react-native';

// --- expo-router ---
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- The consent service under test at this call site. ---
const mockRecordDisclosureConsent = jest.fn(async () => undefined);
jest.mock('../../../services/disclosureConsent', () => ({
  recordDisclosureConsent: () => mockRecordDisclosureConsent(),
}));

// --- onboardingProgress: the screen persists its step on mount. ---
const mockSetOnboardingStep = jest.fn(async (_step: string) => undefined);
jest.mock('../../../services/onboardingProgress', () => ({
  setOnboardingStep: (step: string) => mockSetOnboardingStep(step),
}));

// --- components/ui barrel: faithful lightweight Button (same shape the other
// onboarding suites use), so getByText(title) + fireEvent.press behave as real. ---
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
      ReactModule.createElement(Text, null, title),
    );
  return { Button: MockButton };
});

// --- The sign-out link: real component pulls authService -> expo-linking
// createURL() at module scope. Its behavior has its own suite. ---
jest.mock('../../../components/ui/OnboardingSignOutLink', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: () => ReactModule.createElement(Text, null, 'Sign out'),
  };
});

import DisclosureScreen from '../disclosure';

const CONSENT_BUTTON = 'Agree and Continue';

describe('DisclosureScreen — affirmative consent (BACKLOG-2956)', () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockSetOnboardingStep.mockClear();
    mockRecordDisclosureConsent.mockReset().mockResolvedValue(undefined);
  });

  it('does not consent on its own: mounting and settling records nothing and navigates nowhere', async () => {
    render(<DisclosureScreen />);

    // Let every mount effect and microtask settle — an auto-advance would fire here.
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRecordDisclosureConsent).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    // Proof the screen actually rendered, so the two "not called" assertions
    // above are a real refusal rather than an empty render.
    expect(screen.getByText(CONSENT_BUTTON)).toBeTruthy();
  });

  it('positive control: pressing the consent button records consent, THEN advances', async () => {
    render(<DisclosureScreen />);

    fireEvent.press(screen.getByText(CONSENT_BUTTON));

    await waitFor(() => {
      expect(mockRecordDisclosureConsent).toHaveBeenCalledTimes(1);
    });
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/permissions');
  });

  it('a failed consent write does NOT advance the user into the permission prompt', async () => {
    mockRecordDisclosureConsent.mockRejectedValue(new Error('storage full'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    render(<DisclosureScreen />);
    fireEvent.press(screen.getByText(CONSENT_BUTTON));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    // An unrecorded consent is an ungranted consent: stay on the disclosure.
    expect(mockReplace).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('persists its onboarding step on mount so an interruption resumes here', () => {
    render(<DisclosureScreen />);
    expect(mockSetOnboardingStep).toHaveBeenCalledWith('disclosure');
  });

  // The disclosure is legally load-bearing: Play requires it to state WHAT is
  // collected, WHY, that it is TRANSMITTED off the device, and — because this app
  // syncs from a background task — that it happens in the BACKGROUND. Silent
  // deletion of any of those is a compliance regression, so they are pinned here.
  it('states what is collected, why, that it is transmitted, and that it runs in the background', () => {
    render(<DisclosureScreen />);

    // What + why + transmission + background, in the lede sentence.
    expect(
      screen.getByText(/collects your text messages and contacts/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/sends them to the Keepr app on your own computer/i),
    ).toBeTruthy();
    expect(screen.getByText(/in the background, when this app is closed/i)).toBeTruthy();

    // The destination claim, stated where the user is looking at transmission.
    expect(screen.getByText(/sent over your local network/i)).toBeTruthy();
  });

  // BACKLOG-2956: the copy must not overstate collection. services/smsReader.ts
  // reads the SMS inbox and sent boxes only — there is no MMS reader anywhere in
  // the repo, and app.json declares no MMS permission. Claiming MMS here would
  // contradict the Play Data Safety declaration.
  it('does not claim to collect MMS, and says so explicitly', () => {
    render(<DisclosureScreen />);
    expect(
      screen.getByText(/does not read picture or group messages \(MMS\)/i),
    ).toBeTruthy();
  });
});
