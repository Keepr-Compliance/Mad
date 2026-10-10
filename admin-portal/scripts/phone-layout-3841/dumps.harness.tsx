/**
 * BACKLOG-3841 admin-portal layout harness — markup dumps (NOT a CI test).
 *
 * Renders the real components in jsdom and writes each container's HTML to
 * $DUMP_DIR/<name>.html. run.sh then compiles the real Tailwind CSS for that
 * markup and measures it in Chromium at several widths (measure.cjs).
 *
 * Run through run.sh only. Uses its own vitest config, so the portal's CI
 * vitest run (*.test.{ts,tsx}) never picks this file up.
 *
 * Every id, name and address is invented. Shapes follow the component prop
 * types (lib/support-types.ts, lib/admin-queries.ts AdminSearchUser,
 * OrganizationRow, MemberRow, lib/billing-queries.ts BillingData).
 */

import { render, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { writeFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { vi, it, afterEach } from 'vitest';

const AGENT_ID = 'agent-1';

// A chainable stand-in for a Supabase client: every builder call returns the
// chain; awaiting it (or .single()/.maybeSingle()) resolves to empty data.
function fakeQuery(resolve: () => unknown): unknown {
  const p: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const v = { data: resolve(), error: null, count: 0 };
        return (ok: (x: unknown) => unknown) => Promise.resolve(v).then(ok);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve({ data: null, error: null });
      }
      return () => p;
    },
  });
  return p;
}
const mockFakeClient = {
  from: () => fakeQuery(() => []),
  rpc: () => fakeQuery(() => null),
  auth: {
    getUser: async () => ({ data: { user: null }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
  },
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }) }) },
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
};

let mockPathname = '/dashboard';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'ticket-1' }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    const Lazy = React.lazy(() => loader().then((c) => ({ default: c })));
    return function Dynamic(props: Record<string, unknown>) {
      return (
        <React.Suspense fallback={null}>
          <Lazy {...props} />
        </React.Suspense>
      );
    };
  },
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => mockFakeClient }));
vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'agent-1', email: 'agent.one@example.test', user_metadata: { full_name: 'Avery Example' } },
    session: null,
    loading: false,
    signOut: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({ hasPermission: () => true, roleName: 'Super Admin', loading: false, permissions: [] }),
  PermissionsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const LONG_EMAIL = 'requester.with-a-longer-address@example-brokerage.test';

function ticket(i: number) {
  return {
    id: `ticket-${i}`,
    ticket_number: 1000 + i,
    subject: `Cannot export the audit package for an invented transaction number ${i}`,
    description: 'The export button spins and never finishes.',
    status: 'in_progress' as const,
    priority: 'high' as const,
    ticket_type: null,
    category_id: null,
    subcategory_id: null,
    requester_id: null,
    requester_email: LONG_EMAIL,
    requester_name: 'Requester Example',
    assignee_id: AGENT_ID,
    organization_id: null,
    source_channel: 'web_form' as const,
    pending_reason: null,
    first_response_at: null,
    resolved_at: null,
    closed_at: null,
    reopened_count: 0,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    category_name: 'Exports',
    assignee_name: 'Avery Example',
    assignee_email: 'agent.one@example.test',
  };
}

vi.mock('@/lib/support-queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const keep = new Set(['buildCategoryTree', 'notifyTicketCreated']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) {
    out[k] = typeof v === 'function' && !keep.has(k) ? vi.fn(async () => []) : v;
  }
  out.listTickets = vi.fn(async () => ({
    tickets: [1, 2, 3].map(ticket),
    total_count: 3,
    page: 1,
    page_size: 20,
    total_pages: 1,
  }));
  out.getTicketStats = vi.fn(async () => ({
    total_open: 12,
    unassigned: 3,
    by_status: { new: 3, in_progress: 9 },
    by_priority: { urgent: 1, high: 4 },
  }));
  out.getRelatedTickets = vi.fn(async () => ({ auto_related: [], manual_links: [] }));
  out.getTicketDiagnostics = vi.fn(async () => null);
  out.getTicketDetail = vi.fn(async () => ({
    ticket: ticket(1),
    messages: [
      {
        id: 'msg-1',
        ticket_id: 'ticket-1',
        sender_id: null,
        sender_email: LONG_EMAIL,
        sender_name: 'Requester Example',
        message_type: 'reply',
        body: 'Still spinning after a restart.',
        created_at: '2026-10-01T11:00:00Z',
        edited_at: null,
        edited_by: null,
      },
      {
        id: 'msg-2',
        ticket_id: 'ticket-1',
        sender_id: AGENT_ID,
        sender_email: 'agent.one@example.test',
        sender_name: 'Avery Example',
        message_type: 'internal_note',
        body: 'Reproduced on a fixture account.',
        created_at: '2026-10-01T12:00:00Z',
        edited_at: null,
        edited_by: null,
      },
    ],
    events: [],
    attachments: [
      {
        id: 'att-1',
        ticket_id: 'ticket-1',
        message_id: null,
        file_name: 'export-screenshot.png',
        file_size: 120000,
        file_type: 'image/png',
        storage_path: 'x/att-1',
        uploaded_by: null,
        created_at: '2026-10-01T10:00:00Z',
      },
    ],
    participants: [],
  }));
  return out;
});

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    supabase: {
      from: (table: string) =>
        ({
          internal_roles: fakeSingle({ role_id: 'r1', role: { name: 'Super Admin', slug: 'super_admin' } }),
          organizations: fakeSingle({
            id: 'org-1',
            name: 'Invented Brokerage Group of the Pacific Northwest',
            slug: 'invented-brokerage-group-of-the-pacific-northwest',
            max_seats: 25,
            created_at: '2025-01-01T00:00:00Z',
            organization_plans: [{ plan_id: 'p1', plans: { id: 'p1', name: 'Professional', tier: 'professional' } }],
          }),
          organization_members: fakeList(
            [1, 2, 3].map((i) => ({
              user_id: `u${i}`,
              role: 'agent',
              license_status: 'active',
              joined_at: '2025-02-01T00:00:00Z',
              users: { id: `u${i}`, email: LONG_EMAIL, display_name: `Agent Number${i}`, status: 'active', suspended_at: null },
            }))
          ),
        })[table] ?? fakeList([]),
      rpc: async () => ({ data: true, error: null }),
    },
    user: { id: AGENT_ID, email: 'agent.one@example.test', user_metadata: { full_name: 'Avery Example' } },
  }),
  createClient: async () => mockFakeClient,
}));

function fakeSingle(row: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'is', 'order', 'limit']) chain[m] = () => chain;
  chain.single = async () => ({ data: row, error: null });
  return chain;
}
function fakeList(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'order', 'limit']) chain[m] = () => chain;
  // `.is('user_id', null)` selects pending invitations: none in this fixture.
  chain.is = () => fakeList([]);
  chain.then = (ok: (x: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
  return chain;
}

import DashboardLayout from '@/app/dashboard/layout';
import DashboardPage from '@/app/dashboard/page';
import SupportPage from '@/app/dashboard/support/page';
import MyTicketsPage from '@/app/dashboard/support/my-tickets/page';
import TicketDetailPage from '@/app/dashboard/support/[id]/page';
import { UserResultsTable } from '@/app/dashboard/users/components/UserResultsTable';
import { UserProfileCard } from '@/app/dashboard/users/[id]/components/UserProfileCard';
import { DevicesTable } from '@/app/dashboard/users/[id]/components/DevicesTable';
import { AuditLogTable } from '@/app/dashboard/users/[id]/components/AuditLogTable';
import { BillingCreditsCard } from '@/app/dashboard/users/[id]/components/BillingCreditsCard';
import { OrganizationsTable } from '@/app/dashboard/organizations/components/OrganizationsTable';
import OrganizationDetailPage from '@/app/dashboard/organizations/[id]/page';

const DIR = process.env.DUMP_DIR as string;
const dump = (name: string, html: string) => writeFileSync(join(DIR, `${name}.html`), html);

afterEach(() => {
  cleanup();
  mockPathname = '/dashboard';
});

const placeholderPage = (
  <div className="max-w-4xl mx-auto">
    <h1 className="text-2xl font-bold">Placeholder page</h1>
    <p>Body text for the layout harness.</p>
  </div>
);

it('shell-expanded / shell-collapsed / drawer-open', async () => {
  const { container, getByRole, queryByRole } = render(<DashboardLayout>{placeholderPage}</DashboardLayout>);
  await act(async () => {});
  dump('shell-expanded', container.innerHTML);

  fireEvent.click(getByRole('button', { name: 'Collapse sidebar' }));
  dump('shell-collapsed', container.innerHTML);
  fireEvent.click(getByRole('button', { name: 'Expand sidebar' }));

  const open = queryByRole('button', { name: 'Open menu' });
  if (open) {
    fireEvent.click(open);
    dump('drawer-open', container.innerHTML);
    fireEvent.click(getByRole('button', { name: 'Close menu' }));
  }
});

it('dashboard-home', async () => {
  const element = await DashboardPage();
  const { container } = render(element);
  dump('dashboard-home', container.innerHTML);
});

it('support-queue / my-tickets', async () => {
  mockPathname = '/dashboard/support';
  let r = render(<SupportPage />);
  await waitFor(() => {
    if (!r.container.querySelector('table tbody tr')) throw new Error('table not loaded');
  });
  dump('support-queue', r.container.innerHTML);
  r.unmount();

  mockPathname = '/dashboard/support/my-tickets';
  r = render(<MyTicketsPage />);
  await waitFor(() => {
    if (!r.container.querySelector('table tbody tr')) throw new Error('table not loaded');
  });
  dump('my-tickets', r.container.innerHTML);
  r.unmount();
});

it('ticket-detail', async () => {
  mockPathname = '/dashboard/support/ticket-1';
  const { container, getByText, getByRole } = render(<TicketDetailPage />);
  await waitFor(() => {
    if (!container.querySelector('h1')) throw new Error('detail not loaded');
  });
  await act(async () => {});
  dump('ticket-detail', container.innerHTML);

  // The reply composer starts minimized; open it in Reply mode.
  await act(async () => {
    fireEvent.click(getByText('Click to respond...'));
  });
  await act(async () => {
    fireEvent.click(getByRole('button', { name: 'Reply' }));
  });
  dump('ticket-reply', container.innerHTML);
});

it('user-results / user-profile / user-tables', () => {
  const users = [1, 2, 3].map((i) => ({
    id: `u${i}`,
    first_name: 'Agent',
    last_name: `Number${i}`,
    display_name: null,
    email: LONG_EMAIL,
    avatar_url: null,
    org_name: 'Invented Brokerage Group',
    org_slug: 'invented-brokerage',
    org_role: 'agent',
    status: 'active',
    last_login_at: '2026-10-01T10:00:00Z',
  }));
  let r = render(<UserResultsTable users={users} query="agent" isLoading={false} error={null} />);
  dump('user-results', r.container.innerHTML);
  r.unmount();

  r = render(
    <UserProfileCard
      user={{
        id: 'u1',
        email: LONG_EMAIL,
        display_name: 'Agentwithaverylongfirstname Andaverylonglastname',
        avatar_url: null,
        oauth_provider: 'google',
        status: 'active',
        subscription_tier: 'professional',
        created_at: '2025-01-01T00:00:00Z',
        last_login_at: '2026-10-01T10:00:00Z',
      }}
      canImpersonate
    />
  );
  dump('user-profile', r.container.innerHTML);
  r.unmount();

  r = render(
    <div className="space-y-6">
      <DevicesTable
        userId="u1"
        canManage
        devices={[
          {
            id: 'd1',
            device_name: 'Invented MacBook Pro 16-inch',
            device_id: 'device-0000-1111-2222-3333',
            os: 'macOS 15.1',
            app_version: '2.40.0',
            platform: 'darwin',
            is_active: true,
            last_seen_at: '2026-10-01T10:00:00Z',
            activated_at: '2025-01-01T00:00:00Z',
          },
        ]}
      />
      <AuditLogTable
        entries={[
          {
            id: 'a1',
            action: 'update_license',
            resource_type: 'license',
            resource_id: 'lic-1',
            metadata: { from: 'trial', to: 'active' },
            created_at: '2026-10-01T10:00:00Z',
          },
        ]}
      />
      <BillingCreditsCard
        userId="u1"
        suspension={{ isSuspended: false, event: null, hasError: false }}
        data={{
          creditBalance: 3,
          ledger: [
            {
              id: 'l1',
              entry_type: 'purchase',
              amount: 5,
              reason: 'Purchased a five-unlock bundle',
              unit_price_cents: 1499,
              funding_source: 'purchase',
              stripe_dashboard_url: null,
              stripe_payment_intent_id: 'pi_invented_000000000000',
              created_at: '2026-09-01T10:00:00Z',
            },
          ],
          unlocks: [],
          pricingTiers: [{ id: 't1', min_units: 1, max_units: 10, unit_price_cents: 1499, currency: 'usd' }],
          quote: null,
          lifetimePaidUnlocks: 2,
          grossPaidCents: 7495,
          grantsIssued: 0,
          paidUnlocksThisYear: 2,
          hasErrors: false,
          errorMessages: [],
        }}
      />
    </div>
  );
  dump('user-tables', r.container.innerHTML);
  r.unmount();
});

it('orgs-list / org-detail', async () => {
  const orgs = [1, 2, 3].map((i) => ({
    id: `org-${i}`,
    name: `Invented Brokerage Group Number ${i}`,
    slug: `invented-brokerage-${i}`,
    plan_name: 'Professional',
    plan_tier: 'professional',
    created_at: '2025-01-01T00:00:00Z',
    member_count: 10 + i,
  }));
  let r = render(<OrganizationsTable organizations={orgs} canEdit />);
  dump('orgs-list', r.container.innerHTML);
  r.unmount();

  const element = await OrganizationDetailPage({ params: Promise.resolve({ id: 'org-1' }) });
  r = render(element);
  await act(async () => {});
  dump('org-detail', r.container.innerHTML);
  r.unmount();
});
