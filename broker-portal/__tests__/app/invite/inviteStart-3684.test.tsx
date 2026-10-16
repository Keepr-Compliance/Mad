/**
 * BACKLOG-3684 — the invitation page stores the link's token (POST
 * /api/invite/start, purpose "invite") BEFORE the OAuth redirect, sends every
 * role and provider to /auth/callback (J-route), and starts no sign-in when the
 * start call fails. /login shows a message for every invite code the callback
 * can send.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockSignInWithOAuth = jest.fn();
let mockError: string | null = null;
jest.mock('next/navigation', () => ({
  useParams: () => ({ token: 'fixture0page0token03684' }),
  useSearchParams: () => ({ get: (k: string) => (k === 'error' ? mockError : null) }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: mockSignInWithOAuth, getUser: async () => ({ data: { user: null } }) } }),
}));

import InviteAcceptPage from '@/app/invite/[token]/page';
import LoginPage from '@/app/login/page';

const fetchMock = jest.fn();

function respond(startOk: boolean, role = 'Admin') {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/invite/validate')) {
      return { ok: true, json: async () => ({ valid: true, email: 'x@fixture.example.test', orgName: 'Fixture Brokerage', role }) };
    }
    if (url === '/api/invite/start') return { ok: startOk, status: startOk ? 204 : 400 };
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockSignInWithOAuth.mockResolvedValue({ error: null });
});

describe('invitation page', () => {
  it.each([
    ['Microsoft', 'Sign in with Microsoft', 'azure'],
    ['Google', 'Sign in with Google', 'google'],
  ])('%s, admin invite: start first, then OAuth to /auth/callback', async (_n, label, provider) => {
    respond(true, 'Admin');
    render(<InviteAcceptPage />);
    fireEvent.click(await screen.findByText(label));
    await waitFor(() => expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1));

    const startCall = fetchMock.mock.calls.find((c) => c[0] === '/api/invite/start');
    expect(startCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(startCall?.[1].body)).toEqual({ token: 'fixture0page0token03684', purpose: 'invite' });
    const order = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.indexOf(startCall!)];
    expect(order).toBeLessThan(mockSignInWithOAuth.mock.invocationCallOrder[0]);

    const opts = mockSignInWithOAuth.mock.calls[0][0];
    expect(opts.provider).toBe(provider);
    expect(opts.options.redirectTo).toBe(`${window.location.origin}/auth/callback`);
  });

  it('start fails -> no OAuth, an error is shown', async () => {
    respond(false);
    render(<InviteAcceptPage />);
    fireEvent.click(await screen.findByText('Sign in with Microsoft'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });
});

describe('/login messages for the invite codes', () => {
  it.each(['invite_link_required', 'invalid_invite', 'email_mismatch', 'expired', 'already_placed', 'invite_failed'])(
    '%s shows its message',
    async (code) => {
      mockError = code;
      render(<LoginPage />);
      const alert = await screen.findByRole('alert');
      expect((alert.textContent ?? '').trim().length).toBeGreaterThan(30);
      expect((alert.textContent ?? '').trim()).not.toBe(code);
    }
  );
});
