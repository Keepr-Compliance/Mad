/**
 * Behavioral guard for the login-screen auth-error notice — BACKLOG-2215.
 *
 * The auth gate (`_layout.tsx`) and the OAuth/magic-link callback route bounce
 * the user to login with an `authError` param when a prior session was lost or
 * a sign-in didn't complete. Before 2215 that bounce was silent. This locks in
 * the user-visible half of the finding:
 *
 *   - authError=expired  -> "Your session expired. Please sign in again."
 *   - authError=callback -> "We couldn't complete sign-in. Please try again."
 *   - no param (first run) -> NO error notice (a normal login).
 *
 * The sign-in options themselves are always present as the retry affordance.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// --- expo-router: the screen reads useLocalSearchParams().authError and calls
// useRouter() (unused here). authError is injected per-test via a mutable var. ---
let mockAuthError: string | undefined;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ authError: mockAuthError }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

// --- expo-linking: a transitive import chain calls createURL() at module load. ---
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `keepr-companion://${path}`,
}));

// --- expo-linear-gradient: render as a plain View so the card content mounts. ---
jest.mock('expo-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: { children?: React.ReactNode }) =>
      ReactModule.createElement(View, props, children),
  };
});

// --- expo-web-browser: the screen warms/cools the in-app browser on mount. ---
// BACKLOG-2956: the login screen shows the running build so support can get it
// without the user signing in. Distinct native values prove the string is read
// from the package manifest rather than the JS app config.
jest.mock('expo-application', () => ({
  __esModule: true,
  nativeApplicationVersion: '7.7.7',
  nativeBuildVersion: '42',
}));

jest.mock('expo-web-browser', () => ({
  warmUpAsync: jest.fn(),
  coolDownAsync: jest.fn(),
}));

// --- authService: mocked so the screen doesn't pull in the Supabase client. ---
jest.mock('../../services/authService', () => ({
  signInWithGoogle: jest.fn(async () => ({ error: null })),
  signInWithMicrosoft: jest.fn(async () => ({ error: null })),
  signInWithEmail: jest.fn(async () => ({ error: null })),
}));

// --- components/ui barrel: the login screen uses BrandMark / GoogleIcon /
// MicrosoftIcon; the real barrel also re-exports HelpModal, which transitively
// pulls in pairingManager -> @sentry/react-native + the Supabase client. Provide
// lightweight stubs for just the icons the screen renders. ---
jest.mock('../../components/ui', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Stub = () => ReactModule.createElement(View, null);
  return { BrandMark: Stub, GoogleIcon: Stub, MicrosoftIcon: Stub };
});

import LoginScreen from '../login';

const EXPIRED_COPY = 'Your session expired. Please sign in again.';
const CALLBACK_COPY = "We couldn't complete sign-in. Please try again.";

describe('LoginScreen — auth-error notice (BACKLOG-2215)', () => {
  afterEach(() => {
    mockAuthError = undefined;
  });

  it('shows the session-expired notice when authError=expired', () => {
    mockAuthError = 'expired';
    render(<LoginScreen />);
    expect(screen.getByText(EXPIRED_COPY)).toBeTruthy();
    // Retry affordance is present.
    expect(screen.getByText('Continue with Google')).toBeTruthy();
  });

  it('shows the callback-failure notice when authError=callback', () => {
    mockAuthError = 'callback';
    render(<LoginScreen />);
    expect(screen.getByText(CALLBACK_COPY)).toBeTruthy();
  });

  it('shows NO error notice on a first-run login (no authError param)', () => {
    mockAuthError = undefined;
    render(<LoginScreen />);
    expect(screen.queryByText(EXPIRED_COPY)).toBeNull();
    expect(screen.queryByText(CALLBACK_COPY)).toBeNull();
    // The sign-in options still render.
    expect(screen.getByText('Continue with Google')).toBeTruthy();
  });
  // -------------------------------------------------------------------------
  // BACKLOG-2956 — the build must be identifiable from the SIGN-IN screen.
  //
  // Settings > About shows the same string, but it is behind the login wall,
  // and sign-in is itself one of the failures a field tester reported
  // (BACKLOG-2955). A support call needs the build number exactly when the user
  // is stuck here.
  // -------------------------------------------------------------------------

  it('shows the running build without requiring sign-in', () => {
    mockAuthError = undefined;
    render(<LoginScreen />);

    const version = screen.getByTestId('login-version');
    // Verbatim: this is the string a user reads back on a support call.
    expect(version.props.children).toBe('7.7.7 (42)');
  });

  it('still shows the build when sign-in has failed', () => {
    // The case that matters most — the user cannot get past this screen.
    mockAuthError = 'callback';
    render(<LoginScreen />);

    expect(screen.getByTestId('login-version').props.children).toBe('7.7.7 (42)');
  });
});
