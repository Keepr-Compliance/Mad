/**
 * BACKLOG-3851 — every code /auth/setup/callback can send to /setup shows a
 * message on the page. The codes come from the route's SetupRejection union
 * (a type, erased at runtime, so read from source) plus 'auth_failed'; the
 * page is rendered with each one in the query string.
 */
import { render, screen } from '@testing-library/react';
import { readSource } from '../../helpers/appRoutes';

let mockError: string | null = null;
jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: (k: string) => (k === 'error' ? mockError : null) }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import SetupPage from '@/app/setup/page';

function rejectionCodes(): string[] {
  const src = readSource('app', 'auth', 'setup', 'callback', 'route.ts');
  const union = /type SetupRejection =([^;]+);/.exec(src);
  if (!union) throw new Error('SetupRejection union not found in route.ts');
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const CODES = [...rejectionCodes(), 'auth_failed'];

describe('/setup error messages', () => {
  it('reads every route code (guards the parser)', () => {
    expect(CODES).toEqual(
      expect.arrayContaining([
        'azure_only', 'no_tenant', 'consumer_account', 'no_email',
        'no_invite', 'tenant_in_use', 'tenant_mismatch', 'provision_failed', 'auth_failed',
      ])
    );
  });

  it.each(CODES)('%s shows a message', async (code) => {
    mockError = code;
    render(<SetupPage />);
    const alert = await screen.findByRole('alert');
    expect((alert.textContent ?? '').trim().length).toBeGreaterThan(20);
  });

  it('no error code: no alert (the alert is driven by the code)', async () => {
    mockError = null;
    render(<SetupPage />);
    await screen.findByText('Connect your brokerage');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tenant_in_use tells the user to contact Keepr support', async () => {
    mockError = 'tenant_in_use';
    render(<SetupPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('Contact Keepr support');
  });
});
