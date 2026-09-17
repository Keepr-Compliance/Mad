/**
 * BACKLOG-3394 — no "Download Keepr" screen for someone who just signed in FROM
 * the desktop app.
 *
 * ============================================================================
 * THE DEFECT, WHICH IS NOT A MATTER OF TASTE
 * ============================================================================
 *
 * `/auth/desktop/callback` asked the `devices` table whether the user has the
 * app. The desktop app writes that row inside its deep-link handler, which runs
 * AFTER this page has rendered. So on a first-ever desktop sign-in the query
 * necessarily comes back empty and the page says "It looks like you don't have
 * Keepr installed yet" to a user who is staring at the app that opened the tab.
 *
 * ============================================================================
 * WHAT EACH TEST IS FOR
 * ============================================================================
 *
 *  - The marker is WRITTEN by `/auth/desktop` when the desktop app opened the
 *    tab, and NOT written for a plain browser visit.
 *  - The marker is READ by the callback page, which then renders no Download
 *    call-to-action.
 *  - **Anti-vacuity:** with no marker and no `devices` row — a genuine
 *    browser-first visitor who really may not have the app — Download is STILL
 *    the primary action. Without this, the fix is indistinguishable from
 *    "delete the download screen", which would break real new users.
 *  - **Ordering:** the first operation the flow performs on the storage key is
 *    a write. A read-before-write (a marker nothing ever sets, or one set too
 *    late to be seen) is exactly the failure that would leave the download
 *    screen in place while every other assertion here still passed.
 *  - **The retry path:** `/auth/desktop?error=session_expired` and the "Try
 *    Again" link both re-enter the sign-in page WITHOUT `?from=desktop`. If the
 *    absence of the parameter cleared the marker, a user whose first attempt
 *    hit a stale session would land on the download screen for their second.
 */

import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  FROM_DESKTOP_STORAGE_KEY,
  arrivedFromDesktop,
  markArrivedFromDesktop,
} from '@/lib/desktop-handoff';

// ---------------------------------------------------------------------------
// Portal plumbing the two pages pull in
// ---------------------------------------------------------------------------

let currentSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useSearchParams: () => currentSearchParams,
}));

const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn().mockResolvedValue({ error: null });
const mockDevicesRows = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
      signInWithOAuth: jest.fn().mockResolvedValue({ error: null }),
      signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => mockDevicesRows(),
        }),
      }),
    }),
  }),
}));

jest.mock('@/lib/actions/mintDesktopSession', () => ({
  mintDesktopSession: jest.fn().mockResolvedValue({
    access_token: 'minted-access',
    refresh_token: 'minted-refresh',
  }),
}));

jest.mock('@/lib/actions/createTokenClaim', () => ({
  createTokenClaim: jest
    .fn()
    .mockResolvedValue({ success: true, claimId: 'claim-uuid' }),
}));

jest.mock('@/lib/actions/enforceSingleDesktopSession', () => ({
  enforceSingleDesktopSession: jest.fn().mockResolvedValue(undefined),
}));

import DesktopLoginPage from '@/app/auth/desktop/page';
import DesktopCallbackPage from '@/app/auth/desktop/callback/page';

const DOWNLOAD_CTA = 'Download Keepr';
const NOT_INSTALLED_COPY = /don.t have Keepr installed yet/i;
const SUCCESS_COPY = 'Sign in successful!';

/**
 * jsdom does not implement navigation, and the callback page assigns
 * `window.location.href` to fire the deep link. Replace location with a plain
 * object so the assignment is inert instead of raising a "Not implemented"
 * error that would bury a real failure in noise.
 */
function stubLocation(): void {
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: { href: '', hash: '', search: '', origin: 'https://portal.test' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  currentSearchParams = new URLSearchParams();
  stubLocation();

  mockGetSession.mockResolvedValue({
    data: {
      session: {
        access_token: 'browser-access',
        refresh_token: 'browser-refresh',
        provider_token: 'provider-access',
        provider_refresh_token: 'provider-refresh',
      },
    },
    error: null,
  });
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1', app_metadata: { provider: 'google' } } },
    error: null,
  });
  // The first-ever desktop sign-in: the app has not written its devices row yet.
  mockDevicesRows.mockResolvedValue({ data: [] });
});

/** Render the callback page and wait for it to reach its terminal success state. */
async function renderCallbackToSuccess(): Promise<void> {
  render(<DesktopCallbackPage />);
  await waitFor(
    () => expect(screen.getByText(SUCCESS_COPY)).toBeInTheDocument(),
    // The page deliberately waits 2s before revealing the success state.
    { timeout: 6000 },
  );
}

// ---------------------------------------------------------------------------

describe('BACKLOG-3394: the from-desktop marker', () => {
  it('is written by the sign-in page when the desktop app opened the tab', () => {
    currentSearchParams = new URLSearchParams('from=desktop');

    render(<DesktopLoginPage />);

    expect(window.sessionStorage.getItem(FROM_DESKTOP_STORAGE_KEY)).toBe('1');
  });

  it('is NOT written for a plain browser visit to the sign-in page', () => {
    currentSearchParams = new URLSearchParams();

    render(<DesktopLoginPage />);

    expect(window.sessionStorage.getItem(FROM_DESKTOP_STORAGE_KEY)).toBeNull();
  });

  it('survives a re-entry to the sign-in page that carries no from parameter', () => {
    currentSearchParams = new URLSearchParams('from=desktop');
    const first = render(<DesktopLoginPage />);
    first.unmount();

    // The stale-session bounce: /auth/desktop?error=session_expired
    currentSearchParams = new URLSearchParams('error=session_expired');
    render(<DesktopLoginPage />);

    expect(window.sessionStorage.getItem(FROM_DESKTOP_STORAGE_KEY)).toBe('1');
  });

  it('reads false before anything has written it', () => {
    expect(arrivedFromDesktop()).toBe(false);
    markArrivedFromDesktop('desktop');
    expect(arrivedFromDesktop()).toBe(true);
  });

  it('is written before it is ever read, across the two pages', async () => {
    const ops: string[] = [];
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const getSpy = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(function (this: Storage, key: string) {
        const value = realGet.call(this, key);
        if (key === FROM_DESKTOP_STORAGE_KEY) ops.push(`get:${value}`);
        return value;
      });
    const setSpy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === FROM_DESKTOP_STORAGE_KEY) ops.push(`set:${value}`);
        realSet.call(this, key, value);
      });

    try {
      currentSearchParams = new URLSearchParams('from=desktop');
      const login = render(<DesktopLoginPage />);
      login.unmount();

      await renderCallbackToSuccess();

      // The first thing that ever happens to this key is a write. If the write
      // were missing or later than the read, ops[0] would be a get — and the
      // read would have answered null.
      expect(ops.length).toBeGreaterThan(1);
      expect(ops[0]).toBe('set:1');
      expect(ops).toContain('get:1');
      expect(ops.indexOf('set:1')).toBeLessThan(ops.indexOf('get:1'));
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});

describe('BACKLOG-3394: what the callback page renders', () => {
  it('offers no Download call-to-action when the marker is present', async () => {
    window.sessionStorage.setItem(FROM_DESKTOP_STORAGE_KEY, '1');

    await renderCallbackToSuccess();

    expect(screen.queryByText(DOWNLOAD_CTA)).not.toBeInTheDocument();
    expect(screen.queryByText(NOT_INSTALLED_COPY)).not.toBeInTheDocument();
    expect(screen.getByText('Open Keepr')).toBeInTheDocument();
  });

  it('STILL offers Download to a browser-first visitor with no marker and no devices row', async () => {
    // No marker written, and the devices query answers empty — the genuine
    // "this person may not have the app" case the check exists for.
    await renderCallbackToSuccess();

    expect(screen.getByText(DOWNLOAD_CTA)).toBeInTheDocument();
    expect(screen.getByText(NOT_INSTALLED_COPY)).toBeInTheDocument();
  });

  it('offers no Download call-to-action even when the devices query says the user has no app', async () => {
    // The marker OVERRIDES the devices proxy — which is the whole point, since
    // the row is written after this page renders and is empty on a first sign-in.
    window.sessionStorage.setItem(FROM_DESKTOP_STORAGE_KEY, '1');
    mockDevicesRows.mockResolvedValue({ data: [] });

    await renderCallbackToSuccess();

    expect(screen.queryByText(DOWNLOAD_CTA)).not.toBeInTheDocument();
  });
});
