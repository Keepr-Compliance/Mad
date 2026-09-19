/**
 * Dashboard page header (BACKLOG-3077)
 *
 * Renders the REAL dashboard server component and asserts the exact <h1>
 * string. A test against the helper alone would stay green if page.tsx went
 * back to a hardcoded title, which is the regression this file exists to catch.
 *
 * The Supabase clients, the impersonation guard and next/link are mocked; the
 * header resolution under test is not.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// next/link needs an app-router context that RTL does not provide.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mockRedirect = jest.fn();
jest.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

const mockGetUser = jest.fn();
const mockAuthFrom = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockAuthFrom }),
}));

const mockGetDataClient = jest.fn();
jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: () => mockGetDataClient(),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));

import DashboardPage from '@/app/dashboard/page';

/** A Supabase query builder stand-in: every filter returns itself, and the
 *  builder itself is awaitable (the page awaits the chain, not a terminal). */
function queryBuilder(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'neq', 'eq', 'order', 'limit', 'in', 'gt']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.maybeSingle = jest.fn(async () => result);
  builder.single = jest.fn(async () => result);
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

/** Submission queries: no rows, no error. */
const dataClient = { from: jest.fn(() => queryBuilder({ data: [], error: null })) };

beforeEach(() => {
  jest.clearAllMocks();
  // organization_members lookup for the it_admin redirect guard.
  mockAuthFrom.mockImplementation(() => queryBuilder({ data: { role: 'agent' }, error: null }));
  mockGetDataClient.mockResolvedValue({
    client: dataClient,
    impersonation: null,
    targetUserId: null,
    organizationId: null,
  });
  mockGetUser.mockResolvedValue({ data: { user: null } });
});

function signedInAs(user: unknown) {
  mockGetUser.mockResolvedValue({ data: { user } });
}

async function renderDashboard() {
  render(await DashboardPage());
  return screen.getByRole('heading', { level: 1 });
}

describe('dashboard header', () => {
  it('greets a signed-in user by first name', async () => {
    signedInAs({
      id: 'user-1',
      email: 'john.doe@example.com',
      user_metadata: { full_name: 'John Doe' },
    });

    expect((await renderDashboard()).textContent).toBe('Welcome back, John');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('greets by email local part when the profile carries no name', async () => {
    signedInAs({ id: 'user-1', email: 'jdoe@example.com', user_metadata: {} });

    expect((await renderDashboard()).textContent).toBe('Welcome back, jdoe');
  });

  it('falls back to "Dashboard" when there is no name and no email', async () => {
    signedInAs(null);

    expect((await renderDashboard()).textContent).toBe('Dashboard');
  });

  it('names the impersonated user, not the admin driving the session', async () => {
    // The admin IS signed in — the header must still name the target user.
    signedInAs({
      id: 'admin-1',
      email: 'admin@example.com',
      user_metadata: { full_name: 'Pat Riverton' },
    });
    mockGetDataClient.mockResolvedValue({
      client: dataClient,
      impersonation: {
        session_id: 'sess-1',
        target_user_id: 'target-1',
        admin_user_id: 'admin-1',
        target_email: 'jane.seller@example.com',
        target_name: 'Jane Seller',
        expires_at: '2099-01-01T00:00:00Z',
        started_at: '2026-01-01T00:00:00Z',
      },
      targetUserId: 'target-1',
      organizationId: 'org-1',
    });

    expect((await renderDashboard()).textContent).toBe('Welcome back, Jane');
  });

  it('keeps the submissions overview line as the subtitle', async () => {
    signedInAs({
      id: 'user-1',
      email: 'john.doe@example.com',
      user_metadata: { full_name: 'John Doe' },
    });

    render(await DashboardPage());
    expect(screen.getByText('Overview of transaction submissions')).toBeInTheDocument();
  });
});
