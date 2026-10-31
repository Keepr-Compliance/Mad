/**
 * BACKLOG-3991 C29: the desktop sign-in page sends the names BEFORE it mints the
 * desktop session, and a failure in the name sync still mints and deep-links.
 * Same page plumbing as __tests__/app/auth/desktop/from-desktop-marker-3394.test.tsx.
 */

import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockOrder: string[] = [];
const mockSync = jest.fn();
const mockMint = jest.fn();

jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { access_token: 'browser-access', refresh_token: 'r', provider_token: 'provider-access', provider_refresh_token: 'pr' } },
        error: null,
      }),
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1', app_metadata: { provider: 'google' } } }, error: null }),
      signOut: jest.fn().mockResolvedValue({ error: null }),
    },
    from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }),
  }),
}));
jest.mock('@/lib/actions/syncDesktopIdpNames', () => ({
  syncDesktopIdpNames: (...args: unknown[]) => {
    mockOrder.push('sync');
    return mockSync(...args);
  },
}));
jest.mock('@/lib/actions/mintDesktopSession', () => ({
  mintDesktopSession: (...args: unknown[]) => {
    mockOrder.push('mint');
    return mockMint(...args);
  },
}));
jest.mock('@/lib/actions/createTokenClaim', () => ({
  createTokenClaim: jest.fn().mockResolvedValue({ success: true, claimId: 'claim-uuid' }),
}));
jest.mock('@/lib/actions/enforceSingleDesktopSession', () => ({
  enforceSingleDesktopSession: jest.fn().mockResolvedValue(undefined),
}));

import DesktopCallbackPage from '@/app/auth/desktop/callback/page';

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  mockMint.mockResolvedValue({ access_token: 'minted-access', refresh_token: 'minted-refresh' });
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: { href: '', hash: '', search: '', origin: 'https://portal.test' },
  });
});

async function renderToDeepLink(): Promise<void> {
  render(<DesktopCallbackPage />);
  await waitFor(() => expect(screen.getByText('Opening Keepr...')).toBeInTheDocument(), { timeout: 4000 });
}

describe('C29 names before the mint', () => {
  it('sync is called with the browser access token and the provider token, before mintDesktopSession', async () => {
    mockSync.mockResolvedValue(undefined);
    await renderToDeepLink();
    expect(mockSync).toHaveBeenCalledWith('browser-access', 'provider-access');
    expect(mockOrder).toEqual(['sync', 'mint']);
    expect(window.location.href).toBe('keepr://callback?claim=claim-uuid');
  });

  it('a rejected sync still mints and deep-links', async () => {
    mockSync.mockRejectedValue(new Error('fixture failure'));
    await renderToDeepLink();
    expect(mockOrder).toEqual(['sync', 'mint']);
    expect(window.location.href).toBe('keepr://callback?claim=claim-uuid');
  });
});
