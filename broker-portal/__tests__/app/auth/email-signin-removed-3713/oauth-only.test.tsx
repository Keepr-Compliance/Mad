/**
 * BACKLOG-3713 — email sign-in (magic link / one-time code) is removed from the
 * broker portal. Microsoft and Google are the only ways in.
 *
 * What each test pins:
 *  - Both sign-in pages (`/login` and `/auth/desktop`) render exactly the two
 *    provider buttons and no email field, email button, or email-link copy.
 *  - Clicking a provider button starts OAuth and never calls `signInWithOtp`.
 *  - No source file under `app/` or `lib/` calls `signInWithOtp` (a re-added
 *    call on any page, not just these two, turns this red).
 *  - The desktop hand-off is NOT part of the removal: the callback still asks
 *    the server to mint the desktop its own session and hands THAT session on.
 *    `mintDesktopSession` uses an admin-generated one-time link server-side; it
 *    sends no email and is unaffected by removing the email UI.
 */

import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

let currentSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useSearchParams: () => currentSearchParams,
}));

const mockSignInWithOAuth = jest.fn().mockResolvedValue({ error: null });
const mockSignInWithOtp = jest.fn().mockResolvedValue({ error: null });
const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
const mockSignOut = jest.fn().mockResolvedValue({ error: null });

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      getUser: mockGetUser,
      signOut: mockSignOut,
      signInWithOAuth: mockSignInWithOAuth,
      signInWithOtp: mockSignInWithOtp,
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: [] }),
        }),
      }),
    }),
  }),
}));

const mockMint = jest.fn();
jest.mock('@/lib/actions/mintDesktopSession', () => ({
  mintDesktopSession: (...a: unknown[]) => mockMint(...a),
}));

const mockCreateTokenClaim = jest.fn();
jest.mock('@/lib/actions/createTokenClaim', () => ({
  createTokenClaim: (...a: unknown[]) => mockCreateTokenClaim(...a),
}));

const mockEnforce = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/actions/enforceSingleDesktopSession', () => ({
  enforceSingleDesktopSession: (...a: unknown[]) => mockEnforce(...a),
}));

import LoginPage from '@/app/login/page';
import DesktopLoginPage from '@/app/auth/desktop/page';
import DesktopCallbackPage from '@/app/auth/desktop/callback/page';

const PORTAL_ROOT = path.resolve(__dirname, '../../../..');
const EMAIL_COPY = /magic link|email link|check your email|continue with email|enter your email/i;

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
});

const PAGES: Array<[string, () => JSX.Element]> = [
  ['/login', () => <LoginPage />],
  ['/auth/desktop', () => <DesktopLoginPage />],
];

describe.each(PAGES)('%s renders Microsoft and Google only', (_name, renderPage) => {
  it('shows exactly the two provider buttons and no email sign-in', async () => {
    const { container } = render(renderPage());

    await screen.findByRole('button', { name: /continue with google/i });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Continue with Google', 'Continue with Microsoft']);

    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(EMAIL_COPY);
  });

  it.each([
    ['Continue with Google', 'google'],
    ['Continue with Microsoft', 'azure'],
  ])('%s starts OAuth and never sends an email code', async (label, provider) => {
    render(renderPage());
    fireEvent.click(await screen.findByRole('button', { name: label }));

    await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1));
    expect(mockSignInWithOAuth.mock.calls[0][0].provider).toBe(provider);
    expect(mockSignInWithOtp).not.toHaveBeenCalled();
  });
});

describe('no portal source calls signInWithOtp', () => {
  function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('finds the source files it is scanning, including both sign-in pages', () => {
    const files = [...walk(path.join(PORTAL_ROOT, 'app'), []), ...walk(path.join(PORTAL_ROOT, 'lib'), [])];
    // Normalise to forward slashes so the expected paths also match on Windows.
    const rel = files.map((f) => path.relative(PORTAL_ROOT, f).split(path.sep).join('/'));
    expect(rel).toEqual(expect.arrayContaining(['app/login/page.tsx', 'app/auth/desktop/page.tsx']));
    expect(files.length).toBeGreaterThan(50);

    const offenders = rel.filter((r, i) => /signInWithOtp\s*\(/.test(fs.readFileSync(files[i], 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('desktop hand-off still mints its own session (not removed)', () => {
  it('calls the server mint with the browser session token and hands the MINTED session on', async () => {
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
      data: { user: { id: 'user-1', app_metadata: { provider: 'azure' } } },
      error: null,
    });
    mockMint.mockResolvedValue({ access_token: 'minted-access', refresh_token: 'minted-refresh' });
    mockCreateTokenClaim.mockResolvedValue({ success: true, claimId: 'claim-1' });

    render(<DesktopCallbackPage />);

    await waitFor(() => expect(mockCreateTokenClaim).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(mockMint).toHaveBeenCalledWith('browser-access');

    const [userId, tokens, provider] = mockCreateTokenClaim.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(tokens).toEqual({
      access_token: 'minted-access',
      refresh_token: 'minted-refresh',
      provider_token: 'provider-access',
      provider_refresh_token: 'provider-refresh',
    });
    expect(provider).toBe('azure');
    expect(mockEnforce).toHaveBeenCalledWith('minted-access');
    expect(window.location.href).toBe('keepr://callback?claim=claim-1');
  });
});
