/**
 * BACKLOG-4007 PR-3 (SR finding 4): /dashboard/setup shows the guide only for a deal that is waiting
 * for setup, or active with a billing start date. Anything else says there is nothing to set up.
 * Fixtures: ./fixtures.ts (view shape captured from broker_get_billing_setup).
 */
import { render, screen } from '@testing-library/react';
import { SETUP_VIEW_ACTIVE } from './fixtures';

const mockRead = jest.fn();
jest.mock('next/navigation', () => ({
  notFound: jest.fn(),
  redirect: jest.fn(),
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: async () => null }));
jest.mock('@/lib/actions/billingSetup', () => ({ completeBillingSetup: jest.fn(), askAboutPrice: jest.fn() }));
jest.mock('@/lib/auth/portalAccess', () => ({
  getPortalAccess: async () => ({
    access: { kind: 'full', role: 'broker', organizationId: 'ORG-4007-PAGE' },
    user: { app_metadata: { provider: 'google' } },
    supabase: {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Realty', microsoft_tenant_id: null } }) }) }),
      }),
    },
  }),
}));
jest.mock('@/lib/billing/setupState', () => ({
  ...jest.requireActual('@/lib/billing/setupState'),
  readBillingSetup: (...a: unknown[]) => mockRead(...a),
}));

import SetupGuideRoute from '@/app/dashboard/setup/page';

async function renderPage() {
  render(await SetupGuideRoute({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => jest.clearAllMocks());

describe('/dashboard/setup for a deal that is not waiting', () => {
  it('an active deal with a billing start date still shows the Done step', async () => {
    mockRead.mockResolvedValue(SETUP_VIEW_ACTIVE);
    await renderPage();
    expect(screen.getByText('Setup is complete')).toBeTruthy();
  });

  it('an active deal with no billing start date shows "nothing to set up"', async () => {
    mockRead.mockResolvedValue({ ...SETUP_VIEW_ACTIVE, billing_starts_on: null });
    await renderPage();
    expect(screen.getByText(/nothing to set up/i)).toBeTruthy();
    expect(screen.queryByText('Setup is complete')).toBeNull();
  });

  it.each(['canceled', 'suspended'])('a %s deal shows "nothing to set up"', async (state) => {
    mockRead.mockResolvedValue({ ...SETUP_VIEW_ACTIVE, state });
    await renderPage();
    expect(screen.getByText(/nothing to set up/i)).toBeTruthy();
    expect(screen.queryByText('Setup is complete')).toBeNull();
  });
});
