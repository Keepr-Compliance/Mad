/**
 * BACKLOG-3962 PR4a D1: the desktop sign-in page AWAITS the JIT step before it hands anything to
 * the desktop app, and on domain_managed it shows the message and never deep-links (no mint, no
 * token claim), so a desktop build that does not know the code never sees it.
 * Same page plumbing as __tests__/member-name-3991/desktopCallback.test.tsx.
 */

import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockOrder: string[] = [];
const mockJit = jest.fn();
const mockMint = jest.fn();
const mockClaim = jest.fn();
const mockSignOut = jest.fn();

jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { access_token: 'browser-access', refresh_token: 'r', provider_token: 'provider-access', provider_refresh_token: 'pr' } },
        error: null,
      }),
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1', app_metadata: { provider: 'azure' } } }, error: null }),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }),
  }),
}));
jest.mock('@/lib/actions/syncDesktopIdpNames', () => ({
  syncDesktopIdpNames: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/actions/desktopJitJoin', () => ({
  desktopJitJoin: (...args: unknown[]) => {
    mockOrder.push('jit-start');
    return mockJit(...args);
  },
}));
jest.mock('@/lib/actions/mintDesktopSession', () => ({
  mintDesktopSession: (...args: unknown[]) => {
    mockOrder.push('mint');
    return mockMint(...args);
  },
}));
jest.mock('@/lib/actions/createTokenClaim', () => ({
  createTokenClaim: (...args: unknown[]) => mockClaim(...args),
}));
jest.mock('@/lib/actions/enforceSingleDesktopSession', () => ({
  enforceSingleDesktopSession: jest.fn().mockResolvedValue(undefined),
}));

import DesktopCallbackPage from '@/app/auth/desktop/callback/page';

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  mockMint.mockResolvedValue({ access_token: 'minted-access', refresh_token: 'minted-refresh' });
  mockClaim.mockResolvedValue({ success: true, claimId: 'claim-uuid' });
  mockSignOut.mockResolvedValue({ error: null });
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: { href: '', hash: '', search: '', origin: 'https://portal.test' },
  });
});

describe('D1a the JIT step is awaited before the deep link', () => {
  it('nothing is minted or opened until the join answers, then the app opens', async () => {
    let answer: (v: unknown) => void = () => undefined;
    mockJit.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = (v) => {
            mockOrder.push('jit-done');
            resolve(v);
          };
        })
    );
    render(<DesktopCallbackPage />);
    await waitFor(() => expect(mockJit).toHaveBeenCalledWith('browser-access'));
    // give the page every chance to run ahead
    await new Promise((r) => setTimeout(r, 50));
    expect(mockMint).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');

    answer({ status: 'ok' });
    await waitFor(() => expect(window.location.href).toBe('keepr://callback?claim=claim-uuid'));
    expect(mockOrder).toEqual(['jit-start', 'jit-done', 'mint']);
  });

  it('a rejected JIT step still signs the person in to the app', async () => {
    mockJit.mockRejectedValue(new Error('fixture failure'));
    render(<DesktopCallbackPage />);
    await waitFor(() => expect(window.location.href).toBe('keepr://callback?claim=claim-uuid'));
  });
});

describe('D1b domain_managed never deep-links', () => {
  it('shows the message, signs the browser out, mints nothing, opens nothing', async () => {
    mockJit.mockResolvedValue({ status: 'domain_managed', organizationName: 'Fixture Brokerage A', domain: 'a-3962p4.example.test' });
    render(<DesktopCallbackPage />);
    await waitFor(() => expect(screen.getByTestId('domain-managed-message')).toBeInTheDocument());
    expect(screen.getByTestId('domain-managed-message')).toHaveTextContent(
      'Fixture Brokerage A manages Keepr accounts for @a-3962p4.example.test. Ask Fixture Brokerage A to invite you, then open the invitation email.'
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.href).toBe('');
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.queryByText('Open Keepr')).not.toBeInTheDocument();
  });
});
