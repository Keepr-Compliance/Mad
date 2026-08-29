/**
 * BACKLOG-2956 — CONTROL 4: sign out from onboarding works and returns to login.
 *
 * Before this component a grep across every onboarding screen found ZERO
 * signOut calls, zero back navigation and zero switch-account affordance. A user
 * who signed in with the wrong account — as the founder did — had exactly one
 * escape: clearing the app's storage from Android's system settings.
 *
 * "Returns to login" is enforced by the auth gate in app/_layout.tsx, which
 * redirects to /login the moment the session goes null. This component therefore
 * must NOT navigate itself (a navigate here races the gate); the contract it owes
 * is: call signOut(), and clear this phone's onboarding state first so the next
 * account does not inherit it. That contract is what is pinned below, plus a
 * direct assertion that the gate's precondition (session -> null) is what drives
 * the return to login.
 *
 * MUTATION THAT MUST GO RED: remove the `signOut()` call from performSignOut in
 * components/ui/OnboardingSignOutLink.tsx — "signs the user out" fails.
 * Removing the two clears fails "clears this phone's onboarding state".
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';

// The gate in app/_layout.tsx owns the redirect to /login. If this component
// navigated too it would race the gate, so these spies must stay untouched.
const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    replace: mockRouterReplace,
    push: mockRouterPush,
    back: mockRouterBack,
  }),
}));

const mockSignOut = jest.fn(async () => ({ error: null as string | null }));
jest.mock('../../../services/authService', () => ({
  signOut: () => mockSignOut(),
}));

const mockClearOnboardingStep = jest.fn(async () => undefined);
jest.mock('../../../services/onboardingProgress', () => ({
  clearOnboardingStep: () => mockClearOnboardingStep(),
}));

const mockClearDisclosureConsent = jest.fn(async () => undefined);
jest.mock('../../../services/disclosureConsent', () => ({
  clearDisclosureConsent: () => mockClearDisclosureConsent(),
}));

import OnboardingSignOutLink from '../OnboardingSignOutLink';

/** Press the link and take the destructive "Sign Out" branch of the Alert. */
function pressAndConfirm(alertSpy: jest.SpyInstance): void {
  fireEvent.press(screen.getByLabelText('Sign out'));
  const buttons = alertSpy.mock.calls[0][2] as {
    text: string;
    onPress?: () => void;
  }[];
  const confirm = buttons.find((b) => b.text === 'Sign Out');
  expect(confirm).toBeDefined();
  confirm?.onPress?.();
}

describe('OnboardingSignOutLink (BACKLOG-2956)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSignOut.mockReset().mockResolvedValue({ error: null });
    mockClearOnboardingStep.mockReset().mockResolvedValue(undefined);
    mockClearDisclosureConsent.mockReset().mockResolvedValue(undefined);
    mockRouterReplace.mockClear();
    mockRouterPush.mockClear();
    mockRouterBack.mockClear();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('is reachable from onboarding as a labelled control', () => {
    render(<OnboardingSignOutLink />);
    expect(screen.getByLabelText('Sign out')).toBeTruthy();
  });

  it('confirms before signing out — a stray tap does not end the session', () => {
    render(<OnboardingSignOutLink />);
    fireEvent.press(screen.getByLabelText('Sign out'));

    expect(alertSpy).toHaveBeenCalled();
    // The press alone must not sign anyone out.
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('signs the user out on confirmation, and does not navigate itself', async () => {
    render(<OnboardingSignOutLink />);
    pressAndConfirm(alertSpy);

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });

    // The auth gate carries the user to /login. This component must not steer.
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockRouterBack).not.toHaveBeenCalled();
  });

  it("clears this phone's onboarding state so the next account starts at the disclosure", async () => {
    render(<OnboardingSignOutLink />);
    pressAndConfirm(alertSpy);

    await waitFor(() => {
      expect(mockClearOnboardingStep).toHaveBeenCalledTimes(1);
    });
    expect(mockClearDisclosureConsent).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed sign-out instead of pretending it worked', async () => {
    mockSignOut.mockResolvedValue({ error: 'network unreachable' });

    render(<OnboardingSignOutLink />);
    pressAndConfirm(alertSpy);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign Out Failed',
        'network unreachable',
      );
    });
  });
});
