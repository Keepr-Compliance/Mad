/**
 * Behavioral guard for the auth-callback failure branch — BACKLOG-2215.
 *
 * Before 2215 this route unconditionally `router.replace('/')` after 500ms, so a
 * callback that carried a provider error or never established a session dropped
 * the user onto a broken home screen. It now resolves the callback deliberately:
 *
 *   - SUCCESS (magic-link tokens set a session) -> replace('/')
 *   - SUCCESS (OAuth already set the session)    -> replace('/')
 *   - FAILURE (explicit error in the URL)        -> replace(/login?authError=callback), NOT '/'
 *   - FAILURE (no session established)           -> replace(/login?authError=callback), NOT '/'
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// --- expo-router: capture router.replace so we can assert the destination. ---
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// --- expo-linking: the callback reads the deep link via useURL(); injected per-test. ---
let mockURL: string | null = null;
jest.mock('expo-linking', () => ({
  useURL: () => mockURL,
}));

// --- authService: mock the two seams the callback uses to resolve the outcome. ---
const mockGetSession = jest.fn();
const mockExtractSessionFromUrl = jest.fn();
jest.mock('../../../services/authService', () => ({
  getSession: () => mockGetSession(),
  extractSessionFromUrl: (url: string) => mockExtractSessionFromUrl(url),
}));

import AuthCallback from '../callback';

const LOGIN_FAILURE = {
  pathname: '/login',
  params: { authError: 'callback' },
};

describe('AuthCallback — resolution branches (BACKLOG-2215)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReplace.mockClear();
    mockGetSession.mockReset();
    mockExtractSessionFromUrl.mockReset();
    mockURL = null;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('routes home when a magic-link URL establishes a session', async () => {
    mockURL =
      'keepr-companion://auth/callback#access_token=a&refresh_token=b';
    mockExtractSessionFromUrl.mockResolvedValue(null); // null == success

    render(<AuthCallback />);
    await jest.advanceTimersByTimeAsync(300);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockExtractSessionFromUrl).toHaveBeenCalledWith(mockURL);
    // getSession is not consulted once tokens are present.
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('routes home when the OAuth path already established a session', async () => {
    mockURL = null; // no tokens in the URL
    mockGetSession.mockResolvedValue({ user: { id: 'u1' } });

    render(<AuthCallback />);
    await jest.advanceTimersByTimeAsync(300);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('routes to login with an error when the callback URL carries an error', async () => {
    mockURL =
      'keepr-companion://auth/callback#error=access_denied&error_description=expired';

    render(<AuthCallback />);
    await jest.advanceTimersByTimeAsync(300);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(LOGIN_FAILURE),
    );
    // The failure short-circuits: no token extraction, no blind replace to '/'.
    expect(mockExtractSessionFromUrl).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalledWith('/');
  });

  it('routes to login with an error when no session was established', async () => {
    mockURL = null;
    mockGetSession.mockResolvedValue(null);

    render(<AuthCallback />);
    await jest.advanceTimersByTimeAsync(300);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(LOGIN_FAILURE),
    );
    expect(mockReplace).not.toHaveBeenCalledWith('/');
  });

  it('routes to login with an error when magic-link setSession fails', async () => {
    mockURL =
      'keepr-companion://auth/callback#access_token=a&refresh_token=b';
    mockExtractSessionFromUrl.mockResolvedValue('token expired'); // error string

    render(<AuthCallback />);
    await jest.advanceTimersByTimeAsync(300);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(LOGIN_FAILURE),
    );
    expect(mockReplace).not.toHaveBeenCalledWith('/');
  });
});
